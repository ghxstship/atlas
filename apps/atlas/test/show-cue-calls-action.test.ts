import type * as Show from "@xos/data/show";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgContext } from "@/lib/shell/context";

/**
 * P2 (ADR 0131, G-78): the inline cue editor's department calls go through saveCueCallsAction. A call past
 * 2000 characters, or a department the catalog does not know, comes back as the work.errors.cueCall key without
 * reaching the database, and a refusal from app.save_cue_calls comes back under its rule, so the editor stays
 * open with what the person typed and says why (acceptance 11; the journey p2-show-calling covers the page).
 */
const data = vi.hoisted(() => ({
  save: vi.fn(async (): Promise<{ ok: true; data: null } | { ok: false; error: unknown }> => ({
    ok: true,
    data: null,
  })),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/shell/context", () => ({
  getOrgContext: async () =>
    ({
      org: { id: "org-1", slug: "northwind-live", name: "Northwind Live" },
      viewer: { db: {}, person: { id: "dave" } },
    }) as unknown as OrgContext,
}));
vi.mock("@xos/data/show", async (importOriginal) => ({
  ...(await importOriginal<typeof Show>()),
  saveCueCalls: data.save,
}));

const { saveCueCallsAction } = await import("@/components/show/actions");

const cue = "0192f3a0-0000-7000-8000-000000000001";

describe("saveCueCallsAction", () => {
  beforeEach(() => vi.clearAllMocks());

  it("saves the changed calls", async () => {
    const result = await saveCueCallsAction("northwind-live", cue, {
      Lighting: "LX 14 GO",
      Audio: null,
    });
    expect(result).toEqual({ ok: true, data: null });
    expect(data.save).toHaveBeenCalledWith({}, cue, { Lighting: "LX 14 GO", Audio: null });
  });

  it("refuses a call past 2000 characters before the database", async () => {
    const result = await saveCueCallsAction("northwind-live", cue, { Video: "x".repeat(2001) });
    expect(result).toEqual({ ok: false, error: { key: "cueCall" } });
    expect(data.save).not.toHaveBeenCalled();
  });

  it("refuses an unknown department and a malformed cue id", async () => {
    expect(await saveCueCallsAction("northwind-live", cue, { Pyro: "Go" })).toEqual({
      ok: false,
      error: { key: "cueCall" },
    });
    expect(await saveCueCallsAction("northwind-live", "cue-1", { Lighting: "Go" })).toEqual({
      ok: false,
      error: { key: "cueCall" },
    });
    expect(data.save).not.toHaveBeenCalled();
  });

  it("returns the database's refusal under its rule", async () => {
    data.save.mockResolvedValueOnce({
      ok: false,
      error: {
        kind: "refusal",
        rule: "cue_call_kind",
        message: "A call goes to Audio, Lighting, Video, Special Effects or Stage.",
      },
    });
    const result = await saveCueCallsAction("northwind-live", cue, { Stage: "Doors" });
    expect(result).toEqual({ ok: false, error: { key: "rules.cue_call_kind" } });
  });
});
