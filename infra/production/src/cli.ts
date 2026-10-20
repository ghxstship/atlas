/**
 * Demo seed marker block for infra/production/remove-demo-data.sql (runbook:
 * infra/runbooks/promote-to-production.md).
 *
 *   generate              Re-read the marker sources (supabase/seeds, the load fixtures) and rewrite the
 *                         marker block in the SQL file.
 *   check                 Exit 1 when the block no longer matches the seeds (the test suite checks it too).
 *   delete-storage <csv>  Delete the objects the dry run listed through the Storage API, with SUPABASE_URL
 *                         and SUPABASE_SERVICE_ROLE_KEY from the environment (remove-demo-data.sh runs it).
 *   compare <no-seed> <target>
 *                         Compare two table-counts.sql outputs; exit 1 when a data table differs.
 *   linked <dry-run|rehearse|execute> [--confirm REF] [--log DIR]
 *                         Run the removal against the linked hosted project through the Supabase CLI's login
 *                         (`supabase db query --linked`, `supabase storage rm --linked`): no database password
 *                         and no service role key. execute needs --confirm with the linked project ref.
 *   plain-sql <mode>      Print the removal script translated to plain SQL for one mode (what `linked` runs).
 *
 * generate and check read and write repository files only; neither connects to anything.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deriveSeedMarkers,
  extractMarkerBlock,
  readMarkerSources,
  renderMarkerBlock,
  replaceMarkerBlock,
  unsafeDomains,
} from "./seed-markers.ts";
import { compareCounts, formatDifferences, parseCounts } from "./compare.ts";
import { deleteObjects, parseObjectList } from "./storage.ts";
import {
  deleteStorageLinked,
  formatDryRun,
  formatRun,
  linkedProjectRef,
  runLinked,
  type DryRunReport,
  type RunReport,
} from "./linked.ts";
import { toPlainSql, type RemovalMode } from "./plain-sql.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const sqlPath = fileURLToPath(new URL("../remove-demo-data.sql", import.meta.url));

const markers = deriveSeedMarkers(readMarkerSources(repoRoot));
const unsafe = unsafeDomains(markers);
if (unsafe.length > 0) {
  console.error(
    `Test data uses non-test email domains: ${unsafe.join(", ")}. Fix the seeds first.`,
  );
  process.exit(1);
}
const block = renderMarkerBlock(markers);
const sql = readFileSync(sqlPath, "utf8");

switch (process.argv[2]) {
  case "generate":
    writeFileSync(sqlPath, replaceMarkerBlock(sql, block));
    console.log(
      `Marker block rewritten: ${markers.ids.length} ids, ${markers.domains.join(", ")}, ${markers.tables.length} tables.`,
    );
    break;
  case "check":
    if (extractMarkerBlock(sql) !== block) {
      console.error(
        "remove-demo-data.sql is out of date with supabase/seeds. Run: pnpm --filter @xos/infra demo-markers",
      );
      process.exit(1);
    }
    console.log("Marker block matches the seeds.");
    break;
  case "delete-storage": {
    const list = process.argv[3];
    const url = process.env["SUPABASE_URL"];
    const serviceKey = process.env["SUPABASE_SERVICE_ROLE_KEY"];
    if (!list || !url || !serviceKey) {
      console.error(
        "Usage: delete-storage <csv>, with SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY set.",
      );
      process.exit(2);
    }
    const objects = parseObjectList(readFileSync(list, "utf8"));
    const result = await deleteObjects(objects, { url, serviceKey });
    console.log(`Storage objects: ${result.requested} requested, ${result.deleted} deleted.`);
    if (result.deleted !== result.requested) process.exit(1);
    break;
  }
  case "compare": {
    const [baselinePath, targetPath] = process.argv.slice(3);
    if (!baselinePath || !targetPath) {
      console.error("Usage: compare <no-seed counts> <target counts>");
      process.exit(2);
    }
    const differences = compareCounts(
      parseCounts(readFileSync(baselinePath, "utf8")),
      parseCounts(readFileSync(targetPath, "utf8")),
    );
    console.log(formatDifferences(differences));
    if (differences.some((difference) => !difference.runtime)) process.exit(1);
    break;
  }
  case "plain-sql": {
    const mode = process.argv[3] as RemovalMode;
    process.stdout.write(toPlainSql(sql, mode));
    break;
  }
  case "linked": {
    const mode = process.argv[3] as RemovalMode;
    if (!["dry-run", "rehearse", "execute"].includes(mode)) {
      console.error("Usage: linked <dry-run|rehearse|execute> [--confirm REF] [--log DIR]");
      process.exit(2);
    }
    const flag = (name: string) => {
      const at = process.argv.indexOf(name);
      return at > 0 ? process.argv[at + 1] : undefined;
    };
    const ref = linkedProjectRef(repoRoot);
    if (mode === "execute" && flag("--confirm") !== ref) {
      console.error(`execute needs --confirm ${ref} (the linked project you are about to change).`);
      process.exit(2);
    }
    const logDir = flag("--log") ?? process.cwd();
    mkdirSync(logDir, { recursive: true });
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d+Z$/, "Z");
    const keep = (name: string, value: unknown) =>
      writeFileSync(
        join(logDir, `remove-demo-data-${name}-${stamp}.json`),
        `${JSON.stringify(value, null, 2)}\n`,
      );
    console.log(`remove-demo-data: ${mode} against linked project ${ref}; reports in ${logDir}`);

    const dry = runLinked<DryRunReport>(sql, "dry-run", repoRoot);
    keep("dry-run", dry);
    console.log(formatDryRun(dry));
    if (mode === "dry-run") break;
    if (dry.rows_in_other_orgs.length > 0) {
      console.error("Rows of orgs that are not being removed were reached; nothing was changed.");
      process.exit(1);
    }
    if (mode === "execute" && dry.storage_objects.length > 0) {
      const objects = dry.storage_objects.map((o) => ({ bucket: o.bucket_id, name: o.name }));
      console.log(`Storage objects deleted: ${deleteStorageLinked(objects, repoRoot)}`);
    }
    const run = runLinked<RunReport>(sql, mode, repoRoot);
    keep(mode, run);
    console.log(formatRun(run));
    if (mode === "execute") {
      const after = runLinked<DryRunReport>(sql, "dry-run", repoRoot);
      keep("dry-run-after", after);
      console.log(
        `Second dry run: ${after.orgs_to_remove.length} orgs, ${after.sign_ins_to_remove.users} sign-ins, ${after.totals.rows_to_delete} rows left.`,
      );
      if (
        after.orgs_to_remove.length + after.sign_ins_to_remove.users + after.totals.rows_to_delete >
        0
      )
        process.exit(1);
    }
    break;
  }
  default:
    console.error(
      "Usage: generate | check | delete-storage <csv> | compare <no-seed> <target> | linked <mode> | plain-sql <mode>",
    );
    process.exit(2);
}
