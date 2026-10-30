import { describe, expect, it } from "vitest";
import { articleKeys, shortcutList, shortcutPartial } from "../../src/shortcuts/docs.ts";
import { loadShortcutRegistry } from "../../src/shortcuts/load.ts";
import type { ShortcutRegistry } from "../../src/shortcuts/model.ts";

const registry = loadShortcutRegistry();

const catalog = {
  help: {
    shortcuts: {
      keyNames: { Escape: "Esc", Backspace: "Retroceso" },
      record: { state: "Change the state", trash: "Move to Trash" },
      go: { home: "Go to Home" },
    },
  },
};

/** A registry with one Atlas group whose shortcuts are given. */
function withShortcuts(shortcuts: ShortcutRegistry["shells"]["atlas"]["shortcuts"]) {
  return {
    ...registry,
    shells: {
      ...registry.shells,
      atlas: { ...registry.shells.atlas, shortcuts },
    },
  } satisfies ShortcutRegistry;
}

const base = {
  scope: "record",
  group: "record",
  mac: null,
  fields: false,
  fixed: false,
  go: null,
} as const;

describe("shortcut lists for help articles", () => {
  it("writes keys in the registry form with named keys in the locale's words", () => {
    expect(articleKeys("Mod+Backspace", catalog)).toBe("Mod+Retroceso");
    expect(articleKeys("Escape", catalog)).toBe("Esc");
    expect(articleKeys("G H", catalog)).toBe("G H");
    expect(articleKeys("Shift+E", {})).toBe("Shift+E");
  });

  it("lists a group's shortcuts with default keys, in registry order", () => {
    const list = shortcutList(
      withShortcuts([
        { ...base, id: "record.state", keys: "S", label: "help.shortcuts.record.state" },
        { ...base, id: "record.none", keys: null, label: "help.shortcuts.record.state" },
        {
          ...base,
          id: "record.trash",
          keys: "Mod+Backspace",
          mac: "Mod+Delete",
          label: "help.shortcuts.record.trash",
        },
        { ...base, id: "go.home", group: "go", keys: "G H", label: "help.shortcuts.go.home" },
      ]),
      "atlas",
      "record",
      catalog,
    );
    expect(list).toEqual([
      "- **S**: Change the state",
      "- **Mod+Retroceso** / **Mod+Delete**: Move to Trash",
    ]);
  });

  it("refuses a shortcut without copy", () => {
    expect(() =>
      shortcutList(
        withShortcuts([{ ...base, id: "record.x", keys: "S", label: "help.missing" }]),
        "atlas",
        "record",
        catalog,
      ),
    ).toThrow(/No copy for help.missing/);
  });

  it("renders only shortcut partials for known shells and groups", () => {
    const render = shortcutPartial(
      withShortcuts([
        { ...base, id: "record.state", keys: "S", label: "help.shortcuts.record.state" },
      ]),
      () => catalog,
    );
    expect(render("shortcuts", ["atlas", "record"], "en-US")).toEqual([
      "- **S**: Change the state",
    ]);
    expect(render("other", ["atlas", "record"], "en-US")).toBeNull();
    expect(render("shortcuts", ["compass", "record"], "en-US")).toBeNull();
    expect(render("shortcuts", ["atlas", "nope"], "en-US")).toBeNull();
    expect(render("shortcuts", ["atlas", "record", "extra"], "en-US")).toBeNull();
  });
});
