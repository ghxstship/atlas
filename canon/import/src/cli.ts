import { readFileSync, writeFileSync } from "node:fs";
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
      glChart: inputs.glChart,
      files: inputs.sha,
    },
    new Findings(),
  );
  const counts = validateCounts(model.counts, model.generated);
  failures.push(...model.problems, ...countFailures(counts));
  for (const c of counts)
    console.log(`${c.ok ? "ok  " : "FAIL"} ${c.entity}: ${c.parsed} (expected ${c.expected})`);
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
  default:
    console.error(`Unknown command "${command}". Commands: manifest, check.`);
    process.exitCode = 2;
}
