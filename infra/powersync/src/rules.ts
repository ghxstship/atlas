/**
 * Checks A17's PowerSync sync rules (packages/sync/sync-rules.yaml) against the database the service
 * replicates from, and writes the replication publication they need.
 *
 * PowerSync reads changes through Postgres logical replication, so every table a bucket selects from
 * must be a real table (not a view) in a publication, named with its schema when it is not in
 * `public`, and partitioned tables must publish through their root. External buckets must not select
 * columns that Section 8.7 keeps internal; they select the columns of the matching api_external view.
 */

export interface RuleQuery {
  readonly bucket: string;
  readonly kind: "parameters" | "data";
  readonly sql: string;
  /** The relation after FROM, exactly as written (`time_entries` or `app.time_entries`). */
  readonly relation: string;
  readonly selectsAll: boolean;
}

/** Reads bucket names and their parameter and data queries from the sync rules YAML text. */
export function parseRules(text: string): RuleQuery[] {
  const queries: RuleQuery[] = [];
  let bucket: string | null = null;
  let kind: RuleQuery["kind"] | null = null;
  let pending: string[] = [];

  const flush = () => {
    if (bucket && kind && pending.length > 0) {
      const sql = pending.join(" ").replace(/\s+/g, " ").trim();
      const from = /\bFROM\s+([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?)/i.exec(sql);
      if (from?.[1]) {
        queries.push({
          bucket,
          kind,
          sql,
          relation: from[1],
          selectsAll: /^SELECT\s+\*/i.test(sql),
        });
      }
    }
    pending = [];
  };

  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*#/.test(raw) || raw.trim() === "") continue;
    const bucketMatch = /^ {2}([a-z_][a-z0-9_]*):\s*$/.exec(raw);
    if (bucketMatch?.[1]) {
      flush();
      bucket = bucketMatch[1];
      kind = null;
      continue;
    }
    const keyMatch = /^ {4}(parameters|data):\s*(.*)$/.exec(raw);
    if (keyMatch?.[1]) {
      flush();
      kind = keyMatch[1] as RuleQuery["kind"];
      const rest = (keyMatch[2] ?? "").replace(/^>-?\s*/, "").trim();
      if (rest) pending.push(rest);
      continue;
    }
    const item = /^ {6}- (.*)$/.exec(raw);
    if (item?.[1]) {
      flush();
      pending.push(item[1]);
      continue;
    }
    if (/^ {6,}\S/.test(raw)) pending.push(raw.trim());
  }
  flush();
  return queries;
}

/** One relation in the replicated database. */
export interface CatalogEntry {
  readonly schema: string;
  readonly name: string;
  /** r: table, p: partitioned table, v: view, m: materialized view. */
  readonly kind: "r" | "p" | "v" | "m";
  readonly columns: readonly string[];
}

export type Problem =
  | { readonly code: "missing"; readonly relation: string; readonly buckets: readonly string[] }
  | {
      readonly code: "not_a_table";
      readonly relation: string;
      readonly qualified: string;
      readonly buckets: readonly string[];
    }
  | {
      readonly code: "unqualified";
      readonly relation: string;
      readonly qualified: string;
      readonly buckets: readonly string[];
    }
  | {
      readonly code: "ambiguous";
      readonly relation: string;
      readonly candidates: readonly string[];
      readonly buckets: readonly string[];
    }
  | {
      readonly code: "external_columns";
      readonly relation: string;
      readonly bucket: string;
      readonly internalColumns: readonly string[];
      /** Whether api_external has a view of the same name to take the allowed columns from. */
      readonly hasExternalView: boolean;
    };

export interface PublicationPlan {
  /** Schema-qualified tables the publication must include. */
  readonly tables: readonly string[];
  readonly partitioned: readonly string[];
  readonly problems: readonly Problem[];
}

/** Schemas PowerSync may replicate from; api_external holds views only and is never replicated. */
const REPLICATED_SCHEMAS = ["app", "private", "xpms"];

/** Buckets whose devices belong to external parties (Section 8.7). */
export function isExternalBucket(bucket: string): boolean {
  return bucket.startsWith("external_");
}

export function planPublication(
  queries: readonly RuleQuery[],
  catalog: readonly CatalogEntry[],
): PublicationPlan {
  const tables = new Set<string>();
  const partitioned = new Set<string>();
  const problems: Problem[] = [];
  const byRelation = new Map<string, RuleQuery[]>();
  for (const q of queries) byRelation.set(q.relation, [...(byRelation.get(q.relation) ?? []), q]);

  for (const [relation, uses] of [...byRelation.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const buckets = [...new Set(uses.map((u) => u.bucket))].sort();
    const [schemaPart, namePart] = relation.includes(".") ? relation.split(".") : [null, relation];
    const candidates = catalog.filter(
      (c) =>
        c.name === namePart &&
        (schemaPart ? c.schema === schemaPart : REPLICATED_SCHEMAS.includes(c.schema)),
    );
    const replicable = candidates.filter((c) => c.kind === "r" || c.kind === "p");
    if (candidates.length === 0) {
      problems.push({ code: "missing", relation, buckets });
      continue;
    }
    if (replicable.length === 0) {
      const first = candidates[0] as CatalogEntry;
      problems.push({
        code: "not_a_table",
        relation,
        qualified: `${first.schema}.${first.name}`,
        buckets,
      });
      continue;
    }
    if (replicable.length > 1) {
      problems.push({
        code: "ambiguous",
        relation,
        candidates: replicable.map((c) => `${c.schema}.${c.name}`),
        buckets,
      });
      continue;
    }
    const entry = replicable[0] as CatalogEntry;
    const qualified = `${entry.schema}.${entry.name}`;
    tables.add(qualified);
    if (entry.kind === "p") partitioned.add(qualified);
    if (!schemaPart) problems.push({ code: "unqualified", relation, qualified, buckets });

    const externalView = catalog.find((c) => c.schema === "api_external" && c.name === entry.name);
    for (const use of uses.filter(
      (u) => u.kind === "data" && isExternalBucket(u.bucket) && u.selectsAll,
    )) {
      const allowed = new Set(externalView?.columns ?? []);
      const internal = entry.columns.filter((col) => !allowed.has(col));
      if (internal.length > 0) {
        problems.push({
          code: "external_columns",
          relation,
          bucket: use.bucket,
          internalColumns: internal,
          hasExternalView: externalView !== undefined,
        });
      }
    }
  }
  return { tables: [...tables].sort(), partitioned: [...partitioned].sort(), problems };
}

export function describeProblem(problem: Problem): string {
  switch (problem.code) {
    case "missing":
      return `${problem.relation}: no such table in ${REPLICATED_SCHEMAS.join(", ")} (buckets ${problem.buckets.join(", ")}).`;
    case "not_a_table":
      return `${problem.relation}: ${problem.qualified} is a view; logical replication publishes tables only (buckets ${problem.buckets.join(", ")}).`;
    case "unqualified":
      return `${problem.relation}: write ${problem.qualified}; PowerSync reads unqualified names from the public schema (buckets ${problem.buckets.join(", ")}).`;
    case "ambiguous":
      return `${problem.relation}: matches ${problem.candidates.join(" and ")}; qualify it (buckets ${problem.buckets.join(", ")}).`;
    case "external_columns":
      return problem.hasExternalView
        ? `${problem.relation} in ${problem.bucket}: SELECT * sends internal columns to external devices (${problem.internalColumns.join(", ")}); select only the api_external.${problem.relation.split(".").pop()} columns.`
        : `${problem.relation} in ${problem.bucket}: external devices receive every column and api_external has no ${problem.relation.split(".").pop()} view defining what they may see; add the view (A28's range) and select its columns.`;
  }
}

/**
 * The replication role and publication. The role has no password here: the owner sets one in the
 * SQL editor and stores it only in the PowerSync service's secret configuration.
 */
export function publicationSql(plan: PublicationPlan): string {
  const schemas = [...new Set(plan.tables.map((t) => t.split(".")[0] as string))].sort();
  const lines = [
    "-- PowerSync replication for Compass (Section 5: PowerSync open edition; Section 13).",
    "-- Generated by infra/powersync/src/cli.ts from packages/sync/sync-rules.yaml; regenerate, never edit.",
    "do $$",
    "begin",
    "  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'powersync_role') then",
    "    create role powersync_role with login replication bypassrls;",
    "  end if;",
    "end",
    "$$;",
    "comment on role powersync_role is 'PowerSync service replication login. Reads the published tables only; its password lives in the PowerSync secret configuration.';",
    ...schemas.map((s) => `grant usage on schema ${s} to powersync_role;`),
    ...plan.tables.map((t) => `grant select on ${t} to powersync_role;`),
    "-- Altered in place when it exists, so the service's replication slot keeps streaming.",
    "do $$",
    "begin",
    "  if exists (select 1 from pg_catalog.pg_publication where pubname = 'powersync') then",
    `    alter publication powersync set table ${plan.tables.join(", ")};`,
    "    alter publication powersync set (publish_via_partition_root = true);",
    "  else",
    `    create publication powersync for table ${plan.tables.join(", ")} with (publish_via_partition_root = true);`,
    "  end if;",
    "end",
    "$$;",
    "",
  ];
  return lines.join("\n");
}
