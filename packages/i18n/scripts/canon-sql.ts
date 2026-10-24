/**
 * Prints the `xpms.put_canon_labels` statements that load the canon label translations into the database
 * (Section 15, ADR 0053). Paste them into a new migration in your range after a translation run changes
 * packages/i18n/canon/<locale>/; packages/i18n/test/canon.test.ts fails until the migrations agree.
 *
 *   pnpm --filter @xos/i18n canon:sql           only the vocabularies the migrations do not load yet
 *   pnpm --filter @xos/i18n canon:sql --all     every translated vocabulary
 *
 * Provenance: "machine" when the translation memory records Google for any of the vocabulary's labels in
 * that locale, otherwise "catalog" (copied from the app catalogs) for es-US and "human" for other locales.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANON_SOURCE,
  canonLabelDrift,
  readCanonLabels,
  renderPutCanonLabels,
  type Provenance,
} from "../src/canon.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const migrationsDir = join(root, "supabase/migrations");
const migrations = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(migrationsDir, f), "utf8"));
const files = readCanonLabels(root);

function provenance(locale: string, vocabulary: string): Provenance {
  try {
    const memory = JSON.parse(
      readFileSync(join(root, "packages/i18n/translation/memory", `${locale}.json`), "utf8"),
    ) as { entries?: Record<string, string> };
    const machine = Object.entries(memory.entries ?? {}).some(
      ([id, entry]) => id.startsWith(`${vocabulary}.`) && entry.startsWith("google "),
    );
    if (machine) return "machine";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return locale === "es-US" ? "catalog" : "human";
}

const wanted = process.argv.includes("--all")
  ? [...files]
      .filter(([locale]) => locale !== CANON_SOURCE)
      .flatMap(([locale, vocabularies]) =>
        [...vocabularies]
          .filter(([, labels]) => Object.keys(labels).length > 0)
          .map(([vocabulary, labels]) => ({ vocabulary, locale, labels })),
      )
  : canonLabelDrift(files, migrations);

if (wanted.length === 0) {
  console.error("Every canon label file is already loaded by a migration.");
} else {
  for (const { vocabulary, locale, labels } of wanted) {
    console.log(renderPutCanonLabels(vocabulary, locale, provenance(locale, vocabulary), labels));
  }
}
