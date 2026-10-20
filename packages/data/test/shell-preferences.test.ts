import { describe, expect, it } from "vitest";
import {
  getShortcutsEnabled,
  listShortcutBindings,
  listSidebarLayout,
  resetShortcutBindings,
  resetSidebarLayout,
  saveSidebarLayout,
  setShortcutBinding,
} from "../src/shell-preferences.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

const down = () => errorResponse("08000", "down");

describe("shortcut bindings", () => {
  it("lists the person's live bindings in a shell by shortcut id", async () => {
    const { db, calls } = fakeClient({
      "from:shortcut_bindings": [
        okResponse([
          { shortcut_id: "go.home", keys: "G Q" },
          { shortcut_id: "search", keys: null },
        ]),
        down(),
      ],
    });
    expect(await listShortcutBindings(db, "Atlas")).toEqual({
      ok: true,
      data: { "go.home": "G Q", search: null },
    });
    expect(calls[0]?.steps).toContainEqual(["eq", ["shell", "Atlas"]]);
    expect(calls[0]?.steps).toContainEqual(["is", ["deleted_at", null]]);
    expect((await listShortcutBindings(db, "Atlas")).ok).toBe(false);
  });

  it("binds, turns off and resets through the RPCs", async () => {
    const { db, calls } = fakeClient({
      "rpc:set_shortcut_binding": [okResponse("b1"), okResponse("b2"), down()],
      "rpc:reset_shortcut_bindings": [okResponse(1), okResponse(3), down()],
    });
    expect(
      await setShortcutBinding(db, { shell: "Atlas", shortcutId: "go.home", keys: "G Q" }),
    ).toEqual({ ok: true, data: null });
    expect(
      await setShortcutBinding(db, { shell: "Atlas", shortcutId: "search", keys: null }),
    ).toEqual({ ok: true, data: null });
    expect(calls[1]?.steps[0]).toEqual([
      "args",
      [{ p_shell: "Atlas", p_shortcut_id: "search", p_keys: "" }],
    ]);
    expect((await setShortcutBinding(db, { shell: "Atlas", shortcutId: "x", keys: "Q" })).ok).toBe(
      false,
    );
    expect(await resetShortcutBindings(db, { shell: "Atlas", shortcutId: "go.home" })).toEqual({
      ok: true,
      data: 1,
    });
    expect(calls[3]?.steps[0]).toEqual(["args", [{ p_shell: "Atlas", p_shortcut_id: "go.home" }]]);
    expect(await resetShortcutBindings(db, { shell: "Atlas" })).toEqual({ ok: true, data: 3 });
    expect(calls[4]?.steps[0]).toEqual(["args", [{ p_shell: "Atlas" }]]);
    expect((await resetShortcutBindings(db, { shell: "Gateway" })).ok).toBe(false);
  });
});

describe("sidebar layout", () => {
  it("lists, saves and resets the person's layout in an org", async () => {
    const { db, calls } = fakeClient({
      "from:sidebar_item_preferences": [
        okResponse([{ node_id: "finance", sort_order: 0, hidden: true }]),
        down(),
      ],
      "rpc:save_sidebar_layout": [okResponse(2), down()],
      "rpc:reset_sidebar_layout": [okResponse(2), down()],
    });
    expect(await listSidebarLayout(db, "o1")).toEqual({
      ok: true,
      data: [{ nodeId: "finance", sortOrder: 0, hidden: true }],
    });
    expect((await listSidebarLayout(db, "o1")).ok).toBe(false);
    expect(
      await saveSidebarLayout(db, "o1", [
        { nodeId: "group.commercial", hidden: false },
        { nodeId: "show", hidden: true },
      ]),
    ).toEqual({ ok: true, data: 2 });
    expect(calls[2]?.steps[0]).toEqual([
      "args",
      [
        {
          p_org_id: "o1",
          p_items: [
            { node: "group.commercial", hidden: false },
            { node: "show", hidden: true },
          ],
        },
      ],
    ]);
    expect((await saveSidebarLayout(db, "o1", [])).ok).toBe(false);
    expect(await resetSidebarLayout(db, "o1")).toEqual({ ok: true, data: 2 });
    expect((await resetSidebarLayout(db, "o1")).ok).toBe(false);
  });
});

describe("single-key shortcuts setting", () => {
  it("prefers the org's value, then every org's, then on", async () => {
    const { db } = fakeClient({
      "from:personal_setting_values": [
        okResponse([
          { org_id: null, value_boolean: true },
          { org_id: "o1", value_boolean: false },
        ]),
        okResponse([{ org_id: null, value_boolean: false }]),
        okResponse([]),
        down(),
      ],
    });
    expect(await getShortcutsEnabled(db, "o1")).toEqual({ ok: true, data: false });
    expect(await getShortcutsEnabled(db, "o1")).toEqual({ ok: true, data: false });
    expect(await getShortcutsEnabled(db, "o1")).toEqual({ ok: true, data: true });
    expect((await getShortcutsEnabled(db, "o1")).ok).toBe(false);
  });
});
