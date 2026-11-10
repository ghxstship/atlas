import { describe, expect, it, vi } from "vitest";

/**
 * The re-acceptance prompt in the Gateway shell asks only about documents Gateway publishes (ADR 0156): the Mobile EULA is
 * Compass's to ask, and Gateway has no page for it, so an acceptance here would record text the person could not read.
 */
const h = vi.hoisted(() => ({
  pending: [] as unknown[],
  recorded: [] as unknown[],
}));

vi.mock("@xos/data/legal-reacceptance", () => ({
  listPendingReacceptances: async () => ({ ok: true, data: h.pending }),
}));
vi.mock("@xos/data/settings", () => ({
  recordLegalAcceptances: async (_: unknown, input: unknown) => {
    h.recorded.push(input);
    return { ok: true, data: 1 };
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: async () => ({}) }));
vi.mock("@/lib/observability", () => ({ observability: { logger: { error: () => undefined } } }));

const change = (documentSlug: string) => ({
  documentSlug,
  documentVersion: "2.0.0",
  summary: "What changes",
  noticedAt: "2026-11-01T00:00:00Z",
  effectiveOn: "2026-12-01",
  required: false,
});

const form = (slug: string) => {
  const data = new FormData();
  data.set("document", slug);
  data.set("version", "2.0.0");
  return data;
};

describe("re-acceptance in Gateway", () => {
  it("asks about the Worker Terms and not the Mobile EULA", async () => {
    const { askedInGateway } = await import("../lib/auth/legal");
    expect(
      askedInGateway([change("mobile-eula"), change("worker-terms")]).map((c) => c.documentSlug),
    ).toEqual(["worker-terms"]);
  });

  it("records no acceptance of a document it does not publish, even when posted", async () => {
    const { acceptPersonalLegalChangeAction } = await import("../lib/legal/reacceptance-actions");
    h.pending = [change("mobile-eula"), change("worker-terms")];
    h.recorded = [];
    await acceptPersonalLegalChangeAction(form("mobile-eula"));
    expect(h.recorded).toEqual([]);
    await acceptPersonalLegalChangeAction(form("worker-terms"));
    expect(h.recorded).toHaveLength(1);
  });
});
