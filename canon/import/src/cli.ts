import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildFileManifest, buildPlaybookManifest, toJson } from "./manifest.ts";
import { defaultRoot, repoPaths } from "./paths.ts";
import { sourceByRole } from "./sources.ts";
import { readWorkbook } from "./workbook.ts";

async function writeManifests(root: string): Promise<void> {
  const paths = repoPaths(root);
  const files = buildFileManifest(paths.canonSource);
  writeFileSync(join(paths.canonSource, "MANIFEST.json"), toJson(files));
  const playbook = sourceByRole("playbook");
  const entry = files.files.find((f) => f.file === playbook.file);
  if (!entry) throw new Error("Playbook missing from the file manifest");
  const workbook = await readWorkbook(join(paths.canonSource, playbook.file));
  const manifest = buildPlaybookManifest(workbook, playbook.file, entry.sha256);
  writeFileSync(join(paths.canonSource, "PLAYBOOK_MANIFEST.json"), toJson(manifest));
  for (const s of manifest.sheets) {
    console.log(`${s.name}: ${s.columns.length} columns, ${s.data_row_count} rows`);
  }
}

const command = process.argv[2] ?? "manifest";
if (command === "manifest") {
  await writeManifests(defaultRoot());
} else {
  console.error(`Unknown command ${command}`);
  process.exit(2);
}
