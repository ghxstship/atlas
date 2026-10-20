/**
 * Machine translation with Google Cloud Translation (ADR 0037).
 *
 *   pnpm --filter @xos/i18n translate [--dry-run] [--locale es-US] [--surface catalogs]
 *       Fills missing targets and re-translates stale ones in every target locale.
 *   pnpm --filter @xos/i18n translate:review [--dry-run] [--no-apply] [--locale es-US]
 *       Translates every en-US string fresh, compares it with the current target and writes the
 *       report to docs/i18n/review/<locale>/; applies Google's version unless --no-apply.
 *   pnpm --filter @xos/i18n translate:all [--dry-run]
 *       glossary (when missing), translate, review: the owner's first run.
 *   pnpm --filter @xos/i18n translate:glossary [--dry-run] [--prune]
 *       Uploads translation/glossary.csv to Google.
 *   pnpm --filter @xos/i18n translate:check [--strict]
 *       The offline check that pnpm verify also runs.
 *   pnpm --filter @xos/i18n translate:lock <key...> [--locale es-US] [--unlock]
 *
 * Network commands read GOOGLE_CLOUD_PROJECT (and GOOGLE_TRANSLATE_GLOSSARY_BUCKET for the glossary)
 * and authenticate with Application Default Credentials. --dry-run never touches the network.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { format as prettierFormat, resolveConfig } from "prettier";
import { formatFindings, runCheck } from "../src/translation/check.ts";
import { glossaryId, loadSetup, type Setup } from "../src/translation/config.ts";
import { uploadGlossary } from "../src/translation/glossary-upload.ts";
import {
  review,
  setLock,
  translate,
  type Context,
  type Cost,
} from "../src/translation/pipeline.ts";
import {
  findTestReferences,
  reviewReport,
  translateReport,
  type RunInfo,
} from "../src/translation/report.ts";
import { readUnits } from "../src/translation/surfaces.ts";
import { adcTokenSource, googleTransport, requireEnv } from "../src/translation/transport.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const argv = process.argv.slice(2);
const command = argv[0] ?? "help";
const flag = (name: string) => argv.includes(name);
const values = (name: string) =>
  argv.flatMap((a, i) => (a === name && argv[i + 1] ? [argv[i + 1] as string] : []));
const positional = argv
  .slice(1)
  .filter(
    (a, i, all) => !a.startsWith("--") && !["--locale", "--surface"].includes(all[i - 1] ?? ""),
  );
const dryRun = flag("--dry-run");
const log = (line: string) => console.log(line);

const PROJECT_EXAMPLE = "xos-translate-123456";
const BUCKET_EXAMPLE = "xos-translate-123456-glossaries";

async function formatter(): Promise<(text: string, file: string) => Promise<string>> {
  const options = (await resolveConfig(join(root, "README.md"))) ?? {};
  return (text, file) => prettierFormat(text, { ...options, filepath: file });
}

function money(setup: Setup, n: number): string {
  return `${setup.config.pricing.currency} ${n.toFixed(2)}`;
}

function describeCost(setup: Setup, cost: Cost): string {
  return `${cost.segments} segments, ${cost.cached} in the translation memory, ${cost.misses} to send: ${cost.characters} characters billed (${cost.textCharacters} of text), estimated ${money(setup, cost.estimate)}`;
}

function context(setup: Setup, withNetwork: boolean, format: Context["format"]): Context {
  const surfaces = values("--surface");
  const base = { setup, log, format, ...(surfaces.length > 0 ? { surfaces } : {}) };
  if (!withNetwork) return base;
  const project = requireEnv(process.env, "GOOGLE_CLOUD_PROJECT", PROJECT_EXAMPLE);
  const transport = googleTransport({
    project,
    location: setup.config.google.location,
    model: setup.config.google.model,
    sourceLanguage: setup.config.source.google,
    glossaryId: glossaryId(setup),
    contextualGlossary: setup.config.google.contextualGlossary,
    token: adcTokenSource(process.env),
  });
  return { ...base, transport };
}

function info(setup: Setup): RunInfo {
  return {
    date: new Date().toISOString().slice(0, 10),
    model: setup.config.google.model,
    glossary: glossaryId(setup),
  };
}

async function runTranslate(setup: Setup): Promise<boolean> {
  const format = await formatter();
  const locales = values("--locale");
  const results = await translate(
    context(setup, !dryRun, format),
    locales.length > 0 ? locales : undefined,
  );
  let ok = true;
  for (const r of results) {
    log(`${r.locale} translate${r.dryRun ? " (dry run, no network)" : ""}:`);
    for (const [surface, c] of Object.entries(r.counts)) {
      log(
        `  ${surface}: ${
          Object.entries(c)
            .filter(([, n]) => n > 0)
            .map(([s, n]) => `${n} ${s}`)
            .join(", ") || "nothing"
        }`,
      );
    }
    log(`  ${r.selected} missing or stale; ${describeCost(setup, r.cost)}`);
    if (r.lockedStale.length > 0)
      log(`  ${r.lockedStale.length} locked strings changed in en-US: update them by hand`);
    if (!r.dryRun) {
      const tests = findTestReferences(root, r.changes);
      const file = join(root, dirname(setup.config.review.reportDir), `translate-${r.locale}.md`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, await format(translateReport(r, tests, info(setup)), file));
      log(
        `  ${r.changes.length} changed, ${r.failures.length} failed; report ${file.slice(root.length)}`,
      );
      if (r.failures.length > 0) ok = false;
    }
  }
  return ok;
}

async function runReview(setup: Setup): Promise<boolean> {
  const format = await formatter();
  const locale = values("--locale")[0] ?? setup.config.review.locale;
  const r = await review(context(setup, !dryRun, format), locale, !flag("--no-apply"));
  log(
    `${locale} review${r.dryRun ? " (dry run, no network)" : ""}: ${r.units} strings and files; ${describeCost(setup, r.cost)}`,
  );
  if (r.dryRun) return true;
  const totals = new Map<string, number>();
  for (const surface of setup.config.surfaces) {
    for (const u of readUnits(root, surface, setup.config.source.locale, locale)) {
      const name = surface.kind === "catalog" ? u.file.replace(/\.json$/, "") : surface.id;
      totals.set(name, (totals.get(name) ?? 0) + 1);
    }
  }
  const tests = findTestReferences(
    root,
    r.items
      .filter((i) => i.decision.startsWith("applied"))
      .map((i) => ({ id: i.id, before: i.current })),
  );
  const dir = join(root, setup.config.review.reportDir, locale);
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of reviewReport(r, totals, tests, info(setup))) {
    writeFileSync(join(dir, name), await format(text, join(dir, name)));
  }
  log(`  ${r.items.length} differ; report ${dir.slice(root.length)}/README.md`);
  return true;
}

async function runGlossary(setup: Setup): Promise<boolean> {
  const id = glossaryId(setup);
  if (dryRun) {
    log(
      `Would upload glossary.csv (${setup.glossary.rows.length} rows, ${setup.glossary.languages.join(", ")}) as ${id} in ${setup.config.google.location}.`,
    );
    return true;
  }
  await uploadGlossary({
    project: requireEnv(process.env, "GOOGLE_CLOUD_PROJECT", PROJECT_EXAMPLE),
    location: setup.config.google.location,
    bucket: requireEnv(process.env, "GOOGLE_TRANSLATE_GLOSSARY_BUCKET", BUCKET_EXAMPLE),
    glossaryId: id,
    csv: setup.glossary.csv,
    languages: setup.glossary.languages,
    token: adcTokenSource(process.env),
    log,
    ...(flag("--prune") ? { prunePrefix: `${setup.config.google.glossaryPrefix}-` } : {}),
  });
  return true;
}

function runCheckCommand(setup: Setup): boolean {
  const result = runCheck(setup, { strict: flag("--strict") });
  log(formatFindings(result));
  return result.errors.length === 0;
}

function runLock(setup: Setup, locked: boolean): boolean {
  if (positional.length === 0) {
    console.error("Name at least one key, for example translate:lock shell.nav.home.");
    return false;
  }
  const locale = values("--locale")[0] ?? setup.config.review.locale;
  const { changed, unknown } = setLock(setup, locale, positional, locked);
  log(`${locked ? "Locked" : "Unlocked"} ${changed.length} in ${locale}.`);
  for (const id of unknown) console.error(`Unknown key or no ${locale} value: ${id}`);
  return unknown.length === 0;
}

async function main(): Promise<boolean> {
  const setup = loadSetup(root);
  switch (command) {
    case "translate":
      return runTranslate(setup);
    case "review":
      return runReview(setup);
    case "all":
      return (await runGlossary(setup)) && (await runTranslate(setup)) && (await runReview(setup));
    case "glossary":
      return runGlossary(setup);
    case "check":
      return runCheckCommand(setup);
    case "lock":
      return runLock(setup, !flag("--unlock"));
    case "unlock":
      return runLock(setup, false);
    default:
      console.log(
        "Commands: translate, review, all, glossary, check, lock, unlock. See scripts/translate.ts.",
      );
      return command === "help";
  }
}

main().then(
  (ok) => process.exit(ok ? 0 : 1),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
