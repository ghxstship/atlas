/**
 * Demo seed markers (RRR-109, ADR 0033 decision 1 amendment).
 *
 * The removal script `infra/production/remove-demo-data.sql` never guesses what the demo seed created.
 * It starts from markers read out of `supabase/seeds/*.sql` and follows foreign keys and org_id from
 * there. This module reads the seeds and renders the marker block the script carries:
 *
 *   ids       every fixed id in the seed namespace (0000_demo_tenant_conventions.sql): the demo orgs,
 *             sign-ins, people, memberships and the other rows a seed pins to a known id
 *   domains   the email domains of every address the seeds use; the seed rules allow example.com only,
 *             a reserved domain (RFC 2606) that no real person signs in with
 *   tables    every table a seed writes to directly, so the report can show which seeded tables still
 *             hold rows after the run
 *
 * The block sits between the BEGIN and END marker lines in the SQL file. `cli.ts generate` rewrites it
 * and `cli.ts check` (and the test suite) fail when the seeds change without regenerating it.
 */

/** Prefix of every fixed id the seeds use (see supabase/seeds/0000_demo_tenant_conventions.sql). */
export const SEED_ID_NAMESPACE = "01920000-0000-7000-8000-";

export const BLOCK_BEGIN = "-- BEGIN GENERATED SEED MARKERS (infra/production/src/cli.ts generate)";
export const BLOCK_END = "-- END GENERATED SEED MARKERS";

export interface SeedFile {
  name: string;
  sql: string;
}

export interface SeedMarkers {
  files: string[];
  ids: string[];
  domains: string[];
  tables: string[];
}

const ID_PATTERN = /01920000-0000-7000-8000-[0-9a-f]{12}/gi;
const EMAIL_PATTERN = /[a-z0-9._%+-]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi;
const WRITE_PATTERN = /\binsert\s+into\s+([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)/gi;

const sortedUnique = (values: Iterable<string>): string[] => [...new Set(values)].sort();

/** Reads the markers out of the seed files, in file name order. */
export function deriveSeedMarkers(files: readonly SeedFile[]): SeedMarkers {
  const ordered = [...files].sort((a, b) => a.name.localeCompare(b.name));
  const ids: string[] = [];
  const domains: string[] = [];
  const tables: string[] = [];
  for (const file of ordered) {
    for (const match of file.sql.matchAll(ID_PATTERN)) ids.push(match[0].toLowerCase());
    for (const match of file.sql.matchAll(EMAIL_PATTERN))
      domains.push((match[1] ?? "").toLowerCase());
    for (const match of file.sql.matchAll(WRITE_PATTERN)) {
      tables.push(`${(match[1] ?? "").toLowerCase()}.${(match[2] ?? "").toLowerCase()}`);
    }
  }
  return {
    files: ordered.map((file) => file.name),
    ids: sortedUnique(ids),
    domains: sortedUnique(domains),
    tables: sortedUnique(tables),
  };
}

const sqlValues = (values: readonly string[], cast: string): string =>
  values.map((value) => `  ('${value.replaceAll("'", "''")}'${cast})`).join(",\n");

/** Renders the marker block: three temp tables the removal script reads. */
export function renderMarkerBlock(markers: SeedMarkers): string {
  if (markers.ids.length === 0)
    throw new Error("No seed ids found; refusing to render an empty marker set.");
  if (markers.domains.length === 0) throw new Error("No seed email domains found.");
  return [
    BLOCK_BEGIN,
    `-- Derived from ${markers.files.length} seed files: ${markers.ids.length} fixed ids, ` +
      `${markers.domains.length} email domain(s), ${markers.tables.length} seeded tables.`,
    "insert into pg_temp.demo_seed_ids (id) values",
    `${sqlValues(markers.ids, "::uuid")};`,
    "insert into pg_temp.demo_email_domains (domain) values",
    `${sqlValues(markers.domains, "")};`,
    "insert into pg_temp.demo_seed_tables (table_name) values",
    `${sqlValues(markers.tables, "")};`,
    BLOCK_END,
  ].join("\n");
}

/** Returns the marker block currently in the SQL file, or null when the marker lines are missing. */
export function extractMarkerBlock(sql: string): string | null {
  const begin = sql.indexOf(BLOCK_BEGIN);
  const end = sql.indexOf(BLOCK_END);
  if (begin < 0 || end < begin) return null;
  return sql.slice(begin, end + BLOCK_END.length);
}

/** Replaces the marker block in the SQL file with a freshly rendered one. */
export function replaceMarkerBlock(sql: string, block: string): string {
  const current = extractMarkerBlock(sql);
  if (current === null) throw new Error("The SQL file has no generated marker block.");
  return sql.replace(current, block);
}

/** Domains in the seeds other than the reserved test domains (RFC 2606 and RFC 6761). */
export function unsafeDomains(markers: SeedMarkers): string[] {
  const reserved = /(^|\.)(example\.(com|net|org)|test|example|invalid|localhost)$/;
  return markers.domains.filter((domain) => !reserved.test(domain));
}
