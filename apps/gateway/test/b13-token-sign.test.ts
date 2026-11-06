import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B13 (RRR-237, S14.5-01): signing through a link. A quote's refusals have copy under gateway.tokens.refusals,
 * and any other rule raised inside token_sign_document, such as a lifecycle conflict, goes through the outcomes
 * rather than to a key that has no copy.
 */

const state = vi.hoisted(() => ({ sign: null as unknown }));

vi.mock("@xos/data/gateway", () => ({ signTokenDocument: vi.fn(async () => state.sign) }));
vi.mock("@/lib/observability", () => ({ observability: { logger: { error: vi.fn() } } }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: vi.fn(async () => ({})) }));

const { signDocumentTokenAction } = await import("@/lib/actions/tokens");

const input = { token: `xdoc_${"a".repeat(64)}`, accessCode: "123456", signerName: "Cleo Marsh" };
const raised = (rule: string) => ({
  ok: false,
  error: { kind: "refusal", rule, message: rule },
});

beforeEach(() => {
  state.sign = { ok: true, data: { refused: false, signedAt: "2026-11-06T12:00:00Z" } };
});

describe("signDocumentTokenAction", () => {
  it.each(["quote_expired", "quote_not_sent", "quote_client_engagement"])(
    "reads the raised %s as a token refusal, which has copy",
    async (rule) => {
      state.sign = raised(rule);
      expect(await signDocumentTokenAction(input)).toEqual({ ok: false, refusal: rule });
    },
  );

  it("sends a lifecycle conflict through the outcomes", async () => {
    state.sign = raised("lifecycle_conflict");
    expect(await signDocumentTokenAction(input)).toEqual({
      ok: false,
      outcome: "refusals.lifecycle_conflict",
    });
  });

  it("gives an unknown raised rule the generic outcome, never a key without copy", async () => {
    state.sign = raised("something_new");
    expect(await signDocumentTokenAction(input)).toEqual({ ok: false, outcome: "refused" });
  });

  it("returns the signing time", async () => {
    expect(await signDocumentTokenAction(input)).toEqual({
      ok: true,
      data: { signedAt: "2026-11-06T12:00:00Z" },
    });
  });
});
