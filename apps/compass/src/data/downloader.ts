/**
 * The REST downloader: pulls every source for the person's orgs and writes it through SyncSession, so the
 * device-side scope check runs on each row. Used when the PowerSync service is not configured (local
 * development, Maestro runs) and as a manual refresh. A source that fails is reported, never skipped
 * silently, and the rest still download.
 *
 * A person in several orgs can need a table from both the app tables (orgs they are a member of) and the
 * api_external views (orgs that engage them). The rows of every source for a table are merged before the
 * table is written, so one source's snapshot never removes the other's rows.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Row, SyncSession } from "@xos/sync";
import { CANON_DOMAIN, sourcesForAudiences, toLocalRows, type Source } from "./sources";

export interface DownloadReport {
  readonly written: number;
  readonly refused: number;
  readonly failed: readonly { readonly table: string; readonly message: string }[];
}

export interface DownloadOptions {
  readonly client: SupabaseClient;
  readonly session: SyncSession;
  /** Limits project-scoped sources to the current project; null pulls every project in scope. */
  readonly projectId: string | null;
  /** Pulls only these local tables (a live screen refreshing what it shows); omitted pulls every source. */
  readonly only?: readonly string[];
}

async function fetchSource(
  client: SupabaseClient,
  source: Source,
  projectId: string | null,
  personId: string | null,
) {
  let query = client.schema(source.schema).from(source.relation).select(source.select);
  const domain = CANON_DOMAIN[source.table];
  if (domain) query = query.eq("enum_domain", domain);
  if (projectId && source.projectColumn) query = query.eq(source.projectColumn, projectId);
  if (personId && source.personColumn) query = query.eq(source.personColumn, personId);
  return query;
}

/**
 * Rows that carry no project (external cues, purchase order lines, rider lines) take it from their parent's row
 * pulled earlier in this download, so the scope check can place them. Their sources name the parent.
 */
function enrich(source: Source, rows: Row[], pulled: ReadonlyMap<string, Row[]>): Row[] {
  const parent = source.parent;
  if (!parent) return rows;
  const project = new Map((pulled.get(parent.table) ?? []).map((r) => [r.id, r["project_id"]]));
  return rows.map((r) =>
    r["project_id"] ? r : { ...r, project_id: project.get(String(r[parent.column])) ?? null },
  );
}

/** Sources grouped by local table, in first-seen order. */
function byTable(sources: readonly Source[]): Map<string, Source[]> {
  const tables = new Map<string, Source[]>();
  for (const source of sources)
    tables.set(source.table, [...(tables.get(source.table) ?? []), source]);
  return tables;
}

export async function downloadAll({
  client,
  session,
  projectId,
  only,
}: DownloadOptions): Promise<DownloadReport> {
  let written = 0;
  let refused = 0;
  const failed: { table: string; message: string }[] = [];
  const pulled = new Map<string, Row[]>();
  const sources = sourcesForAudiences(session.scopes.map((s) => s.audience));
  // The person is the same in every org scope; person-limited sources (their own expenses and lodging) filter on them.
  const personId = session.scope.personIds[0] ?? null;
  for (const [table, tableSources] of byTable(sources)) {
    if (only && !only.includes(table)) continue;
    const rows: Row[] = [];
    const seen = new Set<string>();
    let complete = true;
    let projectLimited = false;
    for (const source of tableSources) {
      const { data, error } = await fetchSource(client, source, projectId, personId);
      if (error) {
        failed.push({ table, message: error.message });
        complete = false;
        continue;
      }
      if (projectId !== null && source.projectColumn) projectLimited = true;
      for (const row of enrich(
        source,
        toLocalRows(source, (data ?? []) as unknown as Record<string, unknown>[]) as Row[],
        pulled,
      )) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        rows.push(row);
      }
    }
    if (rows.length === 0 && !complete) continue;
    pulled.set(table, rows);
    // A full pull of every source is a snapshot; a project-limited pull, or one where a source failed,
    // must not remove the rows it did not fetch.
    const report =
      complete && !projectLimited
        ? await session.replace(table, rows)
        : await session.ingest(table, rows);
    written += report.written;
    refused += report.refused;
  }
  return { written, refused, failed };
}
