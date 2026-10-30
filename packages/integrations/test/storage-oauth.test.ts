import { describe, expect, it } from "vitest";
import { IntegrationError } from "../src/framework/errors.ts";
import type { HttpClient, HttpRequest } from "../src/framework/http.ts";
import type { SyncContext } from "../src/framework/connector.ts";
import {
  googleDriveProvider,
  oneDriveProvider,
  withFreshToken,
} from "../src/connectors/storage/index.ts";
import {
  authorizeUrl,
  credentialJson,
  exchangeCode,
  fetchAccount,
  freshAccessToken,
  needsRefresh,
  oauthClientFromEnv,
  readOAuthCredential,
  refreshCredential,
} from "../src/connectors/storage/oauth.ts";

/** B16 (ADR 0155 D5, migration 3053): Google Drive and OneDrive sign in with authorization code, PKCE and refresh. */

const NOW = new Date("2026-10-30T12:00:00Z");
const CLIENT = { clientId: "client-123", clientSecret: "top-secret-value" };

function http(answers: { status: number; body: unknown }[]) {
  const requests: HttpRequest[] = [];
  const client: HttpClient = async (request) => {
    requests.push(request);
    const next = answers.shift() ?? { status: 500, body: "" };
    return {
      status: next.status,
      headers: {},
      body: typeof next.body === "string" ? next.body : JSON.stringify(next.body),
    };
  };
  return { client, requests };
}

describe("authorization URLs", () => {
  it("asks Google for drive.readonly, offline, with consent and PKCE S256", () => {
    const url = new URL(
      authorizeUrl(
        "google_drive",
        "cid",
        "https://atlas.test/oauth/integrations/callback",
        "st",
        "ch",
      ),
    );
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "cid",
      redirect_uri: "https://atlas.test/oauth/integrations/callback",
      response_type: "code",
      scope: "https://www.googleapis.com/auth/drive.readonly",
      access_type: "offline",
      prompt: "consent",
      state: "st",
      code_challenge: "ch",
      code_challenge_method: "S256",
    });
  });

  it("asks Microsoft's common tenant for offline_access Files.Read.All User.Read", () => {
    const url = new URL(
      authorizeUrl("onedrive_sharepoint", "cid", "https://atlas.test/cb", "st", "ch"),
    );
    expect(url.origin + url.pathname).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    );
    expect(url.searchParams.get("scope")).toBe("offline_access Files.Read.All User.Read");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("reads each provider's client pair from the environment, or none", () => {
    expect(
      oauthClientFromEnv("google_drive", {
        XOS_GOOGLE_STORAGE_CLIENT_ID: "a",
        XOS_GOOGLE_STORAGE_CLIENT_SECRET: "b",
      }),
    ).toEqual({ clientId: "a", clientSecret: "b" });
    expect(
      oauthClientFromEnv("onedrive_sharepoint", { XOS_MICROSOFT_STORAGE_CLIENT_ID: "a" }),
    ).toBeNull();
  });
});

describe("tokens", () => {
  it("exchanges the code with the verifier and keeps the expiry inside the credential", async () => {
    const h = http([
      {
        status: 200,
        body: { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, scope: "s" },
      },
    ]);
    const credential = await exchangeCode(h.client, "google_drive", {
      ...CLIENT,
      code: "code-xyz",
      redirectUri: "https://atlas.test/cb",
      verifier: "verifier-abc",
      now: NOW,
    });
    expect(credential).toEqual({
      access_token: "at-1",
      refresh_token: "rt-1",
      expires_at: "2026-10-30T13:00:00.000Z",
      scope: "s",
    });
    const form = new URLSearchParams(String(h.requests[0]?.body));
    expect(Object.fromEntries(form)).toEqual({
      grant_type: "authorization_code",
      client_id: "client-123",
      client_secret: "top-secret-value",
      code: "code-xyz",
      redirect_uri: "https://atlas.test/cb",
      code_verifier: "verifier-abc",
    });
    expect(JSON.parse(credentialJson(credential))).toEqual(credential);
  });

  it("refuses a grant without a refresh token", async () => {
    const h = http([{ status: 200, body: { access_token: "at-1", expires_in: 3600 } }]);
    await expect(
      exchangeCode(h.client, "google_drive", {
        ...CLIENT,
        code: "c",
        redirectUri: "r",
        verifier: "v",
      }),
    ).rejects.toMatchObject({ code: "oauth_refresh_token_missing" });
  });

  it("refreshes, keeping the refresh token unless the provider rotates it", async () => {
    const old = {
      access_token: "at-1",
      refresh_token: "rt-1",
      expires_at: NOW.toISOString(),
      scope: "s",
    };
    const kept = await refreshCredential(
      http([{ status: 200, body: { access_token: "at-2", expires_in: 60 } }]).client,
      "google_drive",
      CLIENT,
      old,
      NOW,
    );
    expect(kept).toMatchObject({ access_token: "at-2", refresh_token: "rt-1" });
    const h = http([
      { status: 200, body: { access_token: "at-3", refresh_token: "rt-2", expires_in: 60 } },
    ]);
    const rotated = await refreshCredential(h.client, "onedrive_sharepoint", CLIENT, old, NOW);
    expect(rotated.refresh_token).toBe("rt-2");
    expect(new URLSearchParams(String(h.requests[0]?.body)).get("scope")).toBe(
      "offline_access Files.Read.All User.Read",
    );
  });

  it("turns invalid_grant into credential_revoked with the reconnect copy", async () => {
    const error = await refreshCredential(
      http([{ status: 400, body: { error: "invalid_grant", error_description: "Token expired" } }])
        .client,
      "google_drive",
      CLIENT,
      { access_token: "a", refresh_token: "r", expires_at: NOW.toISOString(), scope: "" },
      NOW,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IntegrationError);
    expect(error).toMatchObject({ code: "credential_revoked", connectionError: true });
    expect((error as Error).message).toMatch(/^Reconnect Google Drive/);
  });

  it("cuts the client secret, the code and tokens from every error", async () => {
    const error = await exchangeCode(
      http([
        {
          status: 400,
          body: {
            error: "invalid_request",
            error_description: "bad top-secret-value and code-xyz and verifier-abc",
          },
        },
      ]).client,
      "onedrive_sharepoint",
      { ...CLIENT, code: "code-xyz", redirectUri: "r", verifier: "verifier-abc" },
    ).then(
      () => new Error("expected a refusal"),
      (e: unknown) => e as Error,
    );
    expect(error.message).not.toMatch(/top-secret-value|code-xyz|verifier-abc/);
    expect(error.message).toMatch(/\[redacted\]/);
  });
});

describe("the refreshing helper", () => {
  const stored: string[] = [];
  const store = async (json: string) => {
    stored.push(json);
  };

  it("uses a fresh token as it is and refreshes one within 5 minutes of expiry, storing the rotation first", async () => {
    const fresh = credentialJson({
      access_token: "at-1",
      refresh_token: "rt-1",
      expires_at: "2026-10-30T12:10:00Z",
      scope: "",
    });
    expect(await freshAccessToken(http([]).client, "google_drive", CLIENT, fresh, store, NOW)).toBe(
      "at-1",
    );
    const due = credentialJson({
      access_token: "at-1",
      refresh_token: "rt-1",
      expires_at: "2026-10-30T12:04:00Z",
      scope: "",
    });
    const read = readOAuthCredential(due);
    if (read === null) throw new Error("expected an OAuth credential");
    expect(needsRefresh(read, NOW)).toBe(true);
    expect(readOAuthCredential("pasted")).toBeNull();
    expect(readOAuthCredential("{not json")).toBeNull();
    const h = http([
      { status: 200, body: { access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 } },
    ]);
    expect(await freshAccessToken(h.client, "google_drive", CLIENT, due, store, NOW)).toBe("at-2");
    expect(JSON.parse(stored.at(-1) ?? "{}")).toMatchObject({
      access_token: "at-2",
      refresh_token: "rt-2",
    });
    expect(
      await freshAccessToken(http([]).client, "google_drive", CLIENT, " pasted-token ", store, NOW),
    ).toBe("pasted-token");
    await expect(
      freshAccessToken(http([]).client, "google_drive", null, due, store, NOW),
    ).rejects.toMatchObject({
      code: "oauth_not_configured",
    });
  });

  it("renews a sync run's token before the connector reads", async () => {
    const h = http([{ status: 200, body: { access_token: "at-9", expires_in: 3600 } }]);
    const saved: unknown[] = [];
    const context = {
      connection: { id: "conn-1", providerCode: "google_drive", settings: {} },
      credential: {
        token: "at-1",
        fields: { refresh_token: "rt-1", expires_at: "2026-10-30T11:00:00Z" },
      },
      http: h.client,
      now: () => NOW,
    } as unknown as SyncContext;
    const renewed = await withFreshToken(
      context,
      { storeCredential: async (...a) => void saved.push(a) },
      {
        google_drive: CLIENT,
      },
    );
    expect(renewed.credential?.token).toBe("at-9");
    expect(saved[0]).toEqual(["conn-1", expect.stringContaining('"access_token":"at-9"')]);
    const pasted = { ...context, credential: { token: "t", fields: {} } } as unknown as SyncContext;
    expect(await withFreshToken(pasted, { storeCredential: async () => undefined }, {})).toBe(
      pasted,
    );
  });
});

describe("the signed-in account and the linking folder", () => {
  it("reads Google's account from Drive's about, and Microsoft's from Graph with the drive", async () => {
    const g = http([
      { status: 200, body: { user: { emailAddress: "crew@northwind.test", permissionId: "p1" } } },
    ]);
    expect(await fetchAccount(g.client, "google_drive", "at")).toEqual({
      id: "p1",
      name: "crew@northwind.test",
      driveId: null,
    });
    expect(g.requests[0]?.url).toContain(
      "/drive/v3/about?fields=user(emailAddress,displayName,permissionId)",
    );
    const m = http([
      { status: 200, body: { id: "u1", mail: null, userPrincipalName: "crew@northwind.test" } },
      { status: 200, body: { id: "drive-1" } },
    ]);
    expect(await fetchAccount(m.client, "onedrive_sharepoint", "at")).toEqual({
      id: "u1",
      name: "crew@northwind.test",
      driveId: "drive-1",
    });
  });

  it("walks parents to tell whether a file lies inside the linking folder", async () => {
    const ctx = (client: HttpClient) =>
      ({
        http: client,
        credential: { token: "t", fields: {} },
        connection: { settings: { drive_id: "d" } },
      }) as unknown as SyncContext;
    const inside = http([
      { status: 200, body: { parents: ["sub"] } },
      { status: 200, body: { parents: ["root-folder"] } },
    ]);
    expect(await googleDriveProvider.inFolder?.(ctx(inside.client), "file-1", "root-folder")).toBe(
      true,
    );
    const outside = http([
      { status: 200, body: { parents: ["mine"] } },
      { status: 200, body: {} },
    ]);
    expect(await googleDriveProvider.inFolder?.(ctx(outside.client), "file-1", "root-folder")).toBe(
      false,
    );
    const graph = http([{ status: 200, body: { id: "i1", parentReference: { id: "root-item" } } }]);
    expect(await oneDriveProvider.inFolder?.(ctx(graph.client), "d/i1", "d/root-item")).toBe(true);
    expect(await oneDriveProvider.inFolder?.(ctx(http([]).client), "other/i1", "d/root-item")).toBe(
      false,
    );
  });
});
