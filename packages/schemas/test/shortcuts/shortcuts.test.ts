import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { GENERATED_PATH, renderShortcutRegistryModule } from "../../src/shortcuts/generate.ts";
import {
  loadShortcutRegistry,
  parseShortcutRegistry,
  SHORTCUTS_PATH,
} from "../../src/shortcuts/load.ts";
import {
  bindingProblem,
  chordOf,
  displayKeys,
  effectiveBindings,
  isCharacterKey,
  isModifierChord,
  isValidKeys,
  keysClash,
  matchesReserved,
  normalizeKeys,
  parseKeys,
  platformOf,
  registryProblems,
  scopesMeet,
  SHORTCUT_REGISTRY,
  type KeyEventLike,
  type Platform,
  type ShortcutRegistry,
  validBindings,
} from "../../src/shortcuts/index.ts";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const registry = loadShortcutRegistry();

function press(key: string, extra: Partial<KeyEventLike> = {}): KeyEventLike {
  return { key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...extra };
}

/** A minimal registry document with the given Atlas shortcuts, for the loader's refusals. */
function doc(
  shortcuts: Record<string, unknown>[],
  reserved: Record<string, unknown>[] = [{ keys: "Escape", reason: "navigation" }],
): string {
  const shell = {
    scopes: ["global", "list"],
    groups: [{ id: "general", label: "help.shortcuts.groups.general" }],
    shortcuts,
  };
  return stringify({
    version: 1,
    reserved,
    shells: { atlas: shell, gateway: { ...shell, shortcuts: [] } },
  });
}

const s = (id: string, keys: string | undefined, more: Record<string, unknown> = {}) => ({
  id,
  scope: "global",
  group: "general",
  label: "help.shortcuts.command",
  ...(keys === undefined ? {} : { keys }),
  ...more,
});

describe("shortcut registry", () => {
  it("matches the generated module", async () => {
    const target = join(packageRoot, GENERATED_PATH);
    const options = (await resolveConfig(target)) ?? {};
    const expected = await format(renderShortcutRegistryModule(registry), {
      ...options,
      filepath: target,
    });
    expect(readFileSync(target, "utf8")).toBe(expected);
    expect(SHORTCUT_REGISTRY).toEqual(registry);
  });

  it("holds no conflict in any scope, on either platform", () => {
    expect(registryProblems(registry)).toEqual([]);
    expect(readFileSync(SHORTCUTS_PATH, "utf8")).toContain("version: 1");
  });

  it("gives Atlas the shortcuts Section 11.2 names", () => {
    const atlas = new Map(registry.shells.atlas.shortcuts.map((x) => [x.id, x]));
    expect(atlas.get("command-menu")?.keys).toBe("Mod+K");
    expect(atlas.get("help")?.keys).toBe("?");
    expect(atlas.get("create-menu")?.keys).toBe("C");
    expect(atlas.get("go.home")).toMatchObject({ keys: "G H", go: "home" });
    expect(atlas.get("go.inbox")).toMatchObject({ keys: "G I", go: "inbox" });
    expect(atlas.get("go.projects")).toMatchObject({ keys: "G P", go: "projects" });
    expect(atlas.get("list.next")).toMatchObject({ keys: "J", fixed: true, scope: "list" });
    expect(atlas.get("list.select")?.keys).toBe("X");
    expect(registry.shells.gateway.shortcuts.map((x) => x.id)).toEqual([
      "command-menu",
      "help",
      "close",
      "undo",
      "redo",
    ]);
  });

  it("gives the showcaller console a keyboard family and a Stream Deck family (ADR 0131)", () => {
    const atlas = registry.shells.atlas;
    expect(atlas.scopes).toContain("show");
    expect(atlas.groups.map((g) => g.id)).toEqual(expect.arrayContaining(["show", "show-deck"]));
    const keysOf = (group: string) =>
      Object.fromEntries(
        atlas.shortcuts.filter((x) => x.group === group).map((x) => [x.id, x.keys]),
      );
    expect(keysOf("show")).toEqual({
      "show.go": "Space",
      "show.next": "J",
      "show.previous": "K",
      "show.standby": "S",
      "show.jump": "T",
      "show.nudge-later": "]",
      "show.nudge-earlier": "[",
      "show.department": "D",
    });
    expect(keysOf("show-deck")).toEqual({
      "show.deck.go": "F13",
      "show.deck.standby": "F14",
      "show.deck.previous": "F15",
      "show.deck.next": "F16",
      "show.deck.nudge-later": "F17",
      "show.deck.nudge-earlier": "F18",
      "show.deck.jump": "F19",
      "show.deck.department": "F20",
    });
    expect(atlas.shortcuts.find((x) => x.id === "show.go")?.fixed).toBe(true);
    for (const x of atlas.shortcuts.filter((y) => y.scope === "show")) {
      expect(x.scope).toBe("show");
      expect(scopesMeet("show", "list")).toBe(false);
      expect(scopesMeet("show", "inbox")).toBe(false);
    }
  });

  it("refuses defaults that clash where their scopes meet", () => {
    expect(() => parseShortcutRegistry(doc([s("a", "C"), s("b", "C")]))).toThrow(
      /a \(C\) and b \(C\) conflict/,
    );
    // A global shortcut meets every scope; two other scopes never meet.
    expect(() => parseShortcutRegistry(doc([s("a", "X"), s("b", "X", { scope: "list" })]))).toThrow(
      /conflict/,
    );
    expect(() =>
      parseShortcutRegistry(doc([s("a", "X", { scope: "list" }), s("b", "J", { scope: "list" })])),
    ).not.toThrow();
    // G alone would never wait for the H of G H.
    expect(() => parseShortcutRegistry(doc([s("a", "G"), s("b", "G H")]))).toThrow(/conflict/);
    // Ctrl is Mod outside macOS.
    expect(() => parseShortcutRegistry(doc([s("a", "Mod+K"), s("b", "Ctrl+K")]))).toThrow(
      /conflict on other/,
    );
    // A macOS default is checked on macOS.
    expect(() =>
      parseShortcutRegistry(doc([s("a", "Mod+K"), s("b", "Mod+J", { mac: "Mod+K" })])),
    ).toThrow(/conflict on mac/);
  });

  it("refuses broken entries with every problem named", () => {
    const bad = doc(
      [
        s("a", "Mod+T"),
        s("a", "Mod++"),
        s("b", "J", { fields: true }),
        s("c", "Escape"),
        s("d", undefined, { fixed: true }),
        s("e", "Q", { scope: "nowhere", group: "missing", go: "home" }),
        s("f", "Z", { go: "home" }),
        s("g", "Escape", { fixed: true }),
      ],
      [
        { keys: "Mod+T", reason: "browser" },
        { keys: "Escape", reason: "navigation" },
        { keys: "Mod++", reason: "browser" },
      ],
    );
    let message = "";
    try {
      parseShortcutRegistry(bad);
    } catch (error) {
      message = String(error);
    }
    for (const problem of [
      "Reserved keys Mod++ are not in the grammar.",
      "atlas shortcut a is listed twice.",
      "atlas shortcut a keys Mod+T are reserved (browser).",
      "atlas shortcut a keys Mod++ are not in the grammar.",
      "atlas shortcut b works in fields, so its keys J need Mod, Ctrl or Alt.",
      "atlas shortcut c keys Escape are reserved (navigation).",
      "atlas shortcut d is fixed but has no keys.",
      "atlas shortcut e names unknown scope nowhere.",
      "atlas shortcut e names unknown group missing.",
      "atlas shortcut f opens home, which another shortcut opens.",
    ]) {
      expect(message).toContain(problem);
    }
    // A fixed shortcut may document a key of keyboard operation.
    expect(message).not.toContain("shortcut g keys Escape are reserved");
    const noGlobal = {
      ...registry,
      shells: { ...registry.shells, gateway: { ...registry.shells.gateway, scopes: ["list"] } },
    } as ShortcutRegistry;
    expect(registryProblems(noGlobal)).toContain("gateway has no global scope.");
  });
});

describe("key grammar", () => {
  it("parses chords and two-step sequences in canonical order", () => {
    expect(parseKeys("Mod+Shift+K")).toEqual([{ modifiers: ["Mod", "Shift"], key: "K" }]);
    expect(parseKeys("G H")).toHaveLength(2);
    for (const ok of ["?", "/", "Mod+.", "Plus", "F12", "Shift+Enter", "Ctrl+Alt+Delete", "1"]) {
      expect(isValidKeys(ok), ok).toBe(true);
    }
    for (const bad of [
      "",
      "Shift+Mod+K",
      "Mod+Mod+K",
      "Hyper+K",
      "Shift+?",
      "Shift+Plus",
      "Mod+",
      "+",
      "k",
      "G H J",
      "Mod+G H",
      "1 H",
      "Mod+Unknown",
      "x".repeat(41),
    ]) {
      expect(isValidKeys(bad), bad).toBe(false);
    }
    expect(normalizeKeys("nope", "mac")).toBeNull();
  });

  it("reads Ctrl as Mod outside macOS", () => {
    expect(normalizeKeys("Ctrl+K", "other")).toBe("Mod+K");
    expect(normalizeKeys("Ctrl+Alt+Shift+K", "other")).toBe("Mod+Alt+Shift+K");
    expect(normalizeKeys("Ctrl+K", "mac")).toBe("Ctrl+K");
    expect(normalizeKeys("G H", "other")).toBe("G H");
  });

  it("tells modifier chords from keys that type", () => {
    expect(isModifierChord("Mod+K")).toBe(true);
    expect(isModifierChord("Alt+K")).toBe(true);
    expect(isModifierChord("Shift+K")).toBe(false);
    expect(isModifierChord("G H")).toBe(false);
    expect(isModifierChord("nope")).toBe(false);
  });

  it("accepts F13 to F20, which are not reserved, and tells character keys from function keys", () => {
    for (let n = 13; n <= 20; n += 1) {
      const key = `F${n}`;
      expect(isValidKeys(key), key).toBe(true);
      expect(isValidKeys(`Shift+${key}`), key).toBe(true);
      expect(chordOf(press(key), "mac")).toBe(key);
      expect(chordOf(press(key), "other")).toBe(key);
      for (const r of registry.reserved) {
        for (const platform of ["mac", "other"] as const) {
          if (r.platform === undefined || r.platform === platform) {
            expect(matchesReserved(key, r.keys, platform), `${key} ${r.keys}`).toBe(false);
          }
        }
      }
    }
    expect(isValidKeys("F21")).toBe(false);
    expect(isCharacterKey("J")).toBe(true);
    expect(isCharacterKey("Shift+J")).toBe(true);
    expect(isCharacterKey("]")).toBe(true);
    expect(isCharacterKey("G H")).toBe(true);
    expect(isCharacterKey("F13")).toBe(false);
    expect(isCharacterKey("Space")).toBe(false);
    expect(isCharacterKey("Mod+K")).toBe(false);
    expect(isCharacterKey("nope")).toBe(false);
  });

  it("lets a person bind a show key to a function key", () => {
    const current = (platform: Platform) => effectiveBindings(registry.shells.atlas, {}, platform);
    expect(bindingProblem(registry, "atlas", current, "show.deck.go", "Shift+F13")).toBeNull();
    expect(bindingProblem(registry, "atlas", current, "show.next", "F15")).toMatchObject({
      kind: "conflict",
    });
    expect(bindingProblem(registry, "atlas", current, "show.deck.go", "F21")).toEqual({
      kind: "invalid",
    });
    expect(bindingProblem(registry, "atlas", current, "show.deck.go", "F12")).toMatchObject({
      kind: "reserved",
    });
    expect(bindingProblem(registry, "atlas", current, "show.deck.go", "F14")).toMatchObject({
      kind: "conflict",
    });
  });

  it("turns key presses into chords on each platform", () => {
    const cases: [KeyEventLike, Platform, string | null][] = [
      [press("k", { metaKey: true }), "mac", "Mod+K"],
      [press("k", { ctrlKey: true }), "other", "Mod+K"],
      [press("k", { ctrlKey: true }), "mac", "Ctrl+K"],
      [press("k", { metaKey: true }), "other", "Mod+K"],
      [press("k", { metaKey: true, ctrlKey: true }), "other", "Mod+K"],
      [press("K", { shiftKey: true }), "other", "Shift+K"],
      [press("?", { shiftKey: true }), "other", "?"],
      [press("/"), "mac", "/"],
      [press(".", { metaKey: true }), "mac", "Mod+."],
      [press(" "), "other", "Space"],
      [press("+", { shiftKey: true }), "other", "Plus"],
      [press("Esc"), "other", "Escape"],
      [press("Enter", { shiftKey: true }), "mac", "Shift+Enter"],
      [press("∆", { altKey: true, code: "KeyJ" }), "mac", "Alt+J"],
      [press("о", { code: "KeyJ" }), "other", "J"],
      [press("!", { shiftKey: true, code: "Digit1" }), "other", "!"],
      [press("Shift", { shiftKey: true }), "other", null],
      [press("Dead"), "mac", null],
      [press("€", { code: "KeyE" }), "other", "E"],
      [press("é", { code: "Quote" }), "other", null],
    ];
    for (const [event, platform, chord] of cases) {
      expect(chordOf(event, platform), `${event.key} on ${platform}`).toBe(chord);
    }
  });

  it("writes keys for people to read on each platform", () => {
    expect(displayKeys("Mod+K", "mac")).toBe("⌘ K");
    expect(displayKeys("Mod+K", "other")).toBe("Ctrl K");
    expect(displayKeys("Ctrl+Alt+Shift+ArrowUp", "mac")).toBe("⌃ ⌥ ⇧ ↑");
    expect(displayKeys("Ctrl+Alt+K", "other")).toBe("Ctrl Alt K");
    expect(displayKeys("G H", "other")).toBe("G H");
    expect(displayKeys("Escape", "mac")).toBe("Esc");
    expect(displayKeys("not keys", "mac")).toBe("not keys");
  });

  it("detects Apple platforms", () => {
    expect(platformOf({ userAgentData: { platform: "macOS" } })).toBe("mac");
    expect(platformOf({ platform: "iPad" })).toBe("mac");
    expect(platformOf({ userAgent: "Mozilla/5.0 (Windows NT 10.0)" })).toBe("other");
    expect(platformOf({})).toBe("other");
  });

  it("matches reserved keys and modifier patterns", () => {
    expect(matchesReserved("Mod+T", "Mod+T", "mac")).toBe(true);
    expect(matchesReserved("Ctrl+T", "Mod+T", "other")).toBe(true);
    expect(matchesReserved("Ctrl+T", "Mod+T", "mac")).toBe(false);
    expect(matchesReserved("G Insert", "Insert", "other")).toBe(true);
    expect(matchesReserved("G I", "Insert", "other")).toBe(false);
    expect(matchesReserved("Ctrl+Alt+K", "Ctrl+Alt+*", "mac")).toBe(true);
    expect(matchesReserved("Ctrl+Alt+Shift+K", "Ctrl+Alt+*", "mac")).toBe(true);
    expect(matchesReserved("Mod+Alt+K", "Ctrl+Alt+*", "mac")).toBe(false);
    expect(matchesReserved("Ctrl+Alt+K", "Mod+Alt+*", "other")).toBe(true);
    expect(matchesReserved("nope", "Mod+T", "mac")).toBe(false);
    expect(matchesReserved("Mod+K", "Bad+*", "mac")).toBe(false);
    expect(matchesReserved("Mod+K", "Bad", "mac")).toBe(false);
  });

  it("clashes on equal keys and on a sequence's first step", () => {
    expect(keysClash("G", "G H", "mac")).toBe(true);
    expect(keysClash("G H", "G", "mac")).toBe(true);
    expect(keysClash("G H", "G I", "mac")).toBe(false);
    expect(keysClash("H", "G H", "mac")).toBe(false);
    expect(keysClash("nope", "G", "mac")).toBe(false);
    expect(scopesMeet("list", "inbox")).toBe(false);
    expect(scopesMeet("global", "inbox")).toBe(true);
  });
});

describe("personal bindings", () => {
  const atlas = registry.shells.atlas;
  const current =
    (custom: Record<string, string | null> = {}) =>
    (platform: Platform) =>
      effectiveBindings(atlas, custom, platform);
  const problem = (id: string, keys: string, custom: Record<string, string | null> = {}) =>
    bindingProblem(registry, "atlas", current(custom), id, keys);

  it("override defaults, unbind with null, and leave fixed keys alone", () => {
    const keys = effectiveBindings(
      atlas,
      { "go.home": "G Q", "go.places": "G N", search: null, "list.next": "N", gone: "Z" },
      "other",
    );
    expect(keys.get("go.home")).toBe("G Q");
    expect(keys.get("go.places")).toBe("G N");
    expect(keys.get("search")).toBeNull();
    expect(keys.get("list.next")).toBe("J");
    expect(keys.has("gone")).toBe(false);
    expect(keys.get("go.safety")).toBeNull();
  });

  it("keep only stored bindings the registry still accepts", () => {
    expect(
      validBindings(registry, "atlas", {
        // Moving Go to Work frees G W for Go to Assets, whichever is stored first.
        "go.assets": "G W",
        "go.work": "G X",
        search: null,
        "list.next": "N",
        gone: "Z",
        "go.safety": "Mod+T",
        "go.places": "C",
        "go.canon": "G Z",
        "go.credentials": "G Z",
      }),
    ).toEqual({ "go.assets": "G W", "go.work": "G X", search: null });
  });

  it("refuse unknown, fixed, malformed and typing-unsafe bindings", () => {
    expect(problem("nope", "Q")).toEqual({ kind: "unknown" });
    expect(problem("list.next", "N")).toEqual({ kind: "fixed" });
    expect(problem("go.home", "Mod++")).toEqual({ kind: "invalid" });
    expect(problem("command-menu", "Q")).toEqual({ kind: "typing" });
  });

  it("refuse browser, screen reader and keyboard operation keys on any platform", () => {
    expect(problem("go.safety", "Mod+W")).toEqual({ kind: "reserved", reason: "browser" });
    expect(problem("go.safety", "Insert")).toEqual({ kind: "reserved", reason: "screen-reader" });
    // Fine on macOS, but Control and Alt elsewhere belong to screen readers and AltGr.
    expect(problem("go.safety", "Mod+Alt+S")).toEqual({
      kind: "reserved",
      reason: "screen-reader",
    });
    expect(problem("go.safety", "Ctrl+Alt+S")).toEqual({
      kind: "reserved",
      reason: "screen-reader",
    });
    expect(problem("go.safety", "Tab")).toEqual({ kind: "reserved", reason: "navigation" });
  });

  it("refuse keys another shortcut holds where the scopes meet", () => {
    expect(problem("go.safety", "C")).toEqual({ kind: "conflict", with: "create-menu" });
    expect(problem("go.safety", "G")).toEqual({ kind: "conflict", with: "go.home" });
    expect(problem("go.safety", "G H")).toEqual({ kind: "conflict", with: "go.home" });
    // Global keys may not shadow a list key, but two other scopes never meet.
    expect(problem("go.safety", "X")).toEqual({ kind: "conflict", with: "list.select" });
    expect(problem("inbox.done", "X")).toBeNull();
    expect(problem("inbox.done", "A")).toEqual({ kind: "conflict", with: "inbox.approve" });
    // The person's own bindings count, and moving one frees its old keys.
    expect(problem("go.safety", "G Z", { "go.places": "G Z" })).toEqual({
      kind: "conflict",
      with: "go.places",
    });
    expect(problem("go.safety", "G H", { "go.home": "G Q" })).toBeNull();
    expect(problem("go.safety", "Shift+S")).toBeNull();
    expect(problem("aurora", "Mod+Shift+A")).toBeNull();
  });
});
