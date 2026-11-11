/**
 * The api-token Edge Function logic (supabase/functions/api-token/mint.ts): API key exchange for a
 * short-lived JWT acting as the key's service account. Signed with an ES256 key generated per test run, as the
 * project's imported JWT signing key is (ADR 0168).
 */
import { projectTokenSigner } from "@xos/platform/jwt";
import { describe, expect, it } from "vitest";
import {
  TOKEN_TTL_SECONDS,
  exchangeResult,
  handleTokenRequest,
  tokenClaims,
} from "../../../supabase/functions/api-token/mint.ts";
import type { ExchangeResult } from "../../../supabase/functions/api-token/mint.ts";

const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify",
])) as Record<"privateKey" | "publicKey", Awaited<ReturnType<typeof crypto.subtle.importKey>>>;
const KID = "11111111-2222-4333-8444-555555555555";
const sign = projectTokenSigner(
  JSON.stringify({ ...(await crypto.subtle.exportKey("jwk", pair.privateKey)), kid: KID }),
  { production: true },
);
const KEY = `xos_live_${"a".repeat(48)}`;
const ROW = {
  api_key_id: "k1",
  org_id: "33333333-3333-4333-8333-333333333333",
  scopes: ["finance"],
  user_id: "66666666-6666-4666-8666-666666666666",
  service_account_id: "s1",
};

function request(authorization: string | null, method = "POST") {
  return new Request("http://edge/api-token", {
    method,
    headers: authorization === null ? {} : { Authorization: authorization },
  });
}

function deps(result: ExchangeResult) {
  return {
    exchange: async () => result,
    sign,
    issuer: "http://127.0.0.1:56021/auth/v1",
    now: () => 1_800_000_000_000,
  };
}

describe("api-token exchange", () => {
  it("signs an ES256 token naming the key, which verifies with its public key", async () => {
    const res = await handleTokenRequest(request(`Bearer ${KEY}`), deps(ROW));
    const { access_token: token } = (await res.json()) as { access_token: string };
    const [head = "", payload = "", signature = ""] = token.split(".");
    expect(JSON.parse(Buffer.from(head, "base64url").toString())).toEqual({
      alg: "ES256",
      typ: "JWT",
      kid: KID,
    });
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      pair.publicKey,
      Buffer.from(signature, "base64url"),
      new TextEncoder().encode(`${head}.${payload}`),
    );
    expect(valid).toBe(true);
  });

  it("mints a short-lived token for the service account with org and scopes", async () => {
    const res = await handleTokenRequest(request(`Bearer ${KEY}`), deps(ROW));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { access_token: string; expires_in: number; org_id: string };
    expect(body.expires_in).toBe(TOKEN_TTL_SECONDS);
    expect(body.org_id).toBe(ROW.org_id);
    const claims = JSON.parse(
      Buffer.from(body.access_token.split(".")[1] as string, "base64url").toString(),
    ) as Record<string, unknown>;
    expect(claims).toMatchObject({
      sub: ROW.user_id,
      role: "authenticated",
      aud: "authenticated",
      org_id: ROW.org_id,
      scopes: ["finance"],
      xos_api_key_id: "k1",
      iat: 1_800_000_000,
      exp: 1_800_000_000 + TOKEN_TTL_SECONDS,
    });
    expect(tokenClaims(ROW, "iss", 10)["exp"]).toBe(10 + TOKEN_TTL_SECONDS);
  });

  it("exchanges a personal API token (A86) for its person's own sign-in", async () => {
    const token = `xos_pat_${"b".repeat(48)}`;
    const personal = { ...ROW, api_key_id: "t1", service_account_id: null };
    const res = await handleTokenRequest(request(`Bearer ${token}`), deps(personal));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { access_token: string };
    const claims = JSON.parse(
      Buffer.from(body.access_token.split(".")[1] as string, "base64url").toString(),
    ) as Record<string, unknown>;
    expect(claims).toMatchObject({
      sub: ROW.user_id,
      xos_api_key_id: "t1",
      xos_service_account_id: null,
      scopes: ["finance"],
      amr: [{ method: "xos_api_key", timestamp: 1_800_000_000 }],
    });
    expect((await handleTokenRequest(request("Bearer xos_pat_short"), deps(personal))).status).toBe(
      401,
    );
  });

  it("refuses other methods, missing or malformed keys, unknown keys and refused keys", async () => {
    expect((await handleTokenRequest(request(`Bearer ${KEY}`, "GET"), deps(ROW))).status).toBe(405);
    expect((await handleTokenRequest(request(null), deps(ROW))).status).toBe(401);
    expect((await handleTokenRequest(request("Bearer xos_live_short"), deps(ROW))).status).toBe(
      401,
    );
    const unknown = await handleTokenRequest(request(`Bearer ${KEY}`), deps(null));
    expect(unknown.status).toBe(401);
    expect(unknown.headers.get("www-authenticate")).toContain("Bearer");
    const refused = await handleTokenRequest(
      request(`Bearer ${KEY}`),
      deps({ refusal: "api_key_needs_service_account", reason: "Attach it." }),
    );
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({
      refusal: "REFUSE",
      rule: "api_key_needs_service_account",
    });
  });

  it("maps the exchange RPC answer", () => {
    expect(exchangeResult([ROW], null)).toEqual(ROW);
    expect(exchangeResult([], null)).toBeNull();
    expect(exchangeResult(null, null)).toBeNull();
    expect(
      exchangeResult(null, {
        code: "XR001",
        message: "api_key_needs_service_account: Attach it.",
        hint: "api_key_needs_service_account",
      }),
    ).toEqual({ refusal: "api_key_needs_service_account", reason: "Attach it." });
    expect(exchangeResult(null, { code: "XR001", message: "rule_x: Text.", hint: null })).toEqual({
      refusal: "rule_x",
      reason: "Text.",
    });
    expect(() => exchangeResult(null, { code: "42501", message: "denied" })).toThrow(/denied/);
  });
});
