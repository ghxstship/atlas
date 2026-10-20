/**
 * Demo seed marker block for infra/production/remove-demo-data.sql (runbook:
 * infra/runbooks/promote-to-production.md).
 *
 *   generate              Re-read supabase/seeds/*.sql and rewrite the marker block in the SQL file.
 *   check                 Exit 1 when the block no longer matches the seeds (the test suite checks it too).
 *   delete-storage <csv>  Delete the objects the dry run listed through the Storage API, with SUPABASE_URL
 *                         and SUPABASE_SERVICE_ROLE_KEY from the environment (remove-demo-data.sh runs it).
 *   compare <no-seed> <target>
 *                         Compare two table-counts.sql outputs; exit 1 when a data table differs.
 *
 * generate and check read and write repository files only; neither connects to anything.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  deriveSeedMarkers,
  extractMarkerBlock,
  renderMarkerBlock,
  replaceMarkerBlock,
  unsafeDomains,
} from "./seed-markers.ts";
import { compareCounts, formatDifferences, parseCounts } from "./compare.ts";
import { deleteObjects, parseObjectList } from "./storage.ts";

const seedDir = fileURLToPath(new URL("../../../supabase/seeds/", import.meta.url));
const sqlPath = fileURLToPath(new URL("../remove-demo-data.sql", import.meta.url));

const markers = deriveSeedMarkers(
  readdirSync(seedDir)
    .filter((name) => name.endsWith(".sql"))
    .map((name) => ({ name, sql: readFileSync(`${seedDir}${name}`, "utf8") })),
);
const unsafe = unsafeDomains(markers);
if (unsafe.length > 0) {
  console.error(`Seeds use non-test email domains: ${unsafe.join(", ")}. Fix the seeds first.`);
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
  default:
    console.error("Usage: generate | check | delete-storage <csv> | compare <no-seed> <target>");
    process.exit(2);
}
