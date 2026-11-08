/**
 * The rebinder's table in Personal settings, Keyboard Shortcuts: the Stream Deck's function keys share
 * their action names with the console's letters (show.previous is K, show.deck.previous is F15), so a
 * shared action is named with its group. Every row has its own name, which is also the row's key and
 * what Change and Reset look the shortcut up by. The editor, the router and the actions are stand-ins.
 */
import { getMessages } from "@xos/i18n";
import { SHORTCUT_REGISTRY } from "@xos/schemas/shortcuts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rows: [] as { action: string; keys: string }[],
}));

function translate(key: string, values: Record<string, string> = {}): string {
  const message = key
    .split(".")
    .reduce<unknown>(
      (node, part) => (node as Record<string, unknown> | undefined)?.[part],
      getMessages("en-US"),
    );
  if (typeof message !== "string") return key;
  return message.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? `{${name}}`);
}

vi.mock("next-intl", () => ({ useTranslations: () => translate }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock("@/lib/settings/shell-preferences-actions", () => ({
  resetShortcutAction: async () => ({ ok: true }),
  saveShortcutAction: async () => ({ ok: true }),
}));
vi.mock("@xos/ui", () => ({
  Button: () => null,
  InlineAlert: () => null,
  ShortcutEditor: (props: { rows: { action: string; keys: string }[] }) => {
    state.rows = props.rows;
    return createElement("table");
  },
}));

const { ShortcutRebinder } = await import("@/components/settings/shortcut-rebinder");

describe("the shortcut rebinder's rows", () => {
  it("names every row once, and a Stream Deck row with its group", () => {
    const rows = SHORTCUT_REGISTRY.shells.atlas.shortcuts.filter((s) => !s.fixed).map((s) => s.id);
    renderToStaticMarkup(
      createElement(ShortcutRebinder, {
        org: "demo-productions",
        platform: "other",
        custom: {},
        rows,
        singleKeys: true,
      }),
    );
    const actions = state.rows.map((r) => r.action);
    expect(actions).toHaveLength(rows.length);
    expect(new Set(actions).size).toBe(actions.length);
    expect(actions).toContain("Move the standby to the previous cue (Show calling)");
    expect(actions).toContain("Move the standby to the previous cue (Show calling: Stream Deck)");
    // An action no other shortcut shares keeps its plain name.
    expect(actions).toContain(translate("help.shortcuts.inbox.snooze"));
  });
});
