import { describe, expect, it } from "vitest";
import { listAllSavedViews, renameSavedView } from "../src/views.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

const row = (over: Record<string, unknown>) => ({
  id: "v1",
  name: "Inbound",
  collection_key: "logistics/shipments",
  view_type: "Board",
  group_by_field: null,
  search_text: null,
  shared: false,
  membership_id: "m1",
  saved_view_filters: [],
  saved_view_sorts: [],
  saved_view_shares: [],
  ...over,
});

describe("saved views across collections", () => {
  it("lists own views first and flags each collection's default", async () => {
    const { db } = fakeClient({
      "from:saved_views": [
        okResponse([
          row({ id: "v2", membership_id: "m9", shared: true, collection_key: "crew" }),
          row({}),
          row({ id: "v3", collection_key: "crew" }),
        ]),
      ],
      "from:saved_view_defaults": [okResponse([{ saved_view_id: "v3" }])],
    });
    const result = await listAllSavedViews(db, { orgId: "o", membershipId: "m1" });
    expect(result.ok && result.data.map((v) => [v.id, v.mine, v.isDefault])).toEqual([
      ["v1", true, false],
      ["v3", true, true],
      ["v2", false, false],
    ]);
  });

  it("returns read errors typed", async () => {
    const one = fakeClient({
      "from:saved_views": [errorResponse("42501", "denied")],
      "from:saved_view_defaults": [okResponse(null)],
    });
    expect((await listAllSavedViews(one.db, { orgId: "o", membershipId: "m" })).ok).toBe(false);
    const two = fakeClient({
      "from:saved_views": [okResponse(null)],
      "from:saved_view_defaults": [errorResponse("500", "boom")],
    });
    expect((await listAllSavedViews(two.db, { orgId: "o", membershipId: "m" })).ok).toBe(false);
  });

  it("renames only a view the person owns", async () => {
    const { db, calls } = fakeClient({
      "from:saved_views": [
        okResponse([{ id: "v1" }]),
        okResponse([]),
        errorResponse("23514", "too long"),
      ],
    });
    expect(await renameSavedView(db, "v1", "  Outbound ")).toEqual({ ok: true, data: null });
    expect(calls[0]?.steps[0]).toEqual(["update", [{ name: "Outbound" }]]);
    expect(await renameSavedView(db, "v1", "x")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect((await renameSavedView(db, "v1", "x")).ok).toBe(false);
  });
});
