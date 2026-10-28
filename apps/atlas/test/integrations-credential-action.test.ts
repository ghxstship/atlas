import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseCredential } from "@xos/integrations";
import type { OrgContext } from "@/lib/shell/context";

/**
 * Settings > Integrations stores a connection's credential through storeIntegrationCredentialAction (A19, A105).
 * UPS and FedEx connections send their developer app's client ID and secret, which the action stores as the JSON
 * the shipping connector mints access tokens from (ADR 0065); every other provider keeps the pasted secret and its
 * kind. The connection's provider, read with the viewer's client, picks the form. The real repository functions run
 * against a fake client, so what reaches app.store_integration_credential is checked as the connector reads it.
 */
const state = vi.hoisted(() => ({ ctx: null as unknown }));

vi.mock("next-intl/server", () => ({
  getTranslations: async () => Object.assign((key: string) => key, { has: () => false }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/shell/context", () => ({ getOrgContext: async () => state.ctx }));

const { storeIntegrationCredentialAction } =
  await import("@/components/settings/contributions/a19-actions");

const CONNECTIONS: Record<string, string> = {
  "00000000-0000-4000-8000-000000000001": "ups",
  "00000000-0000-4000-8000-000000000002": "fedex",
  "00000000-0000-4000-8000-000000000003": "xero",
  "00000000-0000-4000-8000-000000000004": "dhl",
};
const idOf = (provider: string) =>
  Object.keys(CONNECTIONS).find((id) => CONNECTIONS[id] === provider) as string;
const HIDDEN = "00000000-0000-4000-8000-0000000000ff";

const rpc = vi.fn<
  (fn: string, args?: Record<string, unknown>) => Promise<{ data: null; error: null }>
>(async () => ({ data: null, error: null }));

/** integration_connections as the viewer sees it under row level security: one row by id, or none. */
function from(relation: string) {
  expect(relation).toBe("integration_connections");
  let id = "";
  const query = {
    select: () => query,
    eq: (_column: string, value: string) => {
      id = value;
      return query;
    },
    maybeSingle: async () => {
      const provider = CONNECTIONS[id];
      return {
        data: provider === undefined ? null : { id, provider_code: provider },
        error: null,
      };
    },
  };
  return query;
}

const ctx = {
  org: { id: "org-1", slug: "northwind-live", name: "Northwind Live" },
  capabilities: new Set(["org.integrations.manage"]),
  viewer: { db: { rpc, from }, person: { id: "person-1" } },
} as unknown as OrgContext;

function post(values: Record<string, string>): FormData {
  const data = new FormData();
  data.set("org", "northwind-live");
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

/** The arguments of the one store_integration_credential call, or undefined when nothing was stored. */
function stored(): Record<string, unknown> | undefined {
  const calls = rpc.mock.calls.filter(([fn]) => fn === "store_integration_credential");
  expect(calls.length).toBeLessThanOrEqual(1);
  return calls[0]?.[1];
}

describe("storeIntegrationCredentialAction", () => {
  beforeEach(() => {
    state.ctx = ctx;
    rpc.mockClear();
  });

  it.each(["ups", "fedex"])(
    "stores a %s client ID and secret, trimmed, as the pair the connector reads",
    async (provider) => {
      const result = await storeIntegrationCredentialAction(
        {},
        post({
          connectionId: idOf(provider),
          clientId: "  cid-123 ",
          clientSecret: ' s3c/r+t="1 ',
        }),
      );
      expect(result).toEqual({ ok: true });
      const args = stored();
      expect(args).toMatchObject({
        p_connection_id: idOf(provider),
        p_kind: "API Key",
        p_expires_at: null,
      });
      expect(parseCredential(args?.["p_secret"] as string, provider)).toEqual({
        token: "",
        fields: { client_id: "cid-123", client_secret: 's3c/r+t="1' },
      });
    },
  );

  it("asks for both values when the client ID or secret is blank, and stores nothing", async () => {
    for (const values of [
      { clientId: "   ", clientSecret: "secret" },
      { clientId: "cid-123", clientSecret: "  " },
    ]) {
      const result = await storeIntegrationCredentialAction(
        {},
        post({ connectionId: idOf("ups"), ...values }),
      );
      expect(result).toEqual({ error: "integrations.errors.clientCredentialsIncomplete" });
    }
    expect(stored()).toBeUndefined();
  });

  it("keeps the pasted secret and its kind for other providers", async () => {
    const result = await storeIntegrationCredentialAction(
      {},
      post({ connectionId: idOf("xero"), secret: "  oauth-token-1 \n", kind: "OAuth Token" }),
    );
    expect(result).toEqual({ ok: true });
    expect(stored()).toEqual({
      p_connection_id: idOf("xero"),
      p_secret: "oauth-token-1",
      p_kind: "OAuth Token",
      p_expires_at: null,
    });

    rpc.mockClear();
    await storeIntegrationCredentialAction(
      {},
      post({ connectionId: idOf("dhl"), secret: "dhl-key", kind: "API Key" }),
    );
    expect(stored()).toMatchObject({ p_secret: "dhl-key", p_kind: "API Key" });
  });

  it("picks the form from the connection's provider, not from the posted fields", async () => {
    // A client pair posted for an OAuth connection, and a pasted token posted for UPS, are both refused.
    const pairForXero = await storeIntegrationCredentialAction(
      {},
      post({ connectionId: idOf("xero"), clientId: "cid-123", clientSecret: "secret" }),
    );
    const tokenForUps = await storeIntegrationCredentialAction(
      {},
      post({ connectionId: idOf("ups"), secret: "bearer-token", kind: "OAuth Token" }),
    );
    expect(pairForXero).toEqual({ error: "integrations.errors.invalid" });
    expect(tokenForUps).toEqual({ error: "integrations.errors.invalid" });
    expect(stored()).toBeUndefined();
  });

  it("stores nothing for a connection the viewer cannot see or a malformed id", async () => {
    const hidden = await storeIntegrationCredentialAction(
      {},
      post({ connectionId: HIDDEN, clientId: "cid-123", clientSecret: "secret" }),
    );
    const malformed = await storeIntegrationCredentialAction(
      {},
      post({ connectionId: "conn-1", clientId: "cid-123", clientSecret: "secret" }),
    );
    expect(hidden).toEqual({ error: "integrations.errors.denied" });
    expect(malformed).toEqual({ error: "integrations.errors.invalid" });
    expect(stored()).toBeUndefined();
  });
});
