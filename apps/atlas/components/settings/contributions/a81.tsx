import { listShortcutBindings, listSidebarLayout } from "@xos/data/shell-preferences";
import { isNodeVisible } from "@xos/ia";
import { platformOf, SHORTCUT_REGISTRY, validBindings } from "@xos/schemas/shortcuts";
import { headers } from "next/headers";
import { ShortcutRebinder } from "@/components/settings/shortcut-rebinder";
import { SidebarEditor } from "@/components/settings/sidebar-editor";
import { InlineAlert } from "@/components/ui";
import { buildShellNav, orderByLayout } from "@/lib/shell/nav-model";
import { getShellSettings } from "@/lib/shell/org-settings";
import { sitemap } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";
import type { SettingsContribution, SettingsPanelProps } from "./types";

/**
 * A81's panels (RRR-126): rebinding keyboard shortcuts in Personal settings, Keyboard Shortcuts
 * (Section 11.7), and the person's sidebar layout in Preferences (Section 4.5.2). Each reads with the
 * viewer's client, so row level security keeps the person to their own rows.
 */

async function ShortcutsPanel({ ctx }: SettingsPanelProps) {
  const [t, stored, settings, headerStore] = await Promise.all([
    getTranslate(),
    listShortcutBindings(ctx.viewer.db, "Atlas"),
    // me.shortcuts_enabled as the shell applies it (display preferences, A76).
    getShellSettings(ctx.viewer.db, ctx.org.id, null),
    headers(),
  ]);
  if (!stored.ok) {
    return <InlineAlert tone="danger">{t("settings.loadFailed")}</InlineAlert>;
  }
  const custom = validBindings(SHORTCUT_REGISTRY, "atlas", stored.data);
  const shortcuts = SHORTCUT_REGISTRY.shells.atlas.shortcuts;
  // Shortcuts to sections the person cannot open are left out; fixed keys are listed in Help.
  const rows = shortcuts
    .filter((s) => !s.fixed && (s.go === null || isNodeVisible(sitemap, s.go, ctx.nav)))
    .map((s) => s.id);
  // Stored keys the registry now refuses (taken by a new shortcut, or reserved) are named, not dropped
  // quietly: those shortcuts are back on their default keys.
  const dropped = shortcuts
    .filter((s) => Object.hasOwn(stored.data, s.id) && !Object.hasOwn(custom, s.id))
    .map((s) => t(s.label));
  const rebinder = (
    <ShortcutRebinder
      org={ctx.org.slug}
      platform={platformOf({
        platform: headerStore.get("sec-ch-ua-platform") ?? undefined,
        userAgent: headerStore.get("user-agent") ?? undefined,
      })}
      custom={custom}
      rows={rows}
      singleKeys={settings.preferences.shortcuts}
    />
  );
  if (dropped.length === 0) return rebinder;
  return (
    <>
      <InlineAlert tone="warning">
        {t("settings.shortcuts.dropped", { actions: dropped.join(", ") })}
      </InlineAlert>
      {rebinder}
    </>
  );
}

async function SidebarPanel({ ctx }: SettingsPanelProps) {
  const [t, layout] = await Promise.all([
    getTranslate(),
    listSidebarLayout(ctx.viewer.db, ctx.org.id),
  ]);
  if (!layout.ok) return <InlineAlert tone="danger">{t("settings.loadFailed")}</InlineAlert>;
  // The role default, then the person's order on top of it, keeping the items they hid.
  const base = buildShellNav(sitemap, {
    nav: ctx.nav,
    role: ctx.role,
    persona: ctx.persona,
    params: { org: ctx.org.slug },
    t,
  });
  const placed = new Map(layout.data.map((entry) => [entry.nodeId, entry]));
  const groups = orderByLayout(base.groups, placed).map((group) => ({
    id: group.id,
    label: group.label,
    items: orderByLayout(group.items, placed).map((item) => ({
      id: item.id,
      label: item.label,
      hidden: placed.get(item.id)?.hidden ?? false,
    })),
  }));
  return <SidebarEditor org={ctx.org.slug} groups={groups} />;
}

export const contributions: readonly SettingsContribution[] = [
  { node: "me.keyboard-shortcuts", order: 10, Panel: ShortcutsPanel },
  { node: "me.preferences", order: 50, Panel: SidebarPanel },
];
