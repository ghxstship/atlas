"use server";

import type { DataError } from "@xos/data";
import {
  clearDefaultSavedView,
  createSavedView,
  deleteSavedView,
  listSavedViews,
  listTeams,
  renameSavedView,
  myMembershipId,
  setDefaultSavedView,
  shareSavedView,
  updateSavedView,
  type SavedView,
  type SavedViewInput,
  type Team,
} from "@xos/data/views";
import { SAVED_VIEW_TYPES } from "@xos/schemas/views";
import { z } from "zod";
import { getOrgContext } from "@/lib/shell/context";
import type { Database } from "@xos/data/database.types";
import * as enums from "@xos/data/enums";

/**
 * Server actions behind the saved views menu of every collection (Section 11.15). Each reads and
 * writes with the viewer's own client, so row level security decides; a refusal comes back as a
 * `views.errors.*` catalog key the menu shows.
 */

export type ViewsError = "denied" | "invalid" | "conflict" | "notFound" | "unexpected";
export type ViewsResult<T = null> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: ViewsError };

const FIELD = z.string().regex(/^[a-z][a-z0-9_.]*$/);
const COLLECTION = z.string().regex(/^[a-z][a-z0-9_]*(\/[a-z][a-z0-9_]*)?$/);
export interface ViewDraft {
  readonly name: string;
  readonly viewType: SavedViewInput["viewType"];
  readonly searchText: string | null;
  readonly groupByField: string | null;
  readonly filters: readonly { field: string; operator: "eq"; value: string }[];
  readonly sorts: readonly {
    field: string;
    direction: Database["app"]["Enums"]["sort_direction"];
  }[];
}

const queryShape: z.ZodType<ViewDraft> = z.object({
  name: z.string().trim().min(1).max(100),
  viewType: z.enum(SAVED_VIEW_TYPES),
  searchText: z.string().max(200).nullable(),
  groupByField: FIELD.nullable(),
  filters: z
    .array(z.object({ field: FIELD, operator: z.literal("eq"), value: z.string().max(1000) }))
    .max(50),
  sorts: z.array(z.object({ field: FIELD, direction: z.enum(enums.sortDirection) })).max(10),
});

function errorOf(error: DataError): ViewsError {
  if (error.kind === "not-found") return "notFound";
  if (error.kind === "conflict") return "conflict";
  if (error.kind === "invalid") return "invalid";
  if (error.kind === "refusal") return "denied";
  return error.code === "42501" ? "denied" : "unexpected";
}

async function context(orgSlug: string) {
  const ctx = await getOrgContext(orgSlug);
  if (!ctx?.viewer.person) return null;
  const membership = await myMembershipId(ctx.viewer.db, {
    orgId: ctx.org.id,
    personId: ctx.viewer.person.id,
  });
  if (!membership.ok) return null;
  return { db: ctx.viewer.db, orgId: ctx.org.id, membershipId: membership.data };
}

export interface ViewsMenuData {
  readonly views: readonly SavedView[];
  readonly teams: readonly Team[];
}

/** The saved views of a collection the viewer can open, and the teams they can share with. */
export async function loadViewsAction(
  orgSlug: string,
  collectionKey: string,
): Promise<ViewsResult<ViewsMenuData>> {
  if (!COLLECTION.safeParse(collectionKey).success) return { ok: false, error: "invalid" };
  const c = await context(orgSlug);
  if (!c) return { ok: false, error: "denied" };
  const [views, teams] = await Promise.all([
    listSavedViews(c.db, { orgId: c.orgId, membershipId: c.membershipId, collectionKey }),
    listTeams(c.db, c.orgId),
  ]);
  if (!views.ok) return { ok: false, error: errorOf(views.error) };
  if (!teams.ok) return { ok: false, error: errorOf(teams.error) };
  return { ok: true, data: { views: views.data, teams: teams.data } };
}

/** Saves the current query as a new private view, shared as chosen. */
export async function saveViewAction(
  orgSlug: string,
  collectionKey: string,
  draft: ViewDraft,
  share: { readonly org: boolean; readonly teamIds: readonly string[] },
): Promise<ViewsResult<string>> {
  const parsed = queryShape.safeParse(draft);
  if (!parsed.success || !COLLECTION.safeParse(collectionKey).success) {
    return { ok: false, error: "invalid" };
  }
  const c = await context(orgSlug);
  if (!c) return { ok: false, error: "denied" };
  const created = await createSavedView(c.db, {
    ...parsed.data,
    orgId: c.orgId,
    membershipId: c.membershipId,
    collectionKey,
  });
  if (!created.ok) return { ok: false, error: errorOf(created.error) };
  if (share.org || share.teamIds.length > 0) {
    const shared = await shareSavedView(c.db, created.data, { orgId: c.orgId, ...share });
    if (!shared.ok) return { ok: false, error: errorOf(shared.error) };
  }
  return { ok: true, data: created.data };
}

/** Replaces one of the viewer's views with the current query. */
export async function updateViewAction(
  orgSlug: string,
  viewId: string,
  draft: ViewDraft,
): Promise<ViewsResult> {
  const parsed = queryShape.safeParse(draft);
  if (!parsed.success || !z.uuid().safeParse(viewId).success) {
    return { ok: false, error: "invalid" };
  }
  const c = await context(orgSlug);
  if (!c) return { ok: false, error: "denied" };
  const result = await updateSavedView(c.db, viewId, { ...parsed.data, orgId: c.orgId });
  return result.ok ? { ok: true, data: null } : { ok: false, error: errorOf(result.error) };
}

/** Sets who one of the viewer's views is shared with. */
export async function shareViewAction(
  orgSlug: string,
  viewId: string,
  share: { readonly org: boolean; readonly teamIds: readonly string[] },
): Promise<ViewsResult> {
  if (
    !z.uuid().safeParse(viewId).success ||
    !z.array(z.uuid()).max(50).safeParse(share.teamIds).success
  ) {
    return { ok: false, error: "invalid" };
  }
  const c = await context(orgSlug);
  if (!c) return { ok: false, error: "denied" };
  const result = await shareSavedView(c.db, viewId, { orgId: c.orgId, ...share });
  return result.ok ? { ok: true, data: null } : { ok: false, error: errorOf(result.error) };
}

/** Removes one of the viewer's views. */
export async function deleteViewAction(orgSlug: string, viewId: string): Promise<ViewsResult> {
  if (!z.uuid().safeParse(viewId).success) return { ok: false, error: "invalid" };
  const c = await context(orgSlug);
  if (!c) return { ok: false, error: "denied" };
  const result = await deleteSavedView(c.db, viewId);
  return result.ok ? { ok: true, data: null } : { ok: false, error: errorOf(result.error) };
}

/** Makes a view the viewer's default for its page, or clears the default when `viewId` is null. */
export async function setDefaultViewAction(
  orgSlug: string,
  collectionKey: string,
  viewId: string | null,
): Promise<ViewsResult> {
  if (!COLLECTION.safeParse(collectionKey).success) return { ok: false, error: "invalid" };
  if (viewId !== null && !z.uuid().safeParse(viewId).success) {
    return { ok: false, error: "invalid" };
  }
  const c = await context(orgSlug);
  if (!c) return { ok: false, error: "denied" };
  const result =
    viewId === null
      ? await clearDefaultSavedView(c.db, { membershipId: c.membershipId, collectionKey })
      : await setDefaultSavedView(c.db, viewId);
  return result.ok ? { ok: true, data: null } : { ok: false, error: errorOf(result.error) };
}

/** Renames one of the viewer's views, keeping its query. */
export async function renameViewAction(
  orgSlug: string,
  viewId: string,
  name: string,
): Promise<ViewsResult> {
  const parsed = z.string().trim().min(1).max(100).safeParse(name);
  if (!parsed.success || !z.uuid().safeParse(viewId).success) {
    return { ok: false, error: "invalid" };
  }
  const c = await context(orgSlug);
  if (!c) return { ok: false, error: "denied" };
  const result = await renameSavedView(c.db, viewId, parsed.data);
  return result.ok ? { ok: true, data: null } : { ok: false, error: errorOf(result.error) };
}
