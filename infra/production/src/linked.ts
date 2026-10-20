/**
 * The demo removal against the linked hosted project, through the Supabase CLI's own login (RRR-109).
 *
 * `supabase db query --linked` runs SQL through the Management API and `supabase storage rm --linked` deletes
 * objects through the Storage API, so this path needs neither DATABASE_URL (the database password) nor the
 * service role key: only `supabase login` and `supabase link` on the owner's machine. The SQL is the same script
 * the psql path runs, translated for one mode by plain-sql.ts.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toPlainSql, type RemovalMode } from "./plain-sql.ts";
import type { StorageObject } from "./storage.ts";

export interface DryRunReport {
  mode: "dry-run";
  orgs_to_remove: { slug: string; name: string; seeded: boolean }[];
  sign_ins_to_remove: { users: number; seeded_ids: number; on_seed_domain_only: number };
  what_stays: { kind: string; name: string | null; count: number }[];
  rows_in_other_orgs: { table_name: string; rows: number }[];
  rows_to_delete: {
    table_name: string;
    rows_to_delete: number;
    rows_now: number;
    seed_writes: boolean;
  }[];
  totals: { tables: number; rows_to_delete: number };
  vault_secrets_to_remove: number;
  storage_objects: { bucket_id: string; name: string }[];
}

export interface RunReport {
  mode: "rehearse" | "execute";
  verification: "passed";
  deleted_per_table: {
    table_name: string;
    rows_before: number;
    rows_after: number;
    deleted: number;
  }[];
  totals: {
    tables_with_deletes: number;
    rows_deleted: number;
    tables_untouched: number;
    canon_rows_kept: number;
  };
  vault_secrets_deleted: number;
  outcome: "committed" | "rolled back";
}

/** The project ref `supabase link` recorded; the target every linked command reaches. */
export function linkedProjectRef(repoRoot: string): string {
  let ref = "";
  try {
    ref = readFileSync(join(repoRoot, "supabase/.temp/project-ref"), "utf8").trim();
  } catch {
    // handled below
  }
  if (!/^[a-z0-9]{20}$/.test(ref)) {
    throw new Error("No linked project: run `supabase link --project-ref <ref>` first.");
  }
  return ref;
}

/** Reads the single report row out of `supabase db query -o json` output (an array of rows). */
export function parseReport<T>(stdout: string): T {
  const rows: unknown = JSON.parse(stdout);
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error(`Expected one report row, got: ${stdout.slice(0, 200)}`);
  }
  const report = (rows[0] as { report?: unknown }).report;
  if (report === undefined || report === null) throw new Error("The query returned no report.");
  return (typeof report === "string" ? JSON.parse(report) : report) as T;
}

type Exec = (args: string[]) => string;

const supabaseCli =
  (repoRoot: string): Exec =>
  (args) =>
    execFileSync("supabase", [...args, "--agent", "no"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });

export function runLinked<T>(source: string, mode: RemovalMode, repoRoot: string, exec?: Exec): T {
  const run = exec ?? supabaseCli(repoRoot);
  const dir = mkdtempSync(join(tmpdir(), "xos-remove-demo-data-"));
  try {
    const file = join(dir, `remove-demo-data.${mode}.sql`);
    writeFileSync(file, toPlainSql(source, mode));
    return parseReport<T>(run(["db", "query", "--linked", "-o", "json", "-f", file]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Deletes objects through the linked project's Storage API, 50 paths per call. */
export function deleteStorageLinked(
  objects: StorageObject[],
  repoRoot: string,
  exec?: Exec,
): number {
  const run = exec ?? supabaseCli(repoRoot);
  let deleted = 0;
  for (let i = 0; i < objects.length; i += 50) {
    const batch = objects.slice(i, i + 50);
    run([
      "storage",
      "rm",
      "--linked",
      "--experimental",
      "--yes",
      ...batch.map((o) => `ss:///${o.bucket}/${o.name}`),
    ]);
    deleted += batch.length;
  }
  return deleted;
}

export function formatDryRun(r: DryRunReport): string {
  const lines = [
    `Orgs to remove: ${r.orgs_to_remove.length}`,
    ...r.orgs_to_remove.map((o) => `  ${o.seeded ? "seeded " : "derived"}  ${o.slug}  (${o.name})`),
    `Sign-ins to remove: ${r.sign_ins_to_remove.users} (${r.sign_ins_to_remove.seeded_ids} seed ids, ${r.sign_ins_to_remove.on_seed_domain_only} on a seed domain only)`,
    `What stays: ${r.what_stays.length === 0 ? "nothing" : ""}`,
    ...r.what_stays.map((s) => `  ${s.kind}${s.name ? ` ${s.name}` : ""}: ${s.count}`),
    `Rows reached in orgs that are not being removed: ${r.rows_in_other_orgs.length === 0 ? "none" : ""}`,
    ...r.rows_in_other_orgs.map((t) => `  ${t.table_name}: ${t.rows}`),
    `Rows to delete: ${r.totals.rows_to_delete} in ${r.totals.tables} tables`,
    `Vault secrets to remove: ${r.vault_secrets_to_remove}`,
    `Storage objects to remove: ${r.storage_objects.length}`,
  ];
  return lines.join("\n");
}

export function formatRun(r: RunReport): string {
  return [
    `Verification ${r.verification}: every table lost exactly its marked rows, a fresh closure finds nothing.`,
    `Rows deleted: ${r.totals.rows_deleted} from ${r.totals.tables_with_deletes} tables; ${r.totals.tables_untouched} tables untouched; canon rows kept: ${r.totals.canon_rows_kept}`,
    `Vault secrets deleted: ${r.vault_secrets_deleted}`,
    r.outcome === "committed" ? "Committed." : "Rehearsal: rolled back, nothing changed.",
  ].join("\n");
}
