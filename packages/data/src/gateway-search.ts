import type { XosClient } from "./client.ts";
import type { Json } from "./database.types.ts";
import { toDisplayKey } from "./gateway-keys.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";
import type { ParsedSearch } from "./search-query.ts";

/**
 * Gateway search (Section 11.10 item 1, trace S11.10-02, A126, ADR 0086): the command menu and the phone
 * Home search the signed-in person's own engagements, engagement documents, conversations and
 * opportunities through app.gateway_search (migration 2190). The function is SECURITY DEFINER and applies
 * the Section 8.7 helpers the api_external projections apply, so it returns only what the person reads in
 * Gateway. Words, quoted phrases and exclusions come from the same grammar as Atlas's command menu
 * (`@xos/data/search-query`); Atlas's record operators do not apply to Gateway and are left out.
 */

export const GATEWAY_SEARCH_TYPES = ["engagement", "opportunity", "document", "message"] as const;
export type GatewaySearchType = (typeof GATEWAY_SEARCH_TYPES)[number];

export interface GatewaySearchRequest {
  readonly terms: readonly string[];
  readonly phrases: readonly string[];
  readonly exclude_terms: readonly string[];
  readonly exclude_phrases: readonly string[];
  readonly types?: readonly GatewaySearchType[];
}

export interface GatewaySearchHit {
  readonly type: GatewaySearchType;
  readonly id: string;
  /** A document's engagement; null otherwise. */
  readonly parentId: string | null;
  /**
   * The engagement or opportunity role type, the document kind, or for a message whether the thread is
   * an engagement thread (`engagement`) or an org-level conversation (`party`).
   */
  readonly kind: string | null;
  /** The job title of an engagement (null when it has none), or the document, thread or opportunity title. */
  readonly title: string | null;
  /** An engagement's or document's project, or the text of the message that matched. */
  readonly detail: string | null;
  readonly orgId: string;
  readonly orgName: string;
  readonly datedAt: string | null;
  readonly rank: number;
}

/** The words of a parsed query as the request app.gateway_search reads. */
export function gatewaySearchRequest(
  query: ParsedSearch,
  types?: readonly GatewaySearchType[],
): GatewaySearchRequest {
  return {
    terms: query.terms,
    phrases: query.phrases,
    exclude_terms: query.excludeTerms,
    exclude_phrases: query.excludePhrases,
    ...(types && types.length > 0 ? { types } : {}),
  };
}

/** True when the request has a word or phrase to look for; exclusions alone find nothing. */
export function hasGatewaySearchWords(request: GatewaySearchRequest): boolean {
  return [...request.terms, ...request.phrases].some((w) => w.trim() !== "");
}

const TYPES = new Set<string>(GATEWAY_SEARCH_TYPES);

type Row = Record<string, unknown>;

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function toHit(row: Row): GatewaySearchHit | null {
  const type = row["result_type"];
  const id = text(row["result_id"]);
  const orgId = text(row["org_id"]);
  if (typeof type !== "string" || !TYPES.has(type) || !id || !orgId) return null;
  return {
    type: type as GatewaySearchType,
    id,
    parentId: text(row["parent_id"]),
    kind: text(row["kind"]),
    title: text(row["title"]),
    detail: text(row["detail"]),
    orgId,
    orgName: text(row["org_name"]) ?? "",
    datedAt: text(row["dated_at"]),
    rank: Number(row["rank"] ?? 0),
  };
}

/**
 * Searches what the signed-in person reads in Gateway. `orgId`, on an org's custom domain, keeps that
 * org's rows only (Section 4.4.7). Up to `limit` results of each type, best first.
 */
export async function gatewaySearch(
  db: XosClient,
  input: {
    readonly request: GatewaySearchRequest;
    readonly orgId?: string | null;
    readonly limit?: number;
  },
): Promise<Result<readonly GatewaySearchHit[]>> {
  if (!hasGatewaySearchWords(input.request)) return ok([]);
  const { data, error } = await db.rpc("gateway_search", {
    p_query: input.request as unknown as Json,
    ...(input.orgId ? { p_org_id: input.orgId } : {}),
    p_limit: input.limit ?? 6,
  });
  if (error) return fail(toDataError(error));
  const rows = Array.isArray(data) ? (data as Row[]) : [];
  return ok(rows.map(toHit).filter((h): h is GatewaySearchHit => h !== null));
}

/** Where Gateway opens a result: the engagement, its documents tab, the conversation or the listing. */
export function gatewaySearchHref(hit: GatewaySearchHit): string | null {
  switch (hit.type) {
    case "engagement":
      return `/work/engagements/${toDisplayKey("engagement", hit.id)}/overview`;
    case "document":
      return hit.parentId
        ? `/work/engagements/${toDisplayKey("engagement", hit.parentId)}/documents`
        : null;
    case "message":
      return `/messages/${toDisplayKey("thread", hit.id)}`;
    case "opportunity":
      return `/explore/${toDisplayKey("opportunity", hit.id)}`;
  }
}
