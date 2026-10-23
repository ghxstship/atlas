import type { XosClient } from "./client.ts";
import { ok, type Result } from "./result.ts";
import { untyped } from "./untyped.ts";

/**
 * Search for the command menu (Section 11.10 item 1, Section 11.7; finding A59-015): records and
 * incidents by key (`NWS-12`) or title, records of the kinds the query names, and members by name.
 * Every read runs under the reader's row level security, so a person finds only what they may read.
 * A lookup that fails leaves its group empty; the menu still shows pages and settings.
 */

export interface SearchHit {
  readonly kind: "record" | "incident";
  readonly id: string;
  /** The human key, for example NWS-12. */
  readonly key: string;
  readonly title: string;
  /** The record kind (Task, Permit, ...), or null for an incident. */
  readonly recordKind: string | null;
  readonly projectKey: string;
}

export interface PersonHit {
  readonly personId: string;
  readonly name: string;
}

export interface SearchResults {
  readonly hits: readonly SearchHit[];
  readonly people: readonly PersonHit[];
}

const KEY = /^([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,7})$/;

function like(term: string): string {
  return `%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
}

type Row = Record<string, unknown>;

async function read(query: PromiseLike<{ data: unknown; error: unknown }>): Promise<Row[]> {
  try {
    const { data, error } = await query;
    return error || !Array.isArray(data) ? [] : (data as Row[]);
  } catch {
    return [];
  }
}

function projectKeyOf(row: Row): string {
  const project = row["project"] as { project_key?: string } | null | undefined;
  return project?.project_key ?? "";
}

/**
 * Search one org. `kinds` are record kinds whose name the query matches (the caller compares the
 * query with each kind's label in the person's language); `incidents` asks for recent incidents when
 * the query names incidents.
 */
export async function searchOrg(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly query: string;
    readonly kinds?: readonly string[];
    readonly incidents?: boolean;
    readonly limit?: number;
  },
): Promise<Result<SearchResults>> {
  const term = input.query.trim();
  if (term.length < 2) return ok({ hits: [], people: [] });
  const limit = input.limit ?? 6;
  const u = untyped(db);
  const recordColumns =
    "id, record_number, title, record_kind, project:projects!records_project_id_fkey!inner(project_key)";
  const incidentColumns =
    "id, incident_number, title, project:projects!incidents_project_id_fkey!inner(project_key)";
  const key = KEY.exec(term);
  const queries: Promise<Row[]>[] = [];
  if (key) {
    const projectKey = (key[1] as string).toUpperCase();
    const number = Number(key[2]);
    queries.push(
      read(
        u
          .from("records")
          .select(recordColumns)
          .eq("org_id", input.orgId)
          .is("deleted_at", null)
          .eq("project.project_key", projectKey)
          .eq("record_number", number)
          .limit(1),
      ),
      read(
        u
          .from("incidents")
          .select(incidentColumns)
          .eq("org_id", input.orgId)
          .is("deleted_at", null)
          .eq("project.project_key", projectKey)
          .eq("incident_number", number)
          .limit(1),
      ),
    );
  } else {
    queries.push(
      read(
        u
          .from("records")
          .select(recordColumns)
          .eq("org_id", input.orgId)
          .is("deleted_at", null)
          .ilike("title", like(term))
          .order("updated_at", { ascending: false })
          .limit(limit),
      ),
      read(
        u
          .from("incidents")
          .select(incidentColumns)
          .eq("org_id", input.orgId)
          .is("deleted_at", null)
          .ilike("title", like(term))
          .order("occurred_at", { ascending: false })
          .limit(limit),
      ),
    );
    if (input.kinds && input.kinds.length > 0) {
      queries.push(
        read(
          u
            .from("records")
            .select(recordColumns)
            .eq("org_id", input.orgId)
            .is("deleted_at", null)
            .in("record_kind", [...input.kinds])
            .order("updated_at", { ascending: false })
            .limit(limit),
        ),
      );
    }
    if (input.incidents) {
      queries.push(
        read(
          u
            .from("incidents")
            .select(incidentColumns)
            .eq("org_id", input.orgId)
            .is("deleted_at", null)
            .order("occurred_at", { ascending: false })
            .limit(limit),
        ),
      );
    }
  }
  const people = key
    ? Promise.resolve([] as Row[])
    : read(
        u
          .from("memberships")
          .select("person_id, person:people!memberships_person_id_fkey!inner(full_name)")
          .eq("org_id", input.orgId)
          .is("deleted_at", null)
          .ilike("person.full_name", like(term))
          .limit(limit),
      );
  const [found, members] = await Promise.all([Promise.all(queries), people]);
  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  for (const row of found.flat()) {
    const id = String(row["id"]);
    if (seen.has(id)) continue;
    seen.add(id);
    const projectKey = projectKeyOf(row);
    const isRecord = "record_number" in row;
    const number = Number(isRecord ? row["record_number"] : row["incident_number"]);
    hits.push({
      kind: isRecord ? "record" : "incident",
      id,
      key: `${projectKey}-${number}`,
      title: String(row["title"] ?? ""),
      recordKind: isRecord ? String(row["record_kind"] ?? "") : null,
      projectKey,
    });
  }
  const names = new Map<string, string>();
  for (const m of members) {
    const person = m["person"] as { full_name?: string | null } | null;
    const id = String(m["person_id"] ?? "");
    if (id && person?.full_name && !names.has(id)) names.set(id, person.full_name);
  }
  return ok({
    hits: hits.slice(0, limit * 2),
    people: [...names].map(([personId, name]) => ({ personId, name })),
  });
}
