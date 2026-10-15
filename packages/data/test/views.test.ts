import { describe, expect, it } from "vitest";
import {
  clearDefaultSavedView,
  createSavedView,
  deleteSavedView,
  listSavedViews,
  listTeams,
  myMembershipId,
  setDefaultSavedView,
  shareSavedView,
  updateSavedView,
} from "../src/views.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

const row = (over: Record<string, unknown>) => ({
  id: "v1",
  name: "Inbound",
  collection_key: "logistics/shipments",
  view_type: "Board",
  group_by_field: null,
  search_text: "inbound",
  shared: false,
  membership_id: "m1",
  saved_view_filters: [
    { field: "project", operator: "eq", value_text: "NWL", deleted_at: null },
    { field: "old", operator: "eq", value_text: "x", deleted_at: "2026-01-01" },
  ],
  saved_view_sorts: [
    { field: "b", direction: "Descending", position: 2, deleted_at: null },
    { field: "a", direction: "Ascending", position: 1, deleted_at: null },
  ],
  saved_view_shares: [
    { team_id: "t1", deleted_at: null },
    { team_id: "t2", deleted_at: "2026-01-01" },
  ],
  ...over,
});

describe("saved views", () => {
  it("finds the person's membership", async () => {
    const { db } = fakeClient({
      "from:memberships": [
        okResponse({ id: "m1" }),
        okResponse(null),
        errorResponse("500", "boom"),
      ],
    });
    expect(await myMembershipId(db, { orgId: "o", personId: "p" })).toEqual({
      ok: true,
      data: "m1",
    });
    expect(await myMembershipId(db, { orgId: "o", personId: "p" })).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect((await myMembershipId(db, { orgId: "o", personId: "p" })).ok).toBe(false);
  });

  it("lists own views first and flags the default", async () => {
    const { db } = fakeClient({
      "from:saved_views": [
        okResponse([row({ id: "v2", membership_id: "m9", shared: true }), row({})]),
      ],
      "from:saved_view_defaults": [okResponse({ saved_view_id: "v2" })],
    });
    const result = await listSavedViews(db, {
      orgId: "o",
      membershipId: "m1",
      collectionKey: "logistics/shipments",
    });
    if (!result.ok) throw new Error("expected views");
    expect(result.data.map((v) => [v.id, v.mine, v.isDefault])).toEqual([
      ["v1", true, false],
      ["v2", false, true],
    ]);
    expect(result.data[0]?.filters).toEqual([{ field: "project", operator: "eq", value: "NWL" }]);
    expect(result.data[0]?.sorts.map((s) => s.field)).toEqual(["a", "b"]);
    expect(result.data[0]?.teamIds).toEqual(["t1"]);
  });

  it("returns read errors typed", async () => {
    const one = fakeClient({
      "from:saved_views": [errorResponse("42501", "denied")],
      "from:saved_view_defaults": [okResponse(null)],
    });
    expect(
      (await listSavedViews(one.db, { orgId: "o", membershipId: "m", collectionKey: "c" })).ok,
    ).toBe(false);
    const two = fakeClient({
      "from:saved_views": [okResponse(null)],
      "from:saved_view_defaults": [errorResponse("500", "boom")],
    });
    expect(
      (await listSavedViews(two.db, { orgId: "o", membershipId: "m", collectionKey: "c" })).ok,
    ).toBe(false);
  });

  it("creates a view with its filters and sorts", async () => {
    const { db, calls } = fakeClient({
      "from:saved_views": [okResponse({ id: "v1" })],
      "from:saved_view_filters": [okResponse(null), okResponse(null)],
      "from:saved_view_sorts": [okResponse(null), okResponse(null)],
    });
    const result = await createSavedView(db, {
      orgId: "o",
      membershipId: "m1",
      collectionKey: "logistics/shipments",
      name: "  Inbound  ",
      viewType: "Board",
      searchText: "inbound",
      filters: [{ field: "project", operator: "eq", value: "NWL" }],
      sorts: [{ field: "name", direction: "Ascending" }],
    });
    expect(result).toEqual({ ok: true, data: "v1" });
    const insert = calls[0]?.steps.find(([s]) => s === "insert")?.[1][0] as Record<string, unknown>;
    expect(insert["name"]).toBe("Inbound");
    const sortInsert = calls[4]?.steps.find(([s]) => s === "insert")?.[1][0] as Record<
      string,
      unknown
    >[];
    expect(sortInsert[0]?.["position"]).toBe(1);
  });

  it("stops at the first failed write", async () => {
    const refused = fakeClient({
      "from:saved_views": [errorResponse("23514", "check")],
    });
    expect(
      (
        await createSavedView(refused.db, {
          orgId: "o",
          membershipId: "m",
          collectionKey: "c",
          name: "A",
          viewType: "List",
        })
      ).ok,
    ).toBe(false);
    const filters = fakeClient({
      "from:saved_views": [okResponse({ id: "v1" })],
      "from:saved_view_filters": [errorResponse("42501", "denied")],
    });
    expect(
      (
        await createSavedView(filters.db, {
          orgId: "o",
          membershipId: "m",
          collectionKey: "c",
          name: "A",
          viewType: "List",
        })
      ).ok,
    ).toBe(false);
    const sorts = fakeClient({
      "from:saved_views": [okResponse({ id: "v1" })],
      "from:saved_view_filters": [okResponse(null)],
      "from:saved_view_sorts": [errorResponse("42501", "denied")],
    });
    expect(
      (
        await createSavedView(sorts.db, {
          orgId: "o",
          membershipId: "m",
          collectionKey: "c",
          name: "A",
          viewType: "List",
        })
      ).ok,
    ).toBe(false);
    const filterInsert = fakeClient({
      "from:saved_views": [okResponse({ id: "v1" })],
      "from:saved_view_filters": [okResponse(null), errorResponse("23514", "check")],
      "from:saved_view_sorts": [okResponse(null)],
    });
    expect(
      (
        await createSavedView(filterInsert.db, {
          orgId: "o",
          membershipId: "m",
          collectionKey: "c",
          name: "A",
          viewType: "List",
          filters: [{ field: "a", operator: "eq", value: "1" }],
        })
      ).ok,
    ).toBe(false);
    const sortInsert = fakeClient({
      "from:saved_views": [okResponse({ id: "v1" })],
      "from:saved_view_filters": [okResponse(null)],
      "from:saved_view_sorts": [okResponse(null), errorResponse("23514", "check")],
    });
    expect(
      (
        await createSavedView(sortInsert.db, {
          orgId: "o",
          membershipId: "m",
          collectionKey: "c",
          name: "A",
          viewType: "List",
          sorts: [{ field: "a", direction: "Ascending" }],
        })
      ).ok,
    ).toBe(false);
  });

  it("updates and deletes only visible views", async () => {
    const { db } = fakeClient({
      "from:saved_views": [
        okResponse([{ id: "v1" }]),
        okResponse([]),
        errorResponse("42501", "no"),
        okResponse([{ id: "v1" }]),
        okResponse([]),
        errorResponse("500", "x"),
      ],
      "from:saved_view_filters": [okResponse(null)],
      "from:saved_view_sorts": [okResponse(null)],
    });
    expect((await updateSavedView(db, "v1", { orgId: "o", name: "B", viewType: "Table" })).ok).toBe(
      true,
    );
    expect(await updateSavedView(db, "v1", { orgId: "o", name: "B", viewType: "Table" })).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect((await updateSavedView(db, "v1", { orgId: "o", name: "B", viewType: "Table" })).ok).toBe(
      false,
    );
    expect((await deleteSavedView(db, "v1")).ok).toBe(true);
    expect((await deleteSavedView(db, "v1")).ok).toBe(false);
    expect((await deleteSavedView(db, "v1")).ok).toBe(false);
  });

  it("shares with the org and replaces team shares", async () => {
    const { db, calls } = fakeClient({
      "from:saved_views": [okResponse([{ id: "v1" }])],
      "from:saved_view_shares": [
        okResponse([
          { id: "s1", team_id: "t1" },
          { id: "s2", team_id: "t2" },
        ]),
        okResponse(null),
        okResponse(null),
      ],
    });
    expect(
      (await shareSavedView(db, "v1", { orgId: "o", org: true, teamIds: ["t2", "t3"] })).ok,
    ).toBe(true);
    expect(calls[2]?.steps.find(([s]) => s === "in")?.[1]).toEqual(["id", ["s1"]]);
    expect(calls[3]?.steps.find(([s]) => s === "insert")?.[1][0]).toEqual([
      { org_id: "o", saved_view_id: "v1", team_id: "t3" },
    ]);
  });

  it("returns share failures", async () => {
    const hidden = fakeClient({ "from:saved_views": [okResponse([])] });
    expect(
      (await shareSavedView(hidden.db, "v1", { orgId: "o", org: false, teamIds: [] })).ok,
    ).toBe(false);
    const denied = fakeClient({ "from:saved_views": [errorResponse("42501", "no")] });
    expect(
      (await shareSavedView(denied.db, "v1", { orgId: "o", org: false, teamIds: [] })).ok,
    ).toBe(false);
    const read = fakeClient({
      "from:saved_views": [okResponse([{ id: "v1" }])],
      "from:saved_view_shares": [errorResponse("500", "x")],
    });
    expect((await shareSavedView(read.db, "v1", { orgId: "o", org: false, teamIds: [] })).ok).toBe(
      false,
    );
    const remove = fakeClient({
      "from:saved_views": [okResponse([{ id: "v1" }])],
      "from:saved_view_shares": [
        okResponse([{ id: "s1", team_id: "t1" }]),
        errorResponse("500", "x"),
      ],
    });
    expect(
      (await shareSavedView(remove.db, "v1", { orgId: "o", org: false, teamIds: [] })).ok,
    ).toBe(false);
    const add = fakeClient({
      "from:saved_views": [okResponse([{ id: "v1" }])],
      "from:saved_view_shares": [
        okResponse([]),
        errorResponse(
          "XR001",
          "saved_view_share_team_removed: gone",
          "saved_view_share_team_removed",
        ),
      ],
    });
    const result = await shareSavedView(add.db, "v1", { orgId: "o", org: false, teamIds: ["t9"] });
    expect(result.ok ? null : result.error.kind).toBe("refusal");
  });

  it("sets and clears defaults and lists teams", async () => {
    const { db } = fakeClient({
      "rpc:set_saved_view_default": [
        okResponse("d1"),
        errorResponse(
          "XR001",
          "saved_view_default_collection: no",
          "saved_view_default_collection",
        ),
      ],
      "from:saved_view_defaults": [okResponse(null), errorResponse("500", "x")],
      "from:teams": [okResponse([{ id: "t1", name: "Production" }]), errorResponse("500", "x")],
    });
    expect((await setDefaultSavedView(db, "v1")).ok).toBe(true);
    expect((await setDefaultSavedView(db, "v1")).ok).toBe(false);
    expect((await clearDefaultSavedView(db, { membershipId: "m", collectionKey: "c" })).ok).toBe(
      true,
    );
    expect((await clearDefaultSavedView(db, { membershipId: "m", collectionKey: "c" })).ok).toBe(
      false,
    );
    expect(await listTeams(db, "o")).toEqual({
      ok: true,
      data: [{ id: "t1", name: "Production" }],
    });
    expect((await listTeams(db, "o")).ok).toBe(false);
  });
});
