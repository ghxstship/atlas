import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mergeColumnMap, readColumnMap, writeColumnMap } from "./playbook/column-map.ts";
import { checkLedger, localDatabaseUrl, readLedger, roundTripReport } from "./ledger.ts";
import { roundTrip } from "./roundtrip.ts";
import { join } from "node:path";
import { countFailures, validateCounts } from "./counts.ts";
import { Findings } from "./doctrine.ts";
import { loadInputs } from "./inputs.ts";
import {
  buildFileManifest,
  buildPlaybookManifest,
  toJson,
  verifyFileManifest,
} from "./manifest.ts";
import type { FileManifest } from "./manifest.ts";
import { generateCanon, generateOptions, staleFiles, writeGenerated } from "./generate.ts";
import { buildCanonModel } from "./model/bible-model.ts";
import { defaultRoot, repoPaths } from "./paths.ts";
import type { RepoPaths } from "./paths.ts";
import { sourceByRole } from "./sources.ts";

async function writeManifests(paths: RepoPaths): Promise<void> {
  const files = buildFileManifest(paths.canonSource);
  writeFileSync(join(paths.canonSource, "MANIFEST.json"), toJson(files));
  const inputs = await loadInputs(paths);
  const manifest = buildPlaybookManifest(
    inputs.playbook,
    sourceByRole("playbook").file,
    inputs.sha.playbook,
  );
  writeFileSync(join(paths.canonSource, "PLAYBOOK_MANIFEST.json"), toJson(manifest));
  console.log(
    `Wrote MANIFEST.json (${files.files.length} files) and PLAYBOOK_MANIFEST.json (${manifest.sheets.length} sheets).`,
  );
}

/** Hash check and count validation; exits non-zero on any failure. */
async function check(paths: RepoPaths): Promise<number> {
  const recorded = JSON.parse(
    readFileSync(join(paths.canonSource, "MANIFEST.json"), "utf8"),
  ) as FileManifest;
  const failures = verifyFileManifest(recorded, paths.canonSource);
  const inputs = await loadInputs(paths);
  const model = buildCanonModel(
    {
      bible: inputs.bible,
      itemCatalog: inputs.itemCatalog,
      rulings: inputs.rulings,
      glChart: inputs.glChart,
      files: inputs.sha,
    },
    new Findings(),
  );
  const counts = validateCounts(model.counts, model.generated);
  failures.push(...model.problems, ...countFailures(counts));
  for (const c of counts)
    console.log(`${c.ok ? "ok  " : "FAIL"} ${c.entity}: ${c.parsed} (expected ${c.expected})`);
  if (failures.length === 0) {
    // Generated files must match a fresh run; a Playbook to Bible difference fails the build (Section 2.1).
    const result = generateCanon(inputs, generateOptions(paths));
    for (const f of staleFiles(paths, result.files))
      failures.push(`${f} is stale: run canon:generate`);
    if (result.diff.length > 0) {
      failures.push(
        `${result.diff.length} Playbook to Bible differences await an owner decision; see canon/reports/playbook-bible-diff.md`,
      );
    }
    for (const r of result.reference) {
      if (r.missing.length + r.extra.length > 0)
        failures.push(`Reference model table ${r.table} differs from the reference seed`);
    }
  }
  for (const f of failures) console.error(f);
  return failures.length === 0 ? 0 : 1;
}

const command = process.argv[2] ?? "check";
const paths = repoPaths(defaultRoot());
switch (command) {
  case "manifest":
    await writeManifests(paths);
    break;
  case "check":
    process.exitCode = await check(paths);
    break;
  case "generate": {
    const result = generateCanon(await loadInputs(paths), generateOptions(paths));
    writeGenerated(paths, result.files);
    for (const f of result.files) console.log(`wrote ${f.path}`);
    console.log(`${result.findings.items.length} findings recorded`);
    break;
  }
  case "roundtrip": {
    const out = join(paths.canonReports, "roundtrip");
    mkdirSync(out, { recursive: true });
    const diffs = await roundTrip(
      process.env["CANON_DB_URL"] ?? localDatabaseUrl(paths),
      join(paths.canonSource, sourceByRole("playbook").file),
      join(out, "playbook-export.xlsx"),
      "Cover Page",
    );
    const ledger = readLedger(paths);
    const result = checkLedger(diffs, ledger);
    writeFileSync(join(out, "roundtrip-report.md"), roundTripReport(diffs, result));
    for (const d of result.unexplained) {
      console.error(
        `${d.sheet} ${d.column}${d.row} ${d.header}: source "${d.source}", database "${d.database}"`,
      );
    }
    for (const e of result.stale)
      console.error(`Ledger entry no longer observed: ${e.sheet} ${e.cell}`);
    console.log(
      `Round trip: ${diffs.length} differing cells, ${diffs.length - result.unexplained.length} explained by owner rulings, ${result.unexplained.length} unexplained, ${result.stale.length} stale ledger entries.`,
    );
    process.exitCode = result.unexplained.length === 0 && result.stale.length === 0 ? 0 : 1;
    break;
  }
  case "map": {
    const target = join(paths.canonMap, "playbook-columns.yaml");
    const existing = existsSync(target) ? readColumnMap(readFileSync(target, "utf8")) : null;
    const inputs = await loadInputs(paths);
    mkdirSync(paths.canonMap, { recursive: true });
    writeFileSync(target, writeColumnMap(mergeColumnMap(existing, inputs.playbook)));
    console.log(`wrote ${target}`);
    break;
  }
  default:
    console.error(`Unknown command "${command}". Commands: manifest, check, generate, map.`);
    process.exitCode = 2;
}
