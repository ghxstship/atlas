import type { Database, XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * A person's own shell preferences (A81, RRR-126): rebound keyboard shortcuts (migration 1370, Section 11.7)
 * and their sidebar layout in an org (migration 1371, Section 4.5.2). Row level security keeps each person to
 * their own rows; the shortcut registry (@xos/schemas/shortcuts) decides which keys a shortcut may take before
 * a binding is saved. Whether single-key shortcuts are on (me.shortcuts_enabled) reaches the shells through
 * the display preferences (@xos/ui/preferences).
 */

export type ShortcutShellLabel = Database["app"]["Enums"]["shortcut_shell"];

/** The person's rebound shortcuts in a shell, by shortcut id; null marks a shortcut they turned off. */
export async function listShortcutBindings(
  db: XosClient,
  shell: ShortcutShellLabel,
): Promise<Result<Record<string, string | null>>> {
  const { data, error } = await db
    .from("shortcut_bindings")
    .select("shortcut_id, keys")
    .eq("shell", shell)
    .is("deleted_at", null);
  if (error) return fail(toDataError(error));
  return ok(Object.fromEntries(data.map((row) => [row.shortcut_id, row.keys])));
}

/** Binds one of the person's shortcuts to new keys, or turns it off with null. */
export async function setShortcutBinding(
  db: XosClient,
  input: {
    readonly shell: ShortcutShellLabel;
    readonly shortcutId: string;
    readonly keys: string | null;
  },
): Promise<Result<null>> {
  const { error } = await db.rpc("set_shortcut_binding", {
    p_shell: input.shell,
    p_shortcut_id: input.shortcutId,
    // A blank string turns the shortcut off, as null does; the RPC's typed parameter is text.
    p_keys: input.keys ?? "",
  });
  return error ? fail(toDataError(error)) : ok(null);
}

/** Returns one shortcut, or every shortcut of the shell, to its default keys. */
export async function resetShortcutBindings(
  db: XosClient,
  input: { readonly shell: ShortcutShellLabel; readonly shortcutId?: string },
): Promise<Result<number>> {
  const { data, error } = await db.rpc("reset_shortcut_bindings", {
    p_shell: input.shell,
    ...(input.shortcutId ? { p_shortcut_id: input.shortcutId } : {}),
  });
  return error ? fail(toDataError(error)) : ok(data);
}

export interface SidebarItemPreference {
  /** Sitemap node of a module group or item. */
  readonly nodeId: string;
  readonly sortOrder: number;
  readonly hidden: boolean;
}

/** The person's own layout of the org's sidebar, in order; empty means the role default. */
export async function listSidebarLayout(
  db: XosClient,
  orgId: string,
): Promise<Result<SidebarItemPreference[]>> {
  const { data, error } = await db
    .from("sidebar_item_preferences")
    .select("node_id, sort_order, hidden")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("sort_order");
  if (error) return fail(toDataError(error));
  return ok(
    data.map((row) => ({ nodeId: row.node_id, sortOrder: row.sort_order, hidden: row.hidden })),
  );
}

/** Saves the person's whole sidebar layout in an org; nodes left out return to the role default. */
export async function saveSidebarLayout(
  db: XosClient,
  orgId: string,
  items: readonly { readonly nodeId: string; readonly hidden: boolean }[],
): Promise<Result<number>> {
  const { data, error } = await db.rpc("save_sidebar_layout", {
    p_org_id: orgId,
    p_items: items.map((item) => ({ node: item.nodeId, hidden: item.hidden })),
  });
  return error ? fail(toDataError(error)) : ok(data);
}

/** Reset to role default: removes the person's sidebar layout in an org. */
export async function resetSidebarLayout(db: XosClient, orgId: string): Promise<Result<number>> {
  const { data, error } = await db.rpc("reset_sidebar_layout", { p_org_id: orgId });
  return error ? fail(toDataError(error)) : ok(data);
}
