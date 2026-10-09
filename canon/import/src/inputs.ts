import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCsv } from "./csv.ts";
import type { CsvTable } from "./csv.ts";
import { sha256 } from "./manifest.ts";
import type { RepoPaths } from "./paths.ts";
import { loadRulings } from "./rulings.ts";
import type { Rulings } from "./rulings.ts";
import { sourceByRole } from "./sources.ts";
import { readWorkbook } from "./workbook.ts";
import type { WorkbookData } from "./workbook.ts";

export interface LoadedInputs {
  readonly bible: WorkbookData;
  readonly playbook: WorkbookData;
  readonly itemCatalog: CsvTable;
  readonly glChart: CsvTable;
  readonly rulings: Rulings;
  readonly sha: {
    readonly bible: string;
    readonly playbook: string;
    readonly itemCatalog: string;
    readonly glChart: string;
  };
}

function bytes(paths: RepoPaths, role: Parameters<typeof sourceByRole>[0]): Buffer {
  return readFileSync(join(paths.canonSource, sourceByRole(role).file));
}

export async function loadInputs(paths: RepoPaths): Promise<LoadedInputs> {
  const item = bytes(paths, "item-catalog");
  const gl = bytes(paths, "gl-chart");
  const bibleBytes = bytes(paths, "bible");
  const playbookBytes = bytes(paths, "playbook");
  const [bible, playbook] = await Promise.all([
    readWorkbook(join(paths.canonSource, sourceByRole("bible").file)),
    readWorkbook(join(paths.canonSource, sourceByRole("playbook").file)),
  ]);
  return {
    bible,
    playbook,
    itemCatalog: parseCsv(item.toString("utf8")),
    glChart: parseCsv(gl.toString("utf8")),
    rulings: loadRulings(join(paths.root, "canon")),
    sha: {
      bible: sha256(bibleBytes),
      playbook: sha256(playbookBytes),
      itemCatalog: sha256(item),
      glChart: sha256(gl),
    },
  };
}
