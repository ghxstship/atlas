import { readFileSync } from "node:fs";
import { SHORTCUT_REGISTRY } from "@xos/schemas/shortcuts";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installLetterKeys, PENDING_MS, type LetterState } from "../components/shell/letter-keys";
import { buildGatewayKeys, type GatewayKeys } from "../lib/shell/shell-keys";

/**
 * Gateway's shortcuts come from the registry (packages/schemas/shortcuts.yaml): the help panel's sheet
 * reads it. Gateway's frame answers search, help, Esc, undo and redo itself (`?` for help, Mod+K for
 * the command menu, Mod+Z and Mod+Shift+Z for undo and redo), so a change to these defaults must change
 * the frame too; the letter keys reach the frame from the server (lib/shell/shell-keys.ts), so they
 * follow the registry by construction.
 */
describe("Gateway shortcuts", () => {
  it("are the keys the frame answers", () => {
    const defaults = Object.fromEntries(
      SHORTCUT_REGISTRY.shells.gateway.shortcuts.map((s) => [s.id, s.keys]),
    );
    expect(defaults).toMatchObject({
      "command-menu": "Mod+K",
      help: "?",
      close: "Escape",
      undo: "Mod+Z",
      redo: "Mod+Shift+Z",
    });
    const frame = readFileSync(
      new URL("../components/shell/gateway-frame.tsx", import.meta.url),
      "utf8",
    );
    expect(frame).toContain('event.key === "?"');
    expect(frame).toContain('event.key.toLowerCase() === "k"');
    expect(frame).toContain('event.key.toLowerCase() === "z"');
    expect(frame).toContain("event.shiftKey ? undoStack.redo() : undoStack.undo()");
    // Every other default is a letter or G then a letter, which the frame's letter handler answers.
    const own = new Set(["command-menu", "help", "close", "undo", "redo"]);
    for (const s of SHORTCUT_REGISTRY.shells.gateway.shortcuts) {
      if (own.has(s.id)) continue;
      expect(s.keys, s.id).toMatch(s.go === null ? /^[A-Z]$/ : /^[A-Z] [A-Z]$/);
    }
  });

  it("go only where the person's navigation goes, and offer Switch org only where it exists", () => {
    const hrefs = new Map([
      ["home", "/home"],
      ["work", "/work"],
      ["settings", "/settings"],
    ]);
    const keys = buildGatewayKeys(SHORTCUT_REGISTRY, hrefs, new Set(["account"]));
    expect(keys.go).toEqual({ "G H": "/home", "G W": "/work", "G T": "/settings" });
    expect(keys.commands).toEqual({ A: "account" });
    expect(keys.shown).toEqual([
      "command-menu",
      "help",
      "account",
      "go.home",
      "go.work",
      "go.settings",
      "close",
      "undo",
      "redo",
    ]);
    const platform = buildGatewayKeys(SHORTCUT_REGISTRY, hrefs, new Set(["account", "switch-org"]));
    expect(platform.commands).toEqual({ A: "account", O: "switch-org" });
    expect(platform.shown).toContain("switch-org");
  });
});

// The letter handler -----------------------------------------------------------------------------

class FakeElement {
  constructor(
    readonly tagName = "DIV",
    /** Inside a dialog or menu. */
    readonly overlay = false,
  ) {}
  readonly isContentEditable = false;
  closest(selector: string) {
    return selector.includes("dialog") && this.overlay ? this : null;
  }
}

interface PressInit {
  readonly shiftKey?: boolean;
  readonly metaKey?: boolean;
  readonly repeat?: boolean;
  readonly handled?: boolean;
  readonly target?: FakeElement;
}

describe("Gateway letter handler (Section 11.2)", () => {
  let window: EventTarget;
  let stop: () => void;
  let calls: string[];

  beforeAll(() => {
    vi.useFakeTimers();
    Object.assign(globalThis, { HTMLElement: FakeElement, Element: FakeElement });
  });
  afterEach(() => stop?.());

  const keys: GatewayKeys = buildGatewayKeys(
    SHORTCUT_REGISTRY,
    new Map([
      ["home", "/home"],
      ["work", "/work"],
      ["settings", "/settings"],
    ]),
    new Set(["account", "switch-org"]),
  );

  function start() {
    window = new EventTarget();
    Object.assign(globalThis, { window });
    calls = [];
    const state: { current: LetterState } = {
      current: {
        keys,
        go: (href) => calls.push(`go:${href}`),
        command: (id) => calls.push(`command:${id}`),
      },
    };
    stop = installLetterKeys(state);
  }

  /** Presses a key and says whether the handler took it (preventDefault). */
  function press(key: string, init: PressInit = {}): boolean {
    const event = new Event("keydown", { cancelable: true });
    Object.defineProperties(event, {
      key: { value: key },
      metaKey: { value: init.metaKey ?? false },
      ctrlKey: { value: false },
      altKey: { value: false },
      shiftKey: { value: init.shiftKey ?? false },
      repeat: { value: init.repeat ?? false },
      isComposing: { value: false },
      target: { value: init.target ?? new FakeElement() },
    });
    if (init.handled) event.preventDefault();
    window.dispatchEvent(event);
    return !init.handled && event.defaultPrevented;
  }

  it("goes to a destination with G then a letter, and runs A and O", () => {
    start();
    expect(press("g")).toBe(true);
    expect(press("h")).toBe(true);
    press("g");
    press("T");
    expect(press("a")).toBe(true);
    press("o");
    expect(calls).toEqual(["go:/home", "go:/settings", "command:account", "command:switch-org"]);
  });

  it("cancels a sequence on a key that completes none, and after four seconds", () => {
    start();
    press("g");
    expect(press("q")).toBe(false);
    press("g");
    vi.advanceTimersByTime(PENDING_MS);
    expect(press("h")).toBe(false);
    // The key that ended a sequence is not a command of its own.
    press("g");
    press("a");
    expect(calls).toEqual([]);
  });

  it("stays quiet while typing, in dialogs and menus, and for keys a component handled", () => {
    start();
    press("a", { target: new FakeElement("INPUT") });
    press("g", { target: new FakeElement("TEXTAREA") });
    press("h");
    press("a", { target: new FakeElement("BUTTON", true) });
    press("a", { handled: true });
    press("a", { repeat: true });
    press("a", { shiftKey: true });
    press("a", { metaKey: true });
    expect(calls).toEqual([]);
    // A sequence started outside a field ends quietly when its second key lands in one.
    press("g");
    press("h", { target: new FakeElement("INPUT") });
    expect(calls).toEqual([]);
  });

  it("stays off while me.shortcuts_enabled is off", () => {
    // The shell applies me.shortcuts_enabled = false as data-shortcuts="off" on the document root.
    Object.assign(globalThis, { document: { documentElement: { dataset: { shortcuts: "off" } } } });
    start();
    press("a");
    press("g");
    press("h");
    expect(calls).toEqual([]);
    Object.assign(globalThis, { document: undefined });
  });

  it("offers Switch org only where the page has it", () => {
    start();
    stop();
    window = new EventTarget();
    Object.assign(globalThis, { window });
    const state: { current: LetterState } = {
      current: {
        keys: buildGatewayKeys(SHORTCUT_REGISTRY, new Map(), new Set(["account"])),
        go: (href) => calls.push(`go:${href}`),
        command: (id) => calls.push(`command:${id}`),
      },
    };
    stop = installLetterKeys(state);
    expect(press("o")).toBe(false);
    press("g");
    press("h");
    expect(calls).toEqual([]);
  });
});
