import type { Database, XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Saved views repository (Section 11.15): a person's views of a collection, shared with the org or
 * with teams, and the default view per page. Tables of migrations 0540 (A18) and 0641 (A31); row level
 * security decides what each person reads and writes, and this module returns refusals typed. A
 * shared view carries only its query, so every viewer still sees only rows their own access allows.
 */

type Enums = Database["app"]["Enums"];
export type SavedViewType = Enums["view_type"];
export type FilterOperator = Enums["filter_operator"];
export type SortDirection = Enums["sort_direction"];

export interface SavedViewFilter {
  readonly field: string;
  readonly operator: FilterOperator;
  readonly value: string | null;
}

export interface SavedViewSort {
  readonly field: string;
  readonly direction: SortDirection;
}

export interface SavedView {
  readonly id: string;
  readonly name: string;
  readonly collectionKey: string;
  readonly viewType: SavedViewType;
  readonly groupByField: string | null;
  readonly searchText: string | null;
  /** Shared with every member of the org. */
  readonly shared: boolean;
  /** Teams the view is shared with (only the owner and the teams' members see these). */
  readonly teamIds: readonly string[];
  /** True when the signed-in person owns the view and may edit, share or remove it. */
  readonly mine: boolean;
  /** True when the view is the signed-in person's default for its page. */
  readonly isDefault: boolean;
  readonly filters: readonly SavedViewFilter[];
  readonly sorts: readonly SavedViewSort[];
}

export interface SavedViewInput {
  readonly name: string;
  readonly viewType: SavedViewType;
  readonly groupByField?: string | null;
  readonly searchText?: string | null;
  readonly filters?: readonly SavedViewFilter[];
  readonly sorts?: readonly SavedViewSort[];
}

export interface Team {
  readonly id: string;
  readonly name: string;
}

interface ViewRow {
  id: string;
  name: string;
  collection_key: string;
  view_type: SavedViewType;
  group_by_field: string | null;
  search_text: string | null;
  shared: boolean;
  membership_id: string;
  saved_view_filters: {
    field: string;
    operator: FilterOperator;
    value_text: string | null;
    deleted_at: string | null;
  }[];
  saved_view_sorts: {
    field: string;
    direction: SortDirection;
    position: number;
    deleted_at: string | null;
  }[];
  saved_view_shares: { team_id: string; deleted_at: string | null }[];
}

const VIEW_COLUMNS: string =
  "id, name, collection_key, view_type, group_by_field, search_text, shared, membership_id, " +
  "saved_view_filters (field, operator, value_text, deleted_at), " +
  "saved_view_sorts (field, direction, position, deleted_at), " +
  "saved_view_shares (team_id, deleted_at)";

/** The signed-in person's active membership in an org. */
export async function myMembershipId(
  db: XosClient,
  input: { readonly orgId: string; readonly personId: string },
): Promise<Result<string>> {
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("memberships")
    .select("id")
    .eq("org_id", input.orgId)
    .eq("person_id", input.personId)
    .is("deleted_at", null)
    .lte("valid_from", now)
    .or(`valid_to.is.null,valid_to.gt.${now}`)
    .order("valid_from", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  return data ? ok(data.id) : fail({ kind: "not-found" });
}

function toView(row: ViewRow, membershipId: string, defaultId: string | null): SavedView {
  return {
    id: row.id,
    name: row.name,
    collectionKey: row.collection_key,
    viewType: row.view_type,
    groupByField: row.group_by_field,
    searchText: row.search_text,
    shared: row.shared,
    teamIds: row.saved_view_shares.filter((s) => s.deleted_at === null).map((s) => s.team_id),
    mine: row.membership_id === membershipId,
    isDefault: row.id === defaultId,
    filters: row.saved_view_filters
      .filter((f) => f.deleted_at === null)
      .map((f) => ({ field: f.field, operator: f.operator, value: f.value_text })),
    sorts: row.saved_view_sorts
      .filter((s) => s.deleted_at === null)
      .sort((a, b) => a.position - b.position)
      .map((s) => ({ field: s.field, direction: s.direction })),
  };
}

/**
 * The views of a collection the signed-in person can open: their own first, then shared ones, by
 * name. The person's default is flagged; a default whose view they can no longer read is ignored.
 */
export async function listSavedViews(
  db: XosClient,
  input: { readonly orgId: string; readonly membershipId: string; readonly collectionKey: string },
): Promise<Result<SavedView[]>> {
  const [views, defaults] = await Promise.all([
    db
      .from("saved_views")
      .select(VIEW_COLUMNS)
      .eq("org_id", input.orgId)
      .eq("collection_key", input.collectionKey)
      .is("deleted_at", null)
      .order("name"),
    db
      .from("saved_view_defaults")
      .select("saved_view_id")
      .eq("membership_id", input.membershipId)
      .eq("collection_key", input.collectionKey)
      .is("deleted_at", null)
      .maybeSingle(),
  ]);
  if (views.error) return fail(toDataError(views.error));
  if (defaults.error) return fail(toDataError(defaults.error));
  const defaultId = defaults.data?.saved_view_id ?? null;
  const rows = (views.data ?? []) as unknown as ViewRow[];
  const list = rows.map((r) => toView(r, input.membershipId, defaultId));
  return ok([...list.filter((v) => v.mine), ...list.filter((v) => !v.mine)]);
}

/**
 * Every saved view the signed-in person can open in an org, across collections: their own first,
 * then shared ones, each by name. Defaults are flagged per collection.
 */
export async function listAllSavedViews(
  db: XosClient,
  input: { readonly orgId: string; readonly membershipId: string },
): Promise<Result<SavedView[]>> {
  const [views, defaults] = await Promise.all([
    db
      .from("saved_views")
      .select(VIEW_COLUMNS)
      .eq("org_id", input.orgId)
      .is("deleted_at", null)
      .order("name")
      .limit(500),
    db
      .from("saved_view_defaults")
      .select("saved_view_id")
      .eq("membership_id", input.membershipId)
      .is("deleted_at", null),
  ]);
  if (views.error) return fail(toDataError(views.error));
  if (defaults.error) return fail(toDataError(defaults.error));
  const defaultIds = new Set((defaults.data ?? []).map((d) => d.saved_view_id));
  const rows = (views.data ?? []) as unknown as ViewRow[];
  const list = rows.map((r) => toView(r, input.membershipId, defaultIds.has(r.id) ? r.id : null));
  return ok([...list.filter((v) => v.mine), ...list.filter((v) => !v.mine)]);
}

/** Renames a view, keeping its query. Only the owner may. */
export async function renameSavedView(
  db: XosClient,
  viewId: string,
  name: string,
): Promise<Result<null>> {
  const { data, error } = await db
    .from("saved_views")
    .update({ name: name.trim() })
    .eq("id", viewId)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return data && data.length > 0 ? ok(null) : fail({ kind: "not-found" });
}

/** One saved view the signed-in person can open, by id; not-found when it is missing or not theirs. */
export async function getSavedView(
  db: XosClient,
  input: { readonly orgId: string; readonly membershipId: string; readonly viewId: string },
): Promise<Result<SavedView>> {
  const { data, error } = await db
    .from("saved_views")
    .select(VIEW_COLUMNS)
    .eq("org_id", input.orgId)
    .eq("id", input.viewId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  return ok(toView(data as unknown as ViewRow, input.membershipId, null));
}

async function writeQuery(
  db: XosClient,
  orgId: string,
  viewId: string,
  filters: readonly SavedViewFilter[],
  sorts: readonly SavedViewSort[],
): Promise<Result<null>> {
  const now = new Date().toISOString();
  const clearFilters = await db
    .from("saved_view_filters")
    .update({ deleted_at: now })
    .eq("saved_view_id", viewId)
    .is("deleted_at", null);
  if (clearFilters.error) return fail(toDataError(clearFilters.error));
  const clearSorts = await db
    .from("saved_view_sorts")
    .update({ deleted_at: now })
    .eq("saved_view_id", viewId)
    .is("deleted_at", null);
  if (clearSorts.error) return fail(toDataError(clearSorts.error));
  if (filters.length > 0) {
    const { error } = await db.from("saved_view_filters").insert(
      filters.map((f) => ({
        org_id: orgId,
        saved_view_id: viewId,
        field: f.field,
        operator: f.operator,
        value_text: f.value,
      })),
    );
    if (error) return fail(toDataError(error));
  }
  if (sorts.length > 0) {
    const { error } = await db.from("saved_view_sorts").insert(
      sorts.map((s, i) => ({
        org_id: orgId,
        saved_view_id: viewId,
        field: s.field,
        direction: s.direction,
        position: i + 1,
      })),
    );
    if (error) return fail(toDataError(error));
  }
  return ok(null);
}

/** Saves the current query of a collection as a new private view. Returns its id. */
export async function createSavedView(
  db: XosClient,
  input: SavedViewInput & {
    readonly orgId: string;
    readonly membershipId: string;
    readonly collectionKey: string;
  },
): Promise<Result<string>> {
  const { data, error } = await db
    .from("saved_views")
    .insert({
      org_id: input.orgId,
      membership_id: input.membershipId,
      collection_key: input.collectionKey,
      name: input.name.trim(),
      view_type: input.viewType,
      group_by_field: input.groupByField ?? null,
      search_text: input.searchText ?? null,
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  const query = await writeQuery(db, input.orgId, data.id, input.filters ?? [], input.sorts ?? []);
  return query.ok ? ok(data.id) : fail(query.error);
}

/** Replaces a view's name and query with the current one. Only the owner may. */
export async function updateSavedView(
  db: XosClient,
  viewId: string,
  input: SavedViewInput & { readonly orgId: string },
): Promise<Result<null>> {
  const { data, error } = await db
    .from("saved_views")
    .update({
      name: input.name.trim(),
      view_type: input.viewType,
      group_by_field: input.groupByField ?? null,
      search_text: input.searchText ?? null,
    })
    .eq("id", viewId)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  if (!data || data.length === 0) return fail({ kind: "not-found" });
  return writeQuery(db, input.orgId, viewId, input.filters ?? [], input.sorts ?? []);
}

/** Removes a view (soft delete). Only the owner may. */
export async function deleteSavedView(db: XosClient, viewId: string): Promise<Result<null>> {
  const { data, error } = await db
    .from("saved_views")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", viewId)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return data && data.length > 0 ? ok(null) : fail({ kind: "not-found" });
}

/**
 * Sets who a view is shared with: the whole org, and the given teams (replacing earlier team
 * shares). Only the owner may.
 */
export async function shareSavedView(
  db: XosClient,
  viewId: string,
  input: { readonly orgId: string; readonly org: boolean; readonly teamIds: readonly string[] },
): Promise<Result<null>> {
  const updated = await db
    .from("saved_views")
    .update({ shared: input.org })
    .eq("id", viewId)
    .is("deleted_at", null)
    .select("id");
  if (updated.error) return fail(toDataError(updated.error));
  if (!updated.data || updated.data.length === 0) return fail({ kind: "not-found" });
  const current = await db
    .from("saved_view_shares")
    .select("id, team_id")
    .eq("saved_view_id", viewId)
    .is("deleted_at", null);
  if (current.error) return fail(toDataError(current.error));
  const have = current.data ?? [];
  const remove = have.filter((s) => !input.teamIds.includes(s.team_id)).map((s) => s.id);
  const add = input.teamIds.filter((t) => !have.some((s) => s.team_id === t));
  if (remove.length > 0) {
    const { error } = await db
      .from("saved_view_shares")
      .update({ deleted_at: new Date().toISOString() })
      .in("id", remove);
    if (error) return fail(toDataError(error));
  }
  if (add.length > 0) {
    const { error } = await db
      .from("saved_view_shares")
      .insert(add.map((team_id) => ({ org_id: input.orgId, saved_view_id: viewId, team_id })));
    if (error) return fail(toDataError(error));
  }
  return ok(null);
}

/** Makes a view the signed-in person's default for its page (app.set_saved_view_default). */
export async function setDefaultSavedView(db: XosClient, viewId: string): Promise<Result<null>> {
  const { error } = await db.rpc("set_saved_view_default", {
    p_saved_view_id: viewId,
  });
  return error ? fail(toDataError(error)) : ok(null);
}

/** Clears the signed-in person's default for a page, so the page opens on its own default view. */
export async function clearDefaultSavedView(
  db: XosClient,
  input: { readonly membershipId: string; readonly collectionKey: string },
): Promise<Result<null>> {
  const { error } = await db
    .from("saved_view_defaults")
    .update({ deleted_at: new Date().toISOString() })
    .eq("membership_id", input.membershipId)
    .eq("collection_key", input.collectionKey)
    .is("deleted_at", null);
  return error ? fail(toDataError(error)) : ok(null);
}

/** The teams of an org a view can be shared with, by name. */
export async function listTeams(db: XosClient, orgId: string): Promise<Result<Team[]>> {
  const { data, error } = await db
    .from("teams")
    .select("id, name")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("name");
  if (error) return fail(toDataError(error));
  return ok((data ?? []).map((t) => ({ id: t.id, name: t.name })));
}
