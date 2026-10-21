"use server";

import {
  listShortcutBindings,
  resetShortcutBindings,
  resetSidebarLayout,
  saveSidebarLayout,
  setShortcutBinding,
} from "@xos/data/shell-preferences";
import {
  bindingProblem,
  effectiveBindings,
  SHORTCUT_REGISTRY,
  validBindings,
  type BindingProblem,
} from "@xos/schemas/shortcuts";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getOrgContext } from "@/lib/shell/context";
import { sidebarNodeIds } from "@/lib/shell/nav-model";
import { sitemap } from "@/lib/shell/sitemap";

/**
 * Personal settings for the shell (A81, RRR-126): rebinding keyboard shortcuts (Section 11.7) and the
 * person's sidebar layout (Section 4.5.2). Each action re-checks what the editor already checked, with
 * the person's own stored bindings, before it writes, and refreshes the shell so the change applies at
 * once.
 */

export type ShortcutOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly problem: BindingProblem | { readonly kind: "failed" } };

const shortcutId = z.string().min(1).max(60);
const keysText = z.string().min(1).max(40).nullable();

/** Binds one of the person's Atlas shortcuts to new keys, or turns it off with null. */
export async function saveShortcutAction(
  orgSlug: string,
  id: string,
  keys: string | null,
): Promise<ShortcutOutcome> {
  const input = z.object({ id: shortcutId, keys: keysText }).safeParse({ id, keys });
  if (!input.success) return { ok: false, problem: { kind: "invalid" } };
  const ctx = await getOrgContext(orgSlug);
  if (!ctx?.viewer.person) return { ok: false, problem: { kind: "failed" } };
  const shell = SHORTCUT_REGISTRY.shells.atlas;
  const shortcut = shell.shortcuts.find((s) => s.id === input.data.id);
  if (!shortcut) return { ok: false, problem: { kind: "unknown" } };
  if (shortcut.fixed) return { ok: false, problem: { kind: "fixed" } };
  const stored = await listShortcutBindings(ctx.viewer.db, "Atlas");
  if (!stored.ok) return { ok: false, problem: { kind: "failed" } };
  const custom = validBindings(SHORTCUT_REGISTRY, "atlas", stored.data);
  const chosen = input.data.keys;
  if (chosen !== null) {
    const problem = bindingProblem(
      SHORTCUT_REGISTRY,
      "atlas",
      (platform) => effectiveBindings(shell, custom, platform),
      shortcut.id,
      chosen,
    );
    if (problem) return { ok: false, problem };
  }
  // Keys equal to the default on every platform are the default: keep no binding for them.
  const isDefault = chosen !== null && chosen === shortcut.keys && shortcut.mac === null;
  const saved = isDefault
    ? await resetShortcutBindings(ctx.viewer.db, { shell: "Atlas", shortcutId: shortcut.id })
    : await setShortcutBinding(ctx.viewer.db, {
        shell: "Atlas",
        shortcutId: shortcut.id,
        keys: chosen,
      });
  if (!saved.ok) return { ok: false, problem: { kind: "failed" } };
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return { ok: true };
}

/** Returns one Atlas shortcut, or every one when id is null, to its default keys. */
export async function resetShortcutAction(
  orgSlug: string,
  id: string | null,
): Promise<{ readonly ok: boolean }> {
  if (id !== null && !shortcutId.safeParse(id).success) return { ok: false };
  const ctx = await getOrgContext(orgSlug);
  if (!ctx?.viewer.person) return { ok: false };
  const reset = await resetShortcutBindings(ctx.viewer.db, {
    shell: "Atlas",
    ...(id === null ? {} : { shortcutId: id }),
  });
  if (!reset.ok) return { ok: false };
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return { ok: true };
}

const layoutItems = z
  .array(z.strictObject({ nodeId: z.string().min(1).max(120), hidden: z.boolean() }))
  .max(200);

/**
 * Saves the person's sidebar layout in this org: module groups and their items in order, each shown
 * or hidden. Only nodes of the sidebar's module groups are accepted.
 */
export async function saveSidebarAction(
  orgSlug: string,
  items: readonly { readonly nodeId: string; readonly hidden: boolean }[],
): Promise<{ readonly ok: boolean }> {
  const parsed = layoutItems.safeParse(items);
  if (!parsed.success) return { ok: false };
  const allowed = sidebarNodeIds(sitemap);
  if (parsed.data.some((item) => !allowed.has(item.nodeId))) return { ok: false };
  const ctx = await getOrgContext(orgSlug);
  if (!ctx?.viewer.person) return { ok: false };
  const saved = await saveSidebarLayout(ctx.viewer.db, ctx.org.id, parsed.data);
  if (!saved.ok) return { ok: false };
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return { ok: true };
}

/** Reset to role default: removes the person's sidebar layout in this org. */
export async function resetSidebarAction(orgSlug: string): Promise<{ readonly ok: boolean }> {
  const ctx = await getOrgContext(orgSlug);
  if (!ctx?.viewer.person) return { ok: false };
  const reset = await resetSidebarLayout(ctx.viewer.db, ctx.org.id);
  if (!reset.ok) return { ok: false };
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return { ok: true };
}
