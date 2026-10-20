/**
 * Pipeline configuration: translation/config.json (locales, Google settings, surfaces, prices),
 * translation/terms.json (do-not-translate list and checked terminology rules) and
 * translation/glossary.csv (the glossary uploaded to Google). Paths are relative to the repository root.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DoNotTranslate, PatternSpec } from "./protect.ts";

export interface TargetLocale {
  /** The catalog locale, for example es-US. */
  readonly locale: string;
  /** The language code Google is given for it, for example es-US (Translation LLM) or es (NMT). */
  readonly google: string;
}

export type SurfaceKind = "catalog" | "markdown" | "text";

export interface SurfaceConfig {
  readonly id: string;
  readonly kind: SurfaceKind;
  /** Directory of one locale, with `{locale}` standing for the locale code. */
  readonly path: string;
  /** File extension of the surface's files, for markdown and text surfaces. */
  readonly extension?: string;
  /** Front matter keys whose values are translated (markdown). */
  readonly frontMatter?: readonly string[];
}

export interface PipelineConfig {
  readonly source: { readonly locale: string; readonly google: string };
  readonly targets: readonly TargetLocale[];
  readonly google: {
    readonly location: string;
    readonly model: string;
    readonly glossaryPrefix: string;
    readonly contextualGlossary: boolean;
    readonly batch: {
      readonly maxSegments: number;
      readonly maxCodePoints: number;
      readonly concurrency: number;
    };
  };
  readonly pricing: {
    readonly currency: string;
    readonly inputPerMillion: number;
    readonly outputPerMillion: number;
    /** Expected target length over source length, for models that bill output characters. */
    readonly outputRatio: number;
    readonly checked: string;
  };
  readonly surfaces: readonly SurfaceConfig[];
  readonly memoryDir: string;
  readonly review: { readonly locale: string; readonly reportDir: string };
  readonly check: { readonly stale: "warning" | "error" };
}

export interface TargetRule {
  readonly require?: PatternSpec;
  readonly forbid?: readonly PatternSpec[];
}

export interface TermRule {
  readonly id: string;
  readonly description: string;
  /** The rule applies to keys whose en-US literal text matches this pattern. */
  readonly source?: PatternSpec;
  /** And to these keys. */
  readonly keys?: readonly string[];
  /** Keys excluded; `@rule-id` excludes the keys of another rule. */
  readonly except?: readonly string[];
  readonly targets: Readonly<Record<string, TargetRule>>;
  /** False: keys this rule applies to are sent to Google without the glossary. */
  readonly googleGlossary?: boolean;
}

export interface Terms {
  readonly doNotTranslate: DoNotTranslate;
  readonly rules: readonly TermRule[];
}

export interface Glossary {
  readonly csv: string;
  /** Google language codes, in column order. */
  readonly languages: readonly string[];
  readonly rows: ReadonlyArray<Readonly<Record<string, string>>>;
  /** Short hash of the CSV: changes whenever the glossary changes. */
  readonly version: string;
}

export interface Setup {
  readonly root: string;
  readonly config: PipelineConfig;
  readonly terms: Terms;
  readonly glossary: Glossary;
}

export const CONFIG_DIR = "packages/i18n/translation";

export function shortHash(text: string, length = 16): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, length);
}

/** Parses RFC 4180 CSV: comma separated, double quotes around fields that need them. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? "";
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

/** Columns Google accepts in an equivalent term set glossary besides language codes. */
const GLOSSARY_EXTRA_COLUMNS = new Set(["pos", "description"]);

export function parseGlossary(csv: string): Glossary {
  const [header = [], ...body] = parseCsv(csv);
  const languages = header.filter((h) => !GLOSSARY_EXTRA_COLUMNS.has(h));
  const rows = body.map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""])));
  return { csv, languages, rows, version: shortHash(csv, 8) };
}

/** The Google glossary resource id for this glossary version, for example xos-glossary-1a2b3c4d. */
export function glossaryId(setup: Pick<Setup, "config" | "glossary">): string {
  return `${setup.config.google.glossaryPrefix}-${setup.glossary.version}`;
}

/**
 * The cache generation: the model, the glossary version and the contextual glossary switch.
 * A change to any of them makes every cached translation a miss.
 */
export function engineVersion(setup: Pick<Setup, "config" | "glossary">): string {
  const g = setup.config.google;
  return shortHash(`${g.model}\n${setup.glossary.version}\n${g.contextualGlossary}`, 8);
}

export function loadSetup(root: string): Setup {
  const read = (file: string) => readFileSync(join(root, CONFIG_DIR, file), "utf8");
  const config = JSON.parse(read("config.json")) as PipelineConfig;
  const terms = JSON.parse(read("terms.json")) as Terms;
  const glossary = parseGlossary(read("glossary.csv"));
  validateSetup(config, glossary);
  return { root, config, terms, glossary };
}

function validateSetup(config: PipelineConfig, glossary: Glossary): void {
  const problems: string[] = [];
  if (!glossary.languages.includes(config.source.google))
    problems.push(`glossary.csv has no ${config.source.google} column`);
  for (const t of config.targets) {
    if (t.locale === config.source.locale) problems.push(`${t.locale} is the source locale`);
    if (!glossary.languages.includes(t.google))
      problems.push(`glossary.csv has no ${t.google} column for ${t.locale}`);
  }
  const ids = config.surfaces.map((s) => s.id);
  if (new Set(ids).size !== ids.length) problems.push("surface ids repeat");
  for (const s of config.surfaces)
    if (!s.path.includes("{locale}")) problems.push(`surface ${s.id} path has no {locale}`);
  if (problems.length > 0) throw new Error(`translation/config.json: ${problems.join("; ")}.`);
}

export function targetFor(config: PipelineConfig, locale: string): TargetLocale {
  const target = config.targets.find((t) => t.locale === locale);
  if (!target) throw new Error(`${locale} is not a target locale in translation/config.json.`);
  return target;
}

export function regex(spec: PatternSpec, extra = ""): RegExp {
  return new RegExp(spec.pattern, `${(spec.flags ?? "").replace(/[gy]/g, "")}u${extra}`);
}
