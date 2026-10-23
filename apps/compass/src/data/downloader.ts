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

async function fetchSource(client: SupabaseClient, source: Source, projectId: string | null) {
  let query = client.schema(source.schema).from(source.relation).select(source.select);
  const domain = CANON_DOMAIN[source.table];
  if (domain) query = query.eq("enum_domain", domain);
  if (projectId && source.projectColumn) query = query.eq(source.projectColumn, projectId);
  return query;
}

/** External cues carry no project; it comes from their running order, so the scope check can place them. */
function enrich(table: string, rows: Row[], pulled: ReadonlyMap<string, Row[]>): Row[] {
  if (table !== "cues") return rows;
  const project = new Map((pulled.get("run_of_show") ?? []).map((r) => [r.id, r["project_id"]]));
  return rows.map((r) =>
    r["project_id"] ? r : { ...r, project_id: project.get(String(r["run_of_show_id"])) ?? null },
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
  for (const [table, tableSources] of byTable(sources)) {
    if (only && !only.includes(table)) continue;
    const rows: Row[] = [];
    const seen = new Set<string>();
    let complete = true;
    let projectLimited = false;
    for (const source of tableSources) {
      const { data, error } = await fetchSource(client, source, projectId);
      if (error) {
        failed.push({ table, message: error.message });
        complete = false;
        continue;
      }
      if (projectId !== null && source.projectColumn) projectLimited = true;
      for (const row of toLocalRows(
        source,
        (data ?? []) as unknown as Record<string, unknown>[],
      ) as Row[]) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        rows.push(row);
      }
    }
    if (rows.length === 0 && !complete) continue;
    const enriched = enrich(table, rows, pulled);
    pulled.set(table, enriched);
    // A full pull of every source is a snapshot; a project-limited pull, or one where a source failed,
    // must not remove the rows it did not fetch.
    const report =
      complete && !projectLimited
        ? await session.replace(table, enriched)
        : await session.ingest(table, enriched);
    written += report.written;
    refused += report.refused;
  }
  return { written, refused, failed };
}
