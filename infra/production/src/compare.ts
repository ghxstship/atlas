/**
 * Compares the row counts of the cleaned database with a database built from the same migrations and no seeds
 * (RRR-109). Both sides come from infra/production/table-counts.sql, one "schema.table rows" line per table.
 *
 * After the demo removal the two must match table by table. The only differences allowed are runtime history that
 * no seed writes and that a fresh build has not had time to collect: cron run details, pg_net queues, Realtime
 * internals and the CLI's own record of which seed files a reset loaded.
 */

export type Counts = Map<string, number>;

/** Tables whose rows are runtime history, not data: they differ between any two builds. */
export const RUNTIME_TABLES: readonly RegExp[] = [
  /^cron\.job_run_details$/,
  /^net\./,
  /^realtime\./,
  /^_realtime\./,
  /^supabase_migrations\.seed_files$/,
];

export interface CountDifference {
  table: string;
  baseline: number | null;
  target: number | null;
  runtime: boolean;
}

export function parseCounts(text: string): Counts {
  const counts: Counts = new Map();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const match = /^(\S+)\s+(\d+)$/.exec(trimmed);
    if (!match?.[1] || !match[2]) throw new Error(`Malformed count line: ${line}`);
    counts.set(match[1], Number(match[2]));
  }
  return counts;
}

/** Every table whose count differs, or that exists on one side only, sorted by name. */
export function compareCounts(baseline: Counts, target: Counts): CountDifference[] {
  const tables = [...new Set([...baseline.keys(), ...target.keys()])].sort();
  const differences: CountDifference[] = [];
  for (const table of tables) {
    const a = baseline.get(table) ?? null;
    const b = target.get(table) ?? null;
    if (a === b) continue;
    differences.push({
      table,
      baseline: a,
      target: b,
      runtime: RUNTIME_TABLES.some((pattern) => pattern.test(table)),
    });
  }
  return differences;
}

export function formatDifferences(differences: readonly CountDifference[]): string {
  if (differences.length === 0) return "Every table matches the no-seed build.";
  return differences
    .map(
      (d) =>
        `${d.runtime ? "runtime " : "DATA    "}${d.table}: no-seed ${d.baseline ?? "absent"}, target ${d.target ?? "absent"}`,
    )
    .join("\n");
}
