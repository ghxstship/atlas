import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * An export of a list narrowed by Add filter (A117, ADR 0076): the export worker cannot apply `cf.` and `f.`
 * conditions, so the action refuses such an export before it reads anything, rather than writing a file with the
 * rows the list hides.
 */

const state = vi.hoisted(() => ({ contexts: 0 }));

vi.mock("@/lib/shell/context", () => ({
  getOrgContext: async () => {
    state.contexts += 1;
    return null;
  },
}));

const { requestCollectionExportAction } = await import("@/lib/views/export-actions");

describe("exports of a list narrowed by Add filter", () => {
  beforeEach(() => {
    state.contexts = 0;
  });

  it("refuses a custom field or declared field condition before reading anything", async () => {
    for (const search of [
      "cf.union_local.contains=iatse",
      "view=table&f.vendor=Acme",
      "cf.seats.gte=100",
    ]) {
      expect(
        await requestCollectionExportAction("acme", {
          pathname: "/acme/vendors/directory",
          search,
          format: "CSV",
        }),
      ).toEqual({ ok: false, error: "conditions" });
    }
    expect(state.contexts).toBe(0);
  });

  it("goes on to the org for a list without one, or with an empty one", async () => {
    for (const search of ["view=table&q=acme", "cf.union_local="]) {
      expect(
        await requestCollectionExportAction("acme", {
          pathname: "/acme/vendors/directory",
          search,
          format: "CSV",
        }),
      ).toEqual({ ok: false, error: "denied" });
    }
    expect(state.contexts).toBe(2);
  });
});
