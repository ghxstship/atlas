import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { generateCanon, staleFiles, writeGenerated } from "../src/generate.ts";
import type { GenerateResult } from "../src/generate.ts";
import { loadInputs } from "../src/inputs.ts";
import type { LoadedInputs } from "../src/inputs.ts";
import { repoPaths } from "../src/paths.ts";
import { PATHS, tempDir } from "./helpers.ts";

let inputs: LoadedInputs;
let first: GenerateResult;

beforeAll(async () => {
  inputs = await loadInputs(PATHS);
  first = generateCanon(inputs);
});

describe("generateCanon", () => {
  it("is byte-identical on re-run", () => {
    const second = generateCanon(inputs);
    expect(second.files.map((f) => f.content)).toEqual(first.files.map((f) => f.content));
  });

  it("matches the committed migrations", () => {
    expect(staleFiles(PATHS, first.files)).toEqual([]);
  });

  it("reports a missing or changed file as stale and writes files", () => {
    const dir = repoPaths(tempDir());
    expect(staleFiles(dir, first.files).length).toBe(first.files.filter((f) => f.committed).length);
    writeGenerated(dir, first.files);
    expect(staleFiles(dir, first.files)).toEqual([]);
    const target = first.files[0];
    if (!target) throw new Error("nothing generated");
    expect(readFileSync(join(dir.root, target.path), "utf8")).toBe(target.content);
  });

  it("validates every count and records doctrine findings", () => {
    expect(first.counts.every((c) => c.ok)).toBe(true);
    expect(first.findings.ofKind("em-dash-substituted").length).toBeGreaterThan(0);
    expect(first.findings.ofKind("guard-reserved-word").length).toBeGreaterThan(0);
  });

  it("stops on count mismatches and hard problems", () => {
    const broken = {
      ...inputs,
      itemCatalog: { ...inputs.itemCatalog, records: inputs.itemCatalog.records.slice(1) },
    };
    expect(() => generateCanon(broken)).toThrow(
      /Canon import stopped:\nBible tab 32 item .* is not in the Item Catalog CSV/,
    );
  });
});
