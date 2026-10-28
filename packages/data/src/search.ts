import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";
import type { SearchRequest } from "./search-query.ts";
import { untyped } from "./untyped.ts";

/**
 * Global search for the command menu (Section 11.10 item 1, Section 11.7; findings A59-015 and A65-005).
 * Thin wrappers over migration 1440:
 *   * `globalSearch`: app.global_search, SECURITY INVOKER, so the reader's row level security decides every
 *     row; it takes the structured request `@xos/data/search-query` builds and an optional query vector;
 *   * `recentItems` and `recordRecentView`: what the person opened, newest first, at most 50;
 *   * `recentProjects`: the projects the person opened most recently, for the sidebar (migration 2090);
 *   * `searchContext`: the person, the org's calendar and whether the org has semantic search on.
 */

export type SearchResultType = "record" | "incident" | "person" | "document" | "sop" | "article";

/** How a result matched: a record key, words, meaning, both, or filters alone. */
export type SearchMatch = "key" | "text" | "semantic" | "both" | "filter";

export interface SearchHit {
  readonly type: SearchResultType;
  readonly id: string;
  /** The human key (NWL-12, SOP-001), or null for people, documents and articles. */
  readonly key: string | null;
  readonly title: string;
  /** The record kind (Task, Permit), or null for anything but a record. */
  readonly recordKind: string | null;
  /** The record or incident state, or Draft and Published for SOPs. */
  readonly state: string | null;
  readonly projectKey: string | null;
  /** The date the item last changed (an incident's: when it happened). */
  readonly datedAt: string | null;
  readonly rank: number;
  readonly matched: SearchMatch;
}

export interface RecentItem {
  readonly type: Exclude<SearchResultType, "person">;
  readonly id: string;
  readonly key: string | null;
  readonly title: string;
  readonly recordKind: string | null;
  readonly state: string | null;
  readonly projectKey: string | null;
  readonly viewedAt: string;
}

export interface SearchContext {
  readonly personId: string | null;
  readonly timeZone: string;
  /** Today on the org's calendar, `YYYY-MM-DD`. */
  readonly today: string;
  readonly semanticEnabled: boolean;
}

/** Tables a recent view may name (app.recent_views.subject_table; projects since migration 2090). */
export type RecentViewTable =
  "records" | "incidents" | "documents" | "sops" | "handbook_articles" | "projects";

/** A project the person opened recently (app.recent_projects). */
export interface RecentProject {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly viewedAt: string;
}

const TYPES = new Set<SearchResultType>([
  "record",
  "incident",
  "person",
  "document",
  "sop",
  "article",
]);
const MATCHES = new Set<SearchMatch>(["key", "text", "semantic", "both", "filter"]);

type Row = Record<string, unknown>;

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function toHit(row: Row): SearchHit | null {
  const type = row["result_type"] as SearchResultType;
  const id = text(row["result_id"]);
  if (!TYPES.has(type) || !id) return null;
  const matched = row["matched"] as SearchMatch;
  return {
    type,
    id,
    key: text(row["result_key"]),
    title: text(row["title"]) ?? "",
    recordKind: text(row["record_kind"]),
    state: text(row["state"]),
    projectKey: text(row["project_key"]),
    datedAt: text(row["dated_at"]),
    rank: Number(row["rank"] ?? 0),
    matched: MATCHES.has(matched) ? matched : "text",
  };
}

/**
 * Searches one org. `embedding` is the query vector in pgvector's text form and `model` the model
 * that made it; both are ignored unless the org has semantic search on.
 */
export async function globalSearch(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly request: SearchRequest;
    readonly embedding?: string | null;
    readonly model?: string | null;
    readonly limit?: number;
    readonly minSimilarity?: number;
  },
): Promise<Result<readonly SearchHit[]>> {
  const { data, error } = await untyped(db).rpc("global_search", {
    p_org_id: input.orgId,
    p_query: input.model ? { ...input.request, model: input.model } : input.request,
    p_embedding: input.embedding ?? null,
    p_limit: input.limit ?? 8,
    p_min_similarity: input.minSimilarity ?? 0.35,
  });
  if (error) return fail(toDataError(error));
  const rows = Array.isArray(data) ? (data as Row[]) : [];
  return ok(rows.map(toHit).filter((h): h is SearchHit => h !== null));
}

/** The person's recently opened items in an org, newest first. */
export async function recentItems(
  db: XosClient,
  orgId: string,
  limit = 50,
): Promise<Result<readonly RecentItem[]>> {
  const { data, error } = await untyped(db).rpc("recent_items", {
    p_org_id: orgId,
    p_limit: limit,
  });
  if (error) return fail(toDataError(error));
  const rows = Array.isArray(data) ? (data as Row[]) : [];
  const items: RecentItem[] = [];
  for (const row of rows) {
    const type = row["result_type"] as RecentItem["type"];
    const id = text(row["result_id"]);
    const viewedAt = text(row["viewed_at"]);
    if (!id || !viewedAt || type === ("person" as string) || !TYPES.has(type)) continue;
    items.push({
      type,
      id,
      key: text(row["result_key"]),
      title: text(row["title"]) ?? "",
      recordKind: text(row["record_kind"]),
      state: text(row["state"]),
      projectKey: text(row["project_key"]),
      viewedAt,
    });
  }
  return ok(items);
}

/** The projects the person opened most recently in an org, newest first (Section 4.5.2). */
export async function recentProjects(
  db: XosClient,
  orgId: string,
  limit = 5,
): Promise<Result<readonly RecentProject[]>> {
  const { data, error } = await db.rpc("recent_projects", { p_org_id: orgId, p_limit: limit });
  if (error) return fail(toDataError(error));
  return ok(
    data.map((row) => ({
      id: row.project_id,
      key: row.project_key,
      name: row.name,
      viewedAt: row.viewed_at,
    })),
  );
}

/**
 * Records that the person opened something. Never throws and never fails the page that called it: a
 * view that is not recorded only leaves the recent list as it was.
 */
export async function recordRecentView(
  db: XosClient,
  input: { readonly orgId: string; readonly table: RecentViewTable; readonly id: string },
): Promise<boolean> {
  try {
    const { data, error } = await untyped(db).rpc("record_recent_view", {
      p_org_id: input.orgId,
      p_subject_table: input.table,
      p_subject_id: input.id,
    });
    return !error && data === true;
  } catch {
    return false;
  }
}

/** The search context of the signed-in member of an org. */
export async function searchContext(db: XosClient, orgId: string): Promise<Result<SearchContext>> {
  const { data, error } = await untyped(db).rpc("search_context", { p_org_id: orgId });
  if (error) return fail(toDataError(error));
  const row = (Array.isArray(data) ? data[0] : data) as Row | undefined;
  if (!row) return fail({ kind: "not-found" });
  return ok({
    personId: text(row["person_id"]),
    timeZone: text(row["time_zone"]) ?? "UTC",
    today: text(row["org_today"]) ?? "",
    semanticEnabled: row["semantic_enabled"] === true,
  });
}
