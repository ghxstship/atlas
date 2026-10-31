/**
 * Keyboard Shortcuts in Personal settings (A81 with A125): stored bindings the registry now refuses,
 * such as a list key (J, K, X) kept for an Inbox shortcut before A125, are not dropped quietly. The
 * panel names those shortcuts in a warning, in every shipped locale, and the rebinder gets only the
 * bindings the registry still accepts. @xos/data, the request headers and the rebinder are stand-ins.
 */
import { getMessages } from "@xos/i18n";
import { SHORTCUT_REGISTRY, validBindings } from "@xos/schemas/shortcuts";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgContext } from "@/lib/shell/context";

const state = vi.hoisted(() => ({
  stored: {} as Record<string, string | null>,
  locale: "en-US" as "en-US" | "es-US",
  rebinder: null as { custom: Record<string, string | null> } | null,
}));

vi.mock("@xos/data/shell-preferences", () => ({
  listShortcutBindings: async () => ({ ok: true, data: state.stored }),
  listSidebarLayout: async () => ({ ok: true, data: [] }),
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/shell/org-settings", () => ({
  getShellSettings: async () => ({ preferences: { shortcuts: true } }),
}));
vi.mock("@/lib/shell/translate", () => ({
  getTranslate:
    async () =>
    (key: string, values: Record<string, string> = {}) => {
      const message = key
        .split(".")
        .reduce<unknown>(
          (node, part) => (node as Record<string, unknown> | undefined)?.[part],
          getMessages(state.locale),
        );
      if (typeof message !== "string") return key;
      return message.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? `{${name}}`);
    },
}));
vi.mock("@/components/settings/shortcut-rebinder", () => ({
  ShortcutRebinder: (props: { custom: Record<string, string | null> }) => {
    state.rebinder = props;
    return createElement("div", { "data-rebinder": "" });
  },
}));
vi.mock("@/components/settings/sidebar-editor", () => ({ SidebarEditor: () => null }));
vi.mock("@/components/ui", () => ({
  InlineAlert: ({ children }: { children: ReactNode }) =>
    createElement("div", { role: "alert" }, children),
}));

const { contributions } = await import("@/components/settings/contributions/a81");

const ctx = {
  org: { id: "o1", slug: "demo-productions" },
  viewer: { db: {} },
  role: "owner",
  persona: null,
  nav: { role: "owner", conditions: ["desktop"], disabledModules: [] },
} as unknown as OrgContext;

async function renderPanel(): Promise<string> {
  const panel = contributions.find((c) => c.node === "me.keyboard-shortcuts");
  if (!panel) throw new Error("No Keyboard Shortcuts panel");
  return renderToStaticMarkup((await panel.Panel({ ctx, params: {} })) as ReactElement);
}

beforeEach(() => {
  state.rebinder = null;
  state.locale = "en-US";
});

describe("Keyboard Shortcuts settings", () => {
  it("names the stored bindings the registry now refuses, and keeps the others", async () => {
    state.stored = { "inbox.done": "X", "inbox.snooze": "Z" };
    // X is a list key, which no Inbox shortcut may take since A125; Z is free.
    expect(validBindings(SHORTCUT_REGISTRY, "atlas", state.stored)).toEqual({
      "inbox.snooze": "Z",
    });
    const html = await renderPanel();
    const done = getMessages("en-US").help.shortcuts.inbox.done;
    const snooze = getMessages("en-US").help.shortcuts.inbox.snooze;
    expect(html).toContain('role="alert"');
    expect(html).toContain("Some of your shortcuts use their default keys again");
    expect(html).toContain(done);
    expect(html).not.toContain(snooze);
    expect(state.rebinder?.custom).toEqual({ "inbox.snooze": "Z" });

    state.locale = "es-US";
    const es = await renderPanel();
    expect(es).toContain("Algunos de tus atajos vuelven a usar sus teclas predeterminadas");
    expect(es).toContain(getMessages("es-US").help.shortcuts.inbox.done);
  });

  it("shows no warning when every stored binding still holds", async () => {
    state.stored = { "inbox.snooze": "Z" };
    const html = await renderPanel();
    expect(html).not.toContain('role="alert"');
    expect(html).toContain("data-rebinder");
  });
});
