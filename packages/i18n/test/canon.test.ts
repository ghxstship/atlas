import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CANON_SOURCE,
  canonLabelDrift,
  definedCanonLabels,
  flattenLabels,
  readCanonLabels,
  renderPutCanonLabels,
  unknownCodes,
} from "../src/canon.ts";
import { loadSetup } from "../src/translation/config.ts";

/**
 * Canon label translations (Section 15, ADR 0053): the label files, the pipeline's canon surface and the
 * migrations that load them into xpms.canon_label agree.
 */

const root = fileURLToPath(new URL("../../../", import.meta.url));
const migrationsDir = join(root, "supabase/migrations");
const migrations = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(migrationsDir, f), "utf8"));
const files = readCanonLabels(root);
const source = files.get(CANON_SOURCE) ?? new Map();

describe("canon label files", () => {
  it("hold an en-US file for every vocabulary xpms.canon_vocabulary registers", () => {
    const registry = readFileSync(join(migrationsDir, "1541_canon_label_translations.sql"), "utf8");
    const registered = [...registry.matchAll(/^ {2}\('([A-Za-z]+)', \d+, 'xpms\./gm)].map(
      (m) => m[1],
    );
    expect(registered.length).toBe(20);
    expect([...source.keys()].sort()).toEqual([...registered].sort());
    for (const [vocabulary, labels] of source) {
      expect(flattenLabels(labels).size, vocabulary).toBeGreaterThan(0);
    }
  });

  it("translate only codes the en-US source has, and never a code itself", () => {
    for (const [locale, vocabularies] of files) {
      if (locale === CANON_SOURCE) continue;
      for (const [vocabulary, labels] of vocabularies) {
        expect(source.has(vocabulary), `${locale}/${vocabulary}`).toBe(true);
        expect(
          unknownCodes(source.get(vocabulary) ?? {}, labels),
          `${locale}/${vocabulary}`,
        ).toEqual([]);
      }
    }
  });

  it("seed es-US from the labels the app catalogs held for canon codes", () => {
    const es = files.get("es-US");
    expect([...(es?.keys() ?? [])].sort()).toEqual([
      "phase",
      "recordClass",
      "recordKind",
      "recordState",
      "recordSubtype",
      "workerClassification",
    ]);
    const projects = JSON.parse(
      readFileSync(join(root, "packages/i18n/messages/es-US/projects.json"), "utf8"),
    ) as { phases: Record<string, string> };
    expect(es?.get("phase")).toEqual(projects.phases);
  });

  it("are a partial surface of the translation pipeline in every target", () => {
    const setup = loadSetup(root);
    const canon = setup.config.surfaces.find((s) => s.id === "canon");
    expect(canon).toMatchObject({ kind: "catalog", partial: true });
    for (const t of setup.config.targets) {
      expect(!t.surfaces || t.surfaces.includes("canon"), t.locale).toBe(true);
    }
  });
});

describe("canon labels in the database", () => {
  it("are loaded by the migrations exactly as the files hold them (run canon:sql otherwise)", () => {
    const drift = canonLabelDrift(files, migrations).map((d) => `${d.locale}/${d.vocabulary}`);
    expect(
      drift,
      "pnpm --filter @xos/i18n canon:sql prints the statements for a new migration",
    ).toEqual([]);
  });

  it("round-trip through the statement migrations carry", () => {
    const labels = { SCP: "Alcance d'abord", X: { Y: "Zeta" } };
    const statement = renderPutCanonLabels("phase", "fr-FR", "human", labels);
    expect(statement).toBe(
      `select xpms.put_canon_labels('phase', 'fr-FR', 'human', '{"SCP":"Alcance d''abord","X":{"Y":"Zeta"}}'::jsonb);`,
    );
    expect(definedCanonLabels([statement]).get("phase|fr-FR")).toEqual(labels);
    expect([...flattenLabels(labels)]).toEqual([
      ["SCP", "Alcance d'abord"],
      ["X/Y", "Zeta"],
    ]);
    const changed = new Map([["fr-FR", new Map([["phase", { SCP: "Portée" }]])]]);
    expect(canonLabelDrift(changed, [statement]).map((d) => d.vocabulary)).toEqual(["phase"]);
    expect(
      canonLabelDrift(new Map([["fr-FR", new Map([["phase", labels]])]]), [statement]),
    ).toEqual([]);
  });
});
