/**
 * The REST downloader: pulls every source for the audience and writes it through SyncSession, so the
 * device-side scope check runs on each row. Used when the PowerSync service is not configured (local
 * development, Maestro runs) and as a manual refresh. A source that fails is reported, never skipped
 * silently, and the rest still download.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Row, SyncSession } from "@xos/sync";
import { CANON_DOMAIN, sourcesFor, toLocalRows, type Source } from "./sources";

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

export async function downloadAll({
  client,
  session,
  projectId,
}: DownloadOptions): Promise<DownloadReport> {
  let written = 0;
  let refused = 0;
  const failed: { table: string; message: string }[] = [];
  const pulled = new Map<string, Row[]>();
  for (const source of sourcesFor(session.scope.audience)) {
    const { data, error } = await fetchSource(client, source, projectId);
    if (error) {
      failed.push({ table: source.table, message: error.message });
      continue;
    }
    const rows = enrich(
      source.table,
      toLocalRows(source, (data ?? []) as unknown as Record<string, unknown>[]) as Row[],
      pulled,
    );
    pulled.set(source.table, [...(pulled.get(source.table) ?? []), ...rows]);
    // A full pull is a snapshot; a project-limited pull must not remove other projects' rows.
    const report =
      projectId === null || !source.projectColumn
        ? await session.replace(source.table, rows)
        : await session.ingest(source.table, rows);
    written += report.written;
    refused += report.refused;
  }
  return { written, refused, failed };
}
