/**
 * Turns remove-demo-data.sql, a psql script, into plain SQL for `supabase db query --linked`, which reaches the
 * hosted database through the CLI's own login and needs neither the database password nor the service role key.
 *
 * psql meta-commands have no meaning there, so the transform resolves them for one mode up front:
 *   - `\if` blocks are decided by the mode (`:{?mode}` set; `:{?stop_after_report}` and `:{?storage_list}` unset;
 *     `:is_dry_run` and `:is_execute` from the mode); a `\quit` in a taken branch ends the script there;
 *   - `\echo`, `\set`, `\pset` and `\o` are dropped, a trailing `\gset` is removed, and `:'mode'` becomes a literal.
 * Anything else that looks like a meta-command or a psql variable is refused, so a later edit to the script
 * cannot slip through half-translated.
 *
 * The query endpoint returns one result set: the last one with rows. The transform therefore puts a single JSON
 * report immediately before the statement that ends the transaction (the dry run's rollback, or the final commit
 * or rollback), so the caller always receives the whole report.
 */

export type RemovalMode = "dry-run" | "rehearse" | "execute";

const MODES: readonly RemovalMode[] = ["dry-run", "rehearse", "execute"];

/** The dry run's report: everything the psql run prints, plus the storage object list the execute step needs. */
export const DRY_RUN_REPORT = `select json_build_object(
  'mode', current_setting('xos.demo_removal_mode'),
  'orgs_to_remove', (select coalesce(json_agg(json_build_object('slug', slug, 'name', name, 'seeded', seeded)
                       order by seeded desc, slug), '[]'::json) from demo_orgs),
  'sign_ins_to_remove', (select json_build_object('users', count(*), 'seeded_ids', count(*) filter (where seeded),
                           'on_seed_domain_only', count(*) filter (where not seeded)) from demo_users),
  'what_stays', (select coalesce(json_agg(json_build_object('kind', s.kind, 'name', s.name, 'count', s.count)
                   order by s.kind, s.name), '[]'::json)
                 from (select 'org' as kind, o.slug as name, 1 as count
                       from app.organizations o where o.id not in (select org_id from demo_orgs)
                       union all
                       select 'sign-ins on ' || lower(split_part(u.email, '@', 2)), null, count(*)::int
                       from auth.users u where u.id not in (select user_id from demo_users)
                       group by lower(split_part(u.email, '@', 2))) s),
  'rows_in_other_orgs', (select coalesce(json_agg(json_build_object('table_name', t.table_name, 'rows', t.rows)
                           order by t.table_name), '[]'::json)
                         from (select m.rel::text as table_name, count(*) as rows from demo_marks m
                               where m.org_id is not null and m.org_id not in (select org_id from demo_orgs)
                               group by 1) t),
  'rows_to_delete', (select coalesce(json_agg(json_build_object('table_name', t.table_name,
                       'rows_to_delete', t.rows_to_delete, 'rows_now', t.rows_now, 'seed_writes', t.seed_writes)
                       order by t.table_name), '[]'::json)
                     from (select m.rel::text as table_name, count(*) as rows_to_delete, b.rows as rows_now,
                             (m.rel::text in (select table_name from demo_seed_tables)) as seed_writes
                           from demo_marks m join demo_before b on b.rel = m.rel group by m.rel, b.rows) t),
  'totals', (select json_build_object('tables', count(distinct rel), 'rows_to_delete', count(*)) from demo_marks),
  'vault_secrets_to_remove', (select count(*) from demo_vault),
  'storage_objects', (select coalesce(json_agg(json_build_object('bucket_id', bucket_id, 'name', name)
                        order by bucket_id, name), '[]'::json) from demo_storage)
) as report;`;

/** The rehearsal's and the execute run's report, read after every verification has passed. */
export const RUN_REPORT = `select json_build_object(
  'mode', current_setting('xos.demo_removal_mode'),
  'verification', 'passed',
  'deleted_per_table', (select coalesce(json_agg(json_build_object('table_name', r.schema_name || '.' || r.table_name,
                          'rows_before', r.rows_before, 'rows_after', r.rows_after, 'deleted', r.deleted)
                          order by r.schema_name, r.table_name), '[]'::json)
                        from demo_result r where r.deleted > 0),
  'totals', (select json_build_object('tables_with_deletes', count(*) filter (where deleted > 0),
               'rows_deleted', coalesce(sum(deleted), 0), 'tables_untouched', count(*) filter (where deleted = 0),
               'canon_rows_kept', sum(rows_after) filter (where schema_name = 'xpms')) from demo_result),
  'vault_secrets_deleted', (select count(*) from demo_vault),
  'outcome', case current_setting('xos.demo_removal_mode') when 'execute' then 'committed'
                else 'rolled back' end
) as report;`;

const KNOWN_CONDITIONS = new Set([
  ":{?mode}",
  ":{?stop_after_report}",
  ":{?storage_list}",
  ":is_dry_run",
  ":is_execute",
]);

function condition(expr: string, mode: RemovalMode): boolean {
  switch (expr) {
    case ":{?mode}":
      return true;
    case ":{?stop_after_report}":
    case ":{?storage_list}":
      return false;
    case ":is_dry_run":
      return mode === "dry-run";
    case ":is_execute":
      return mode === "execute";
    default:
      throw new Error(`Unknown \\if condition ${expr}`);
  }
}

/** True when the line ends the transaction: the place the report goes in front of. */
function endsTransaction(line: string): boolean {
  return /^\s*(rollback|commit)\s*;\s*$/i.test(line);
}

export function toPlainSql(source: string, mode: RemovalMode): string {
  if (!MODES.includes(mode)) throw new Error(`Unknown mode ${String(mode)}`);
  const out: string[] = [];
  // Each frame: is this branch taken, was any branch of this \if taken, is the enclosing block live.
  const stack: { taken: boolean; anyTaken: boolean; parentLive: boolean }[] = [];
  const live = () => stack.every((f) => f.taken);
  let dollarTag: string | null = null;
  let reportPlaced = false;
  const placeReport = () => {
    out.push(mode === "dry-run" ? DRY_RUN_REPORT : RUN_REPORT);
    reportPlaced = true;
  };

  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // Dollar-quoted bodies (do $$ ... $$, $w$ ... $w$) pass through untouched: their colons are PL/pgSQL.
    if (dollarTag !== null) {
      if (live()) out.push(line);
      if (line.split(dollarTag).length % 2 === 0) dollarTag = null;
      continue;
    }

    const meta = line.match(/^\s*\\(\w+)\s*(.*)$/);
    if (meta) {
      const [, cmd, rest = ""] = meta;
      switch (cmd) {
        case "if": {
          const expr = rest.trim();
          if (!KNOWN_CONDITIONS.has(expr))
            throw new Error(`Line ${i + 1}: unknown \\if condition ${expr}`);
          const parentLive = live();
          const taken = condition(expr, mode);
          stack.push({ taken, anyTaken: taken, parentLive });
          break;
        }
        case "else": {
          const frame = stack.at(-1);
          if (!frame) throw new Error(`Line ${i + 1}: \\else without \\if`);
          frame.taken = !frame.anyTaken;
          frame.anyTaken = true;
          break;
        }
        case "endif":
          if (!stack.pop()) throw new Error(`Line ${i + 1}: \\endif without \\if`);
          break;
        case "quit":
          if (live()) {
            if (!reportPlaced)
              throw new Error(`Line ${i + 1}: \\quit before the transaction ended`);
            return finish(out);
          }
          break;
        case "echo":
        case "set":
        case "pset":
        case "o":
          break;
        default:
          throw new Error(`Line ${i + 1}: unsupported psql meta-command \\${cmd}`);
      }
      continue;
    }

    if (!live()) continue;

    let sql = line.replace(/\s*\\gset\s*$/, ";").replace(/;;$/, ";");
    sql = sql.replaceAll(":'mode'", `'${mode}'`);
    // Strip comments and string literals before looking for psql variables that were not translated.
    const code = sql.replace(/--.*$/, "");
    const bare = code.replace(/'[^']*'/g, "''").replace(/::/g, "");
    if (/(^|[^:\w]):(['"][a-z_]+['"]|\{\?)/i.test(code) || /(^|[^:\w]):[a-z_]+/i.test(bare)) {
      throw new Error(`Line ${i + 1}: untranslated psql variable in: ${line.trim()}`);
    }

    if (endsTransaction(sql) && out.some((l) => /^\s*begin\s*;\s*$/i.test(l))) {
      placeReport();
    }
    out.push(sql);
    const opened = openDollarTag(line);
    if (opened !== null) dollarTag = opened;
  }
  if (stack.length > 0) throw new Error("Unterminated \\if block");
  if (!reportPlaced) throw new Error("The script never ended its transaction");
  return finish(out);
}

/** The dollar-quote tag a line leaves open, if any: the first tag on the line that appears an odd number of times. */
function openDollarTag(line: string): string | null {
  const code = line.replace(/--.*$/, "").replace(/'[^']*'/g, "''");
  for (const tag of new Set(code.match(/\$[a-z_]*\$/gi) ?? [])) {
    if (code.split(tag).length % 2 === 0) return tag;
  }
  return null;
}

function finish(out: string[]): string {
  return `${out.join("\n").trimEnd()}\n`;
}
