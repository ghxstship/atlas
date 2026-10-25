import { describe, expect, it } from "vitest";
import {
  PROVIDERS,
  SCOPE_CATEGORY,
  isProviderCode,
  providersIn,
  scopesFor,
  usesClientCredentials,
} from "../src/framework/catalog.ts";
import { asIntegrationError, errorForStatus, IntegrationError } from "../src/framework/errors.ts";
import { callJson, callRaw, httpFromFetch } from "../src/framework/http.ts";
import {
  clientCredentialSecret,
  contentHash,
  credentialField,
  decimalToMinor,
  integrationBackoffMs,
  minorToDecimal,
  parseCredential,
  sha256Hex,
} from "../src/framework/support.ts";
import { asDbClient, StoreError, unwrap } from "../src/framework/db.ts";
import { connectorRegistry, ItemTally } from "../src/framework/connector.ts";
import { contextFor, memoryStore, scriptedHttp } from "./doubles.ts";

describe("catalog", () => {
  it("lists the 19 Section 17 connectors in numeric order with unique codes", () => {
    expect(PROVIDERS).toHaveLength(19);
    expect(new Set(PROVIDERS.map((p) => p.code)).size).toBe(19);
    const orders = PROVIDERS.map((p) => p.sortOrder);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
  });

  it("gates accounting on upl_export and payroll on payroll_export", () => {
    for (const p of providersIn("Accounting")) expect(p.requiredFeature).toBe("upl_export");
    for (const p of providersIn("Payroll")) expect(p.requiredFeature).toBe("payroll_export");
    expect(providersIn("Calendar").every((p) => p.requiredFeature === null)).toBe(true);
  });

  it("maps scopes to categories like the database", () => {
    expect(scopesFor("xero")).toEqual(["Ledger Export", "Payment Sync"]);
    expect(scopesFor("ticketing_csv")).toEqual(["Attendance Import"]);
    expect(SCOPE_CATEGORY["Tracking Refresh"]).toBe("Shipping");
    expect(isProviderCode("dhl")).toBe(true);
    expect(isProviderCode("myspace")).toBe(false);
    expect(providersIn()).toHaveLength(19);
  });
});

describe("errors", () => {
  it("classifies provider statuses", () => {
    expect(errorForStatus("Xero", 200, "")).toBeNull();
    expect(errorForStatus("Xero", 401, "expired")).toMatchObject({
      code: "credential_refused",
      connectionError: true,
    });
    expect(errorForStatus("Xero", 429, "")).toMatchObject({
      code: "provider_rate_limited",
      retryable: true,
    });
    expect(errorForStatus("Xero", 503, "")).toMatchObject({
      code: "provider_unavailable",
      retryable: true,
    });
    expect(errorForStatus("Xero", 404, "")).toMatchObject({
      code: "provider_not_found",
      retryable: false,
    });
    expect(errorForStatus("Xero", 409, "")).toMatchObject({ code: "provider_conflict" });
    expect(errorForStatus("Xero", 400, "bad")?.message).toBe("Xero returned 400: bad");
    expect(errorForStatus("Xero", 422, "")).toMatchObject({ code: "provider_rejected" });
  });

  it("wraps unknown failures without losing them", () => {
    const network = new TypeError("fetch failed");
    expect(asIntegrationError(network)).toMatchObject({
      code: "provider_unreachable",
      retryable: true,
    });
    expect(asIntegrationError(new Error("boom"))).toMatchObject({
      code: "unexpected_error",
      retryable: false,
    });
    expect(asIntegrationError("odd")).toMatchObject({ code: "unexpected_error", message: "odd" });
    const own = new IntegrationError("Bad Code", "x");
    expect(own.code).toBe("provider_error");
    expect(asIntegrationError(own)).toBe(own);
  });
});

describe("http", () => {
  it("adapts fetch without following redirects and lowercases headers", async () => {
    let seen: RequestInit | undefined;
    const http = httpFromFetch(async (_url, init) => {
      seen = init;
      return new Response("ok", { status: 200, headers: { "X-Thing": "1" } });
    });
    const response = await http({
      method: "POST",
      url: "https://example.com",
      headers: { a: "b" },
      body: "x",
    });
    expect(seen?.redirect).toBe("manual");
    expect(seen?.body).toBe("x");
    expect(response).toEqual({
      status: 200,
      headers: { "content-type": "text/plain;charset=UTF-8", "x-thing": "1" },
      body: "ok",
    });
    const bare = await http({ method: "GET", url: "https://example.com" });
    expect(bare.status).toBe(200);
  });

  it("sends JSON with a bearer token and raises on failure", async () => {
    const { http, requests } = scriptedHttp([
      { match: "POST https://api.example.com/ok", respond: () => ({ json: { id: 7 } }) },
      { match: "GET https://api.example.com/empty", respond: () => ({ status: 204 }) },
      { match: "GET https://api.example.com/html", respond: () => ({ body: "<html>" }) },
      { match: "GET https://api.example.com/gone", respond: () => ({ status: 401, body: "nope" }) },
    ]);
    await expect(
      callJson(http, "Example", {
        method: "POST",
        url: "https://api.example.com/ok",
        token: "t",
        json: { a: 1 },
      }),
    ).resolves.toEqual({ id: 7 });
    expect(requests[0]?.headers).toMatchObject({
      authorization: "Bearer t",
      "content-type": "application/json",
    });
    await expect(
      callJson(http, "Example", { method: "GET", url: "https://api.example.com/empty" }),
    ).resolves.toBeUndefined();
    await expect(
      callJson(http, "Example", { method: "GET", url: "https://api.example.com/html" }),
    ).rejects.toMatchObject({ code: "provider_malformed_response", retryable: true });
    await expect(
      callJson(http, "Example", { method: "GET", url: "https://api.example.com/gone" }),
    ).rejects.toMatchObject({ code: "credential_refused" });
    await expect(
      callRaw(http, "Example", { method: "GET", url: "https://api.example.com/gone" }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      callRaw(http, "Example", { method: "GET", url: "https://api.example.com/empty" }),
    ).resolves.toMatchObject({ status: 204 });
  });
});

describe("support", () => {
  it("parses raw and JSON credentials", () => {
    expect(parseCredential("  key-1 ")).toEqual({ token: "key-1", fields: {} });
    expect(parseCredential('{"access_token":"a","realm_id":"r","n":1}')).toEqual({
      token: "a",
      fields: { access_token: "a", realm_id: "r" },
    });
    expect(parseCredential('{"api_key":"k"}').token).toBe("k");
    // UPS and FedEx store a client-credentials pair, in the form Atlas saves, and mint their token from it.
    expect(PROVIDERS.filter((p) => usesClientCredentials(p.code)).map((p) => p.code)).toEqual([
      "ups",
      "fedex",
    ]);
    for (const provider of ["ups", "fedex"]) {
      expect(parseCredential(clientCredentialSecret("i/+", 's"1'), provider)).toEqual({
        token: "",
        fields: { client_id: "i/+", client_secret: 's"1' },
      });
      expect(() => parseCredential('{"client_id":"i"}', provider)).toThrow(
        expect.objectContaining({
          code: "credential_malformed",
          message: "The stored credential has no client ID and secret.",
        }),
      );
    }
    // Any other provider given a pair fails here, not later with an empty bearer token.
    for (const provider of ["xero", "slack", "dhl", undefined]) {
      expect(() => parseCredential(clientCredentialSecret("i", "s"), provider)).toThrow(
        expect.objectContaining({
          code: "credential_malformed",
          connectionError: true,
          message: "The stored credential has no access token or key.",
        }),
      );
    }
    expect(parseCredential('{"access_token":"a","client_id":"i"}', "xero").token).toBe("a");
    expect(() => parseCredential(null)).toThrow(
      expect.objectContaining({ code: "credential_required", connectionError: true }),
    );
    expect(() => parseCredential("{bad")).toThrow(
      expect.objectContaining({ code: "credential_malformed" }),
    );
    expect(() => parseCredential('{"realm_id":"r"}')).toThrow(
      expect.objectContaining({ code: "credential_malformed" }),
    );
    expect(credentialField(parseCredential('{"token":"t","tenant_id":"x"}'), "tenant_id")).toBe(
      "x",
    );
    expect(() => credentialField({ token: "t", fields: {} }, "tenant_id")).toThrow(
      expect.objectContaining({ code: "credential_incomplete" }),
    );
  });

  it("mirrors the database backoff", () => {
    expect(integrationBackoffMs(1)).toBe(30_000);
    expect(integrationBackoffMs(0)).toBe(30_000);
    expect(integrationBackoffMs(3)).toBe(120_000);
    expect(integrationBackoffMs(9)).toBe(3_600_000);
  });

  it("hashes JSON independent of key order", () => {
    expect(contentHash({ b: 1, a: [1, { d: null, c: "x" }] })).toBe(
      contentHash({ a: [1, { c: "x", d: null }], b: 1 }),
    );
    expect(contentHash({ a: 1, z: undefined })).toBe(contentHash({ a: 1 }));
    expect(contentHash("x")).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("converts minor units without floating point", () => {
    expect(minorToDecimal(12345n, 2)).toBe("123.45");
    expect(minorToDecimal(-5, 2)).toBe("-0.05");
    expect(minorToDecimal(1500, 0)).toBe("1500");
    expect(minorToDecimal(7, 3)).toBe("0.007");
    expect(decimalToMinor("123.45", 2)).toBe(12345n);
    expect(decimalToMinor("-0.5", 2)).toBe(-50n);
    expect(decimalToMinor("10.100", 2)).toBe(1010n);
    expect(decimalToMinor(19.99, 2)).toBe(1999n);
    expect(decimalToMinor("7", 0)).toBe(7n);
    expect(() => decimalToMinor("1.234", 2)).toThrow(
      expect.objectContaining({ code: "amount_precision" }),
    );
    expect(() => decimalToMinor("abc", 2)).toThrow(
      expect.objectContaining({ code: "amount_malformed" }),
    );
  });
});

describe("db helpers", () => {
  it("unwraps data and maps database errors", async () => {
    await expect(unwrap(Promise.resolve({ data: 3, error: null }))).resolves.toBe(3);
    const refused = unwrap(
      Promise.resolve({
        data: null,
        error: { code: "XR001", message: "rule_x: No.", hint: "rule_x" },
      }),
    );
    await expect(refused).rejects.toBeInstanceOf(StoreError);
    await expect(refused).rejects.toMatchObject({ error: { kind: "refusal", rule: "rule_x" } });
    await expect(
      unwrap(Promise.resolve({ data: null, error: { code: "42501", message: "x" } })),
    ).rejects.toMatchObject({
      message: "The row does not exist or is not visible.",
    });
    const client = { rpc: () => null, from: () => null };
    expect(asDbClient(client)).toBe(client);
  });
});

describe("connector support", () => {
  it("tallies items and records each failure", async () => {
    const { store, itemErrors } = memoryStore();
    const { http } = scriptedHttp([]);
    const tally = new ItemTally(contextFor("xero", { http, store }));
    tally.read = 3;
    tally.written = 1;
    tally.skipped = 1;
    await tally.fail("bad_row", "Row 3 is bad.", { localId: "x" });
    expect(tally.counts()).toEqual({ read: 3, written: 1, skipped: 1, failed: 1 });
    expect(itemErrors).toEqual([
      { code: "bad_row", message: "Row 3 is bad.", ref: { localId: "x" } },
    ]);
  });

  it("refuses two connectors for one provider", () => {
    const connector = {
      provider: "xero" as const,
      scopes: [],
      sync: () => Promise.reject(new Error("unused")),
    };
    expect(connectorRegistry([connector]).get("xero")).toBe(connector);
    expect(() => connectorRegistry([connector, connector])).toThrow(
      "Two connectors registered for xero.",
    );
  });
});
