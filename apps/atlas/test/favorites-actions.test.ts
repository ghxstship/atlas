import type * as Settings from "@xos/data/settings";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgContext } from "@/lib/shell/context";

/**
 * A113 (RRR-158, finding A65-024, Section 4.5.2): a move by drag or keyboard in the sidebar saves the order of the
 * person's favorites. The action sends only the caller's own favorites in this org, so even a table without row level
 * security would change nothing else; app.reorder_favorites (migration 2090, pgTAP 2090) runs as the caller besides.
 */
interface Row {
  readonly id: string;
  readonly orgId: string;
  readonly personId: string;
  sortOrder: number;
}

const state = vi.hoisted(() => ({ ctx: null as unknown, rows: [] as Row[], failList: false }));
const data = vi.hoisted(() => ({
  list: vi.fn(async (_db: unknown, input: { orgId: string; personId: string }) =>
    state.failList
      ? { ok: false as const, error: { kind: "unexpected" } }
      : {
          ok: true as const,
          data: state.rows
            .filter((r) => r.orgId === input.orgId && r.personId === input.personId)
            .sort((a, b) => a.sortOrder - b.sortOrder)
            .map((r) => ({ id: r.id, nodeId: "schedule", targetId: null, sortOrder: r.sortOrder })),
        },
  ),
  // The table as if nothing guarded it: every id sent takes its position, whoever it belongs to.
  reorder: vi.fn(async (_db: unknown, input: { orgId: string; favoriteIds: readonly string[] }) => {
    input.favoriteIds.forEach((id, position) => {
      const row = state.rows.find((r) => r.id === id);
      if (row) row.sortOrder = position;
    });
    return { ok: true as const, data: input.favoriteIds.length };
  }),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/shell/context", () => ({ getOrgContext: async () => state.ctx }));
vi.mock("@xos/data/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof Settings>()),
  listFavorites: data.list,
  reorderFavorites: data.reorder,
}));

const { reorderFavoritesAction } = await import("@/lib/settings/favorites-actions");

const id = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, "0")}`;
const [budgets, schedule, work, carols, otherOrg] = [id(1), id(2), id(3), id(4), id(5)];

function contextFor(personId: string | null): OrgContext {
  return {
    org: { id: "org-1", slug: "northwind-live", name: "Northwind Live" },
    viewer: { db: {}, person: personId ? { id: personId } : null },
  } as unknown as OrgContext;
}

const order = (personId: string, orgId = "org-1") =>
  state.rows
    .filter((r) => r.personId === personId && r.orgId === orgId)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((r) => r.id);

describe("reorderFavoritesAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.failList = false;
    state.ctx = contextFor("dave");
    state.rows = [
      { id: budgets, orgId: "org-1", personId: "dave", sortOrder: 0 },
      { id: schedule, orgId: "org-1", personId: "dave", sortOrder: 1 },
      { id: work, orgId: "org-1", personId: "dave", sortOrder: 2 },
      { id: carols, orgId: "org-1", personId: "carol", sortOrder: 0 },
      { id: otherOrg, orgId: "org-2", personId: "dave", sortOrder: 0 },
    ];
  });

  it("changes only the caller's own favorites in this org", async () => {
    expect(
      await reorderFavoritesAction("northwind-live", [work, carols, budgets, otherOrg, schedule]),
    ).toEqual({});
    expect(data.reorder).toHaveBeenCalledWith(expect.anything(), {
      orgId: "org-1",
      favoriteIds: [work, budgets, schedule],
    });
    expect(order("dave")).toEqual([work, budgets, schedule]);
    expect(state.rows.find((r) => r.id === carols)?.sortOrder).toBe(0);
    expect(state.rows.find((r) => r.id === otherOrg)?.sortOrder).toBe(0);
    expect(data.list).toHaveBeenCalledWith(expect.anything(), { orgId: "org-1", personId: "dave" });
  });

  it("sends each favorite once", async () => {
    await reorderFavoritesAction("northwind-live", [schedule, schedule, budgets]);
    expect(data.reorder).toHaveBeenCalledWith(expect.anything(), {
      orgId: "org-1",
      favoriteIds: [schedule, budgets],
    });
  });

  it("refuses without a person or with ids that are not favorites, and reports failed reads and writes", async () => {
    expect(await reorderFavoritesAction("northwind-live", ["finance.budgets"])).toEqual({
      error: "invalid",
    });
    state.ctx = contextFor(null);
    expect(await reorderFavoritesAction("northwind-live", [work])).toEqual({ error: "denied" });
    state.ctx = null;
    expect(await reorderFavoritesAction("another-org", [work])).toEqual({ error: "denied" });
    expect(data.reorder).not.toHaveBeenCalled();

    state.ctx = contextFor("dave");
    state.failList = true;
    expect(await reorderFavoritesAction("northwind-live", [work])).toEqual({ error: "unexpected" });
    state.failList = false;
    data.reorder.mockResolvedValueOnce({ ok: false, error: { kind: "unexpected" } } as never);
    expect(await reorderFavoritesAction("northwind-live", [work])).toEqual({ error: "unexpected" });
    expect(order("dave")).toEqual([budgets, schedule, work]);
  });
});
