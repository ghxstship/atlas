import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getMessages } from "@xos/i18n";
import { getNode, routeParams, type ATLAS_ROLES } from "@xos/ia";
import { allCapabilities, grantsByRole, loadCapabilityRegistry } from "@xos/schemas/capabilities";
import { SHORTCUT_REGISTRY } from "@xos/schemas/shortcuts";
import { sitemap } from "../ia/sitemap.generated";
import { installShellKeys, type KeyState } from "../components/shell/key-dispatch";
import { CREATE_KINDS, createItems } from "../lib/shell/create-menu";
import { orderForPage, type CreateItem } from "../lib/shell/create-order";
import { buildShellNav, orderByLayout, sidebarNodeIds } from "../lib/shell/nav-model";
import { buildShellKeys, goHints, type ShellKeys } from "../lib/shell/shell-keys";

type Role = (typeof ATLAS_ROLES)[number];

function flatten(value: unknown, prefix = "", out = new Map<string, string>()) {
  if (typeof value === "string") out.set(prefix, value);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}
const catalogs = { "en-US": flatten(getMessages("en-US")), "es-US": flatten(getMessages("es-US")) };
const capabilities = loadCapabilityRegistry();
const byRole = grantsByRole(capabilities);
const t = (key: string) => key;
const atlas = SHORTCUT_REGISTRY.shells.atlas;

function goTargets(role: Role, disabledModules: string[] = []) {
  const nav = buildShellNav(sitemap, {
    nav: { role, conditions: ["desktop"], disabledModules },
    role,
    params: { org: "acme" },
    t,
  });
  const links = [...nav.top, ...nav.pinned, ...nav.groups.flatMap((g) => g.items), ...nav.footer];
  return new Map(links.map((l) => [l.id, { href: l.href, label: l.label }]));
}

describe("shortcut registry against Atlas (Section 3.15)", () => {
  it("opens only routed sitemap sections with its navigation shortcuts", () => {
    for (const s of atlas.shortcuts.filter((x) => x.go !== null)) {
      const { node } = getNode(sitemap, s.go as string);
      expect(node.route, s.id).toBeDefined();
      expect(routeParams(node.route as string), s.id).toEqual(["org"]);
    }
  });

  it("labels every shortcut and sheet group in every shipped locale", () => {
    const keys = [
      ...SHORTCUT_REGISTRY.shells.atlas.shortcuts.map((s) => s.label),
      ...SHORTCUT_REGISTRY.shells.atlas.groups.map((g) => g.label),
      ...SHORTCUT_REGISTRY.shells.gateway.shortcuts.map((s) => s.label),
      ...SHORTCUT_REGISTRY.shells.gateway.groups.map((g) => g.label),
    ];
    for (const [locale, catalog] of Object.entries(catalogs)) {
      expect(
        keys.filter((k) => !catalog.has(k)),
        locale,
      ).toEqual([]);
    }
  });
});

describe("shell keys for one person", () => {
  const targets = goTargets("owner");
  const build = (custom = {}, platform: "mac" | "other" = "other") =>
    buildShellKeys(SHORTCUT_REGISTRY, { platform, custom, goTargets: targets });

  it("answers the registry defaults, with G then a letter for the sections the person may open", () => {
    const keys = build();
    expect(keys.global["command-menu"]).toBe("Mod+K");
    expect(keys.global["create-menu"]).toBe("C");
    expect(keys.global["go.home"]).toBe("G H");
    expect(keys.go["go.home"]).toEqual({
      node: "home",
      href: "/acme/home",
      label: targets.get("home")?.label,
    });
    expect(keys.go["go.projects"]?.href).toBe("/acme/projects");
    expect(keys.fields).toEqual(expect.arrayContaining(["command-menu", "focus-mode", "aurora"]));
    expect(keys.fields).not.toContain("create-menu");
    // Escape belongs to dialogs; list and Inbox keys answer only in their regions.
    expect(keys.global).not.toHaveProperty("close");
    expect(keys.global).not.toHaveProperty("list.next");
    expect(keys.scoped["inbox.approve"]).toBe("A");
    expect(keys.scoped["list.next"]).toBe("J");
    // A section without default keys has no shortcut until the person binds one.
    expect(keys.global).not.toHaveProperty("go.safety");
    expect(goHints(keys)["finance"]).toBe("G F");
  });

  it("writes keys for the person's platform", () => {
    expect(build({}, "mac").display["command-menu"]).toBe("⌘ K");
    expect(build({}, "other").display["command-menu"]).toBe("Ctrl K");
    expect(build({}, "other").display["close"]).toBe("Esc");
  });

  it("applies the person's bindings and drops any the registry now refuses", () => {
    const keys = build({
      "go.safety": "G Z",
      "go.home": "Ctrl+Shift+H",
      "go.assets": "C",
      search: null,
    });
    expect(keys.global["go.safety"]).toBe("G Z");
    // Ctrl is Mod outside macOS, so the key handler matches the chord as it sees it.
    expect(keys.global["go.home"]).toBe("Mod+Shift+H");
    expect(keys.global).not.toHaveProperty("go.assets");
    expect(keys.global).not.toHaveProperty("search");
    expect(keys.display["go.home"]).toBe("Ctrl Shift H");
  });

  it("leaves out sections the role cannot see or the org turned off", () => {
    const viewer = buildShellKeys(SHORTCUT_REGISTRY, {
      platform: "other",
      custom: {},
      goTargets: goTargets("viewer", ["logistics"]),
    });
    expect(viewer.go).not.toHaveProperty("go.finance");
    expect(viewer.go).not.toHaveProperty("go.logistics");
    expect(viewer.go).toHaveProperty("go.home");
  });
});

describe("Create menu (Section 4.10)", () => {
  const codes = new Set(allCapabilities(capabilities).map((c) => c.code));

  it("names an org-level page, a registered capability and a label in every locale for each kind", () => {
    expect(new Set(CREATE_KINDS.map((k) => k.id)).size).toBe(CREATE_KINDS.length);
    for (const kind of CREATE_KINDS) {
      const { node } = getNode(sitemap, kind.node);
      expect(routeParams(node.route as string), kind.id).toEqual(["org"]);
      expect(codes.has(kind.capability), kind.capability).toBe(true);
      for (const catalog of Object.values(catalogs)) {
        expect(catalog.has(`shell.create.kinds.${kind.id}`), kind.id).toBe(true);
      }
    }
  });

  it("offers only what the person may create and open", () => {
    const items = (role: Role, disabledModules: string[] = []) =>
      createItems(sitemap, {
        nav: { role, conditions: ["desktop"], disabledModules },
        capabilities: new Set(byRole[role].keys()),
        params: { org: "acme" },
        t,
      }).map((i) => i.id);
    expect(items("owner")).toEqual(CREATE_KINDS.map((k) => k.id));
    expect(items("viewer")).toEqual([]);
    expect(items("owner", ["finance"])).not.toContain("budget");
    expect(items("collaborator")).not.toContain("invoice");
    const project = createItems(sitemap, {
      nav: { role: "owner", conditions: ["desktop"] },
      capabilities: new Set(["projects.project.create"]),
      params: { org: "acme" },
      t,
    });
    expect(project).toEqual([
      {
        id: "project",
        label: "shell.create.kinds.project",
        icon: "FolderKanban",
        page: "/acme/projects/all",
      },
    ]);
  });

  it("puts the kind this page creates first, then its module, then the rest", () => {
    const item = (id: string, page: string): CreateItem => ({ id, label: id, icon: "Plus", page });
    const all = [
      item("project", "/acme/projects/all"),
      item("budget", "/acme/finance/budgets"),
      item("invoice", "/acme/finance/invoices"),
      item("vendor", "/acme/vendors/directory"),
    ];
    const onInvoices = orderForPage(all, "/acme/finance/invoices");
    expect(onInvoices.here.map((i) => i.id)).toEqual(["invoice", "budget"]);
    expect(onInvoices.rest.map((i) => i.id)).toEqual(["project", "vendor"]);
    expect(orderForPage(all, "/acme/home").here).toEqual([]);
  });
});

describe("sidebar layout (Section 4.5.2)", () => {
  const build = (layout: { nodeId: string; sortOrder: number; hidden: boolean }[]) =>
    buildShellNav(sitemap, {
      nav: { role: "owner", conditions: ["desktop"] },
      role: "owner",
      params: { org: "acme" },
      t,
      layout,
    });

  it("puts groups and items in the person's order and leaves hidden items out", () => {
    const nav = build([
      { nodeId: "group.commercial", sortOrder: 0, hidden: false },
      { nodeId: "group.production", sortOrder: 1, hidden: false },
      { nodeId: "advancing", sortOrder: 2, hidden: false },
      { nodeId: "show", sortOrder: 3, hidden: true },
    ]);
    expect(nav.groups.map((g) => g.id).slice(0, 3)).toEqual([
      "group.commercial",
      "group.production",
      "group.operations",
    ]);
    expect(nav.groups[1]?.items.map((i) => i.id)).toEqual(["advancing", "schedule", "work"]);
    // Hidden from the sidebar only: the command menu still opens the page.
    expect(nav.commands.flatMap((g) => g.items).some((i) => i.href === "/acme/show")).toBe(true);
  });

  it("drops a group whose items are all hidden, and keeps the role default without a layout", () => {
    const people = ["people", "opportunities", "crew"].map((nodeId, i) => ({
      nodeId,
      sortOrder: i,
      hidden: true,
    }));
    expect(build(people).groups.map((g) => g.id)).not.toContain("group.people");
    expect(build([]).groups.map((g) => g.id)).toEqual([
      "group.production",
      "group.operations",
      "group.people",
      "group.commercial",
      "group.knowledge",
    ]);
  });

  it("orders without hiding for the editor, and accepts only sidebar groups and their items", () => {
    const placed = new Map([["b", { nodeId: "b", sortOrder: 0, hidden: true }]]);
    expect(orderByLayout([{ id: "a" }, { id: "b" }, { id: "c" }], placed).map((x) => x.id)).toEqual(
      ["b", "a", "c"],
    );
    const ids = sidebarNodeIds(sitemap);
    expect(ids.has("group.production")).toBe(true);
    expect(ids.has("finance")).toBe(true);
    expect(ids.has("settings")).toBe(false);
    expect(ids.has("finance.budgets")).toBe(false);
  });
});

// The key handler ----------------------------------------------------------------------------------

class FakeElement {
  constructor(
    readonly tagName = "DIV",
    readonly overlay = false,
  ) {}
  readonly isContentEditable = false;
  closest(selector: string) {
    return this.overlay && selector.includes("dialog") ? this : null;
  }
}

/** The parts of a key press the handler reads. */
interface PressInit {
  readonly code?: string;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
  readonly repeat?: boolean;
  readonly target?: FakeElement;
}

interface Pressed {
  defaultPrevented: boolean;
  stopped: boolean;
}

describe("shell key handler (Section 11.2)", () => {
  let window: EventTarget;
  let stop: () => void;
  let calls: string[];

  beforeAll(() => {
    vi.useFakeTimers();
    Object.assign(globalThis, { HTMLElement: FakeElement, Element: FakeElement });
  });
  afterEach(() => stop?.());

  function start(keys: ShellKeys) {
    window = new EventTarget();
    Object.assign(globalThis, { window });
    calls = [];
    const state: { current: KeyState | null } = {
      current: {
        keys,
        handlers: {
          command: (id) => calls.push(`command:${id}`),
          go: (href) => calls.push(`go:${href}`),
          pending: (prefix) => calls.push(`pending:${prefix ?? "none"}`),
        },
      },
    };
    stop = installShellKeys(state);
  }

  function press(key: string, init: PressInit = {}): Pressed {
    const event = new Event("keydown", { cancelable: true });
    const out: Pressed = { defaultPrevented: false, stopped: false };
    Object.defineProperties(event, {
      key: { value: key },
      code: { value: init.code ?? "" },
      metaKey: { value: init.metaKey ?? false },
      ctrlKey: { value: init.ctrlKey ?? false },
      altKey: { value: init.altKey ?? false },
      shiftKey: { value: init.shiftKey ?? false },
      repeat: { value: init.repeat ?? false },
      isComposing: { value: false },
      target: { value: init.target ?? new FakeElement() },
    });
    const original = event.stopPropagation.bind(event);
    event.stopPropagation = () => {
      out.stopped = true;
      original();
    };
    window.dispatchEvent(event);
    out.defaultPrevented = event.defaultPrevented;
    return out;
  }

  const keys = (overrides: Partial<ShellKeys> = {}) => ({
    ...buildShellKeys(SHORTCUT_REGISTRY, {
      platform: "other",
      custom: {},
      goTargets: goTargets("owner"),
    }),
    ...overrides,
  });

  it("runs commands and goes to sections with G then a letter", () => {
    start(keys());
    expect(press("k", { ctrlKey: true }).defaultPrevented).toBe(true);
    press("c");
    press("?", { shiftKey: true });
    press("g");
    const second = press("h");
    expect(second.stopped).toBe(true);
    expect(calls).toEqual([
      "command:command-menu",
      "command:create-menu",
      "command:help",
      "pending:G",
      "pending:none",
      "go:/acme/home",
    ]);
  });

  it("cancels a sequence on another key, and after four seconds", () => {
    start(keys());
    press("g");
    const other = press("q");
    expect(other.defaultPrevented).toBe(false);
    press("g");
    vi.advanceTimersByTime(4000);
    press("h");
    expect(calls).toEqual(["pending:G", "pending:none", "pending:G", "pending:none"]);
  });

  it("stays quiet while typing, except for shortcuts that work in fields", () => {
    start(keys());
    const field = new FakeElement("INPUT");
    expect(press("c", { target: field }).defaultPrevented).toBe(false);
    press("g", { target: field });
    press("k", { ctrlKey: true, target: field });
    expect(calls).toEqual(["command:command-menu"]);
  });

  it("keeps single keys out of dialogs and off while me.shortcuts_enabled is off", () => {
    start(keys());
    press("c", { target: new FakeElement("BUTTON", true) });
    press("k", { ctrlKey: true, target: new FakeElement("BUTTON", true) });
    expect(calls).toEqual(["command:command-menu"]);
    stop();
    // The shell applies me.shortcuts_enabled = false as data-shortcuts="off" on the document root.
    Object.assign(globalThis, { document: { documentElement: { dataset: { shortcuts: "off" } } } });
    start(keys());
    press("c");
    press("g");
    press(".", { ctrlKey: true });
    expect(calls).toEqual(["command:focus-mode"]);
    Object.assign(globalThis, { document: undefined });
  });

  it("leaves keys a component handled, repeats and keys outside the grammar alone", () => {
    start(keys());
    const event = new Event("keydown", { cancelable: true });
    Object.defineProperties(event, {
      key: { value: "c" },
      metaKey: { value: false },
      ctrlKey: { value: false },
      altKey: { value: false },
      shiftKey: { value: false },
      repeat: { value: false },
      isComposing: { value: false },
      target: { value: new FakeElement() },
    });
    event.preventDefault();
    window.dispatchEvent(event);
    press("c", { repeat: true });
    press("Shift", { shiftKey: true });
    expect(calls).toEqual([]);
  });

  it("answers the person's own keys", () => {
    start(
      buildShellKeys(SHORTCUT_REGISTRY, {
        platform: "mac",
        custom: { "create-menu": "Shift+N", "go.home": "G Q" },
        goTargets: goTargets("owner"),
      }),
    );
    press("c");
    press("N", { shiftKey: true });
    press("g");
    press("q");
    press("k", { metaKey: true });
    expect(calls).toEqual([
      "command:create-menu",
      "pending:G",
      "pending:none",
      "go:/acme/home",
      "command:command-menu",
    ]);
  });
});
