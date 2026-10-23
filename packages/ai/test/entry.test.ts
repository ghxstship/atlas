import { describe, expect, it } from "vitest";
import { createAuroraClient, TIMEOUT_RULE, type AuroraStatusResult } from "../src/client.ts";
import { ENTRY_TIMEOUT_MS, featureAvailability, problemKind } from "../src/entry.ts";
import { AI_FEATURES } from "../src/model.ts";

/**
 * The A95 entry point helpers (finding A65-020): each surface tells a refusal, a timeout and a used
 * allowance apart the same way, and the client gives up after the entry point's wait.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const status = (over: Partial<AuroraStatusResult> = {}): AuroraStatusResult => ({
  enabled_features: ["drafting"],
  used: 3,
  allowance: 500,
  plan_includes_aurora: true,
  ...over,
});

describe("feature availability", () => {
  it("is ready only when the plan includes Aurora, the switch is on and allowance remains", () => {
    expect(featureAvailability(status(), "drafting")).toEqual({
      kind: "ready",
      used: 3,
      allowance: 500,
    });
    expect(featureAvailability(status({ plan_includes_aurora: false }), "drafting")).toEqual({
      kind: "not-in-plan",
    });
    expect(featureAvailability(status(), "summaries")).toEqual({ kind: "off" });
    expect(featureAvailability(status({ used: 500 }), "drafting")).toEqual({
      kind: "limit-reached",
      allowance: 500,
    });
    expect(featureAvailability(status({ used: 9000, allowance: null }), "drafting")).toMatchObject({
      kind: "ready",
      allowance: null,
    });
  });
});

describe("problem kinds", () => {
  it("names every failure an entry point explains", () => {
    const p = (statusCode: number, rule: string | null) => ({
      status: statusCode,
      rule,
      detail: "x",
    });
    expect(problemKind(p(0, TIMEOUT_RULE))).toBe("timeout");
    expect(problemKind(p(0, null))).toBe("offline");
    expect(problemKind(p(422, "plan_limit_exceeded"))).toBe("quota");
    expect(problemKind(p(422, "aurora_not_in_plan"))).toBe("not-in-plan");
    expect(problemKind(p(422, "aurora_feature_off"))).toBe("off");
    expect(problemKind(p(422, "aurora_not_configured"))).toBe("not-configured");
    expect(problemKind(p(403, null))).toBe("forbidden");
    expect(problemKind(p(401, null))).toBe("forbidden");
    expect(problemKind(p(422, "scan_intake_resolved"))).toBe("refused");
    expect(problemKind(p(409, null))).toBe("refused");
    expect(problemKind(p(500, null))).toBe("unexpected");
  });

  it("waits longest for extraction and has a wait for every feature", () => {
    expect(Object.keys(ENTRY_TIMEOUT_MS).sort()).toEqual([...AI_FEATURES].sort());
    expect(ENTRY_TIMEOUT_MS.extraction).toBeGreaterThan(ENTRY_TIMEOUT_MS.plain_language);
  });
});

describe("client calls the entry points add", () => {
  it("posts code bindings and previews to their operations", async () => {
    const seen: { url: string; body: unknown }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen.push({ url, body: JSON.parse(String(init.body)) });
      return json({ records: [], vocabulary_terms: 0 });
    }) as unknown as typeof fetch;
    const client = createAuroraClient({ baseUrl: "/api/v1", fetch: fetchFn });
    await client.bindCode({
      code: "0012345678905",
      description: null,
      candidates: [
        { element_id: "9000.02.03-NWL-0001", name: "LED Wall Panel", urid: "9000.02.03" },
      ],
    });
    expect(
      await client.preview({ feature: "drafting", items: [{ collection: "sops", id: "s1" }] }),
    ).toEqual({ ok: true, data: { records: [], vocabulary_terms: 0 } });
    expect(seen.map((s) => s.url)).toEqual(["/api/v1/aurora/bind-code", "/api/v1/aurora/preview"]);
    expect(seen[1]?.body).toEqual({
      feature: "drafting",
      items: [{ collection: "sops", id: "s1" }],
    });
  });

  it("gives up after timeoutMs with the timeout rule, and never on a quick answer", async () => {
    const hanging = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    const slow = createAuroraClient({ baseUrl: "", fetch: hanging, timeoutMs: 20 });
    expect(await slow.draft({ kind: "sop", instructions: "Load-in." })).toEqual({
      ok: false,
      problem: { status: 0, rule: TIMEOUT_RULE, detail: "No answer within 0 seconds." },
    });

    const quick = createAuroraClient({
      baseUrl: "",
      fetch: (async () => json({ enabled_features: [] })) as unknown as typeof fetch,
      timeoutMs: 5_000,
    });
    expect(await quick.status()).toEqual({ ok: true, data: { enabled_features: [] } });
  });

  it("reports a body that stops arriving after the headers as a timeout", async () => {
    const stalls = (async (_url: string, init: RequestInit) =>
      ({
        ok: true,
        status: 200,
        json: () =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
      }) as unknown as Response) as unknown as typeof fetch;
    const client = createAuroraClient({ baseUrl: "", fetch: stalls, timeoutMs: 20 });
    expect(await client.status()).toMatchObject({ ok: false, problem: { rule: TIMEOUT_RULE } });
  });

  it("keeps an ordinary network failure apart from a timeout", async () => {
    const offline = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const client = createAuroraClient({ baseUrl: "", fetch: offline, timeoutMs: 5_000 });
    expect(await client.status()).toEqual({
      ok: false,
      problem: { status: 0, rule: null, detail: "Failed to fetch" },
    });
  });
});
