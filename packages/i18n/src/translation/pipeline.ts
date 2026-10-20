/**
 * translate and review over every configured surface, with an injected transport. Without a
 * transport a run is a dry run: it plans, counts and prices the work and touches neither the network
 * nor any file.
 */
import {
  engineVersion,
  shortHash,
  targetFor,
  type Setup,
  type SurfaceConfig,
  type TargetLocale,
} from "./config.ts";
import { PlanError, compareStructure, literalText, planIcu, type Plan } from "./icu.ts";
import { planMarkdown, planText } from "./markdown.ts";
import {
  loadMemory,
  saveMemory,
  statusOf,
  type Entry,
  type Memory,
  type Status,
} from "./memory.ts";
import { compileProtector, containsWord, type Protector } from "./protect.ts";
import { compileRules, keptDomainTerm, type CompiledRules } from "./rules.ts";
import {
  extraCatalogKeys,
  readUnits,
  writeUnits,
  type Formatter,
  type UnitRecord,
} from "./surfaces.ts";
import type { Transport } from "./transport.ts";

export interface Context {
  readonly setup: Setup;
  /** Undefined: dry run. */
  readonly transport?: Transport;
  readonly log: (line: string) => void;
  /** Formats a written markdown or text file (Prettier in the CLI). */
  readonly format: Formatter;
  /** Limits the run to these surface ids. */
  readonly surfaces?: readonly string[];
}

export interface Cost {
  /** Translatable segments in the selected units. */
  readonly segments: number;
  /** Segments answered from the translation memory. */
  readonly cached: number;
  /** Distinct segments that need the API. */
  readonly misses: number;
  /** Code points sent to Google (markup included, as Google bills it). */
  readonly characters: number;
  /** Code points of visible text in those segments, without markup. */
  readonly textCharacters: number;
  readonly estimate: number;
}

export interface Failure {
  readonly id: string;
  readonly reason: string;
}

export interface TranslateResult {
  readonly locale: string;
  readonly dryRun: boolean;
  readonly counts: Readonly<Record<string, Readonly<Record<Status, number>>>>;
  readonly selected: number;
  readonly cost: Cost;
  readonly written: readonly string[];
  readonly failures: readonly Failure[];
  readonly lockedStale: readonly string[];
  readonly changes: ReadonlyArray<{
    readonly id: string;
    readonly before: string | undefined;
    readonly after: string;
  }>;
}

interface Job {
  readonly unit: UnitRecord;
  readonly plan: Plan;
  readonly glossary: boolean;
  readonly keys: ReadonlyArray<string | null>;
}

interface Tools {
  readonly protector: Protector;
  readonly rules: CompiledRules;
  readonly engine: string;
}

const STATUSES: readonly Status[] = [
  "missing",
  "stale",
  "unreviewed",
  "current",
  "locked",
  "locked-stale",
];

function tools(setup: Setup): Tools {
  return {
    protector: compileProtector(setup.terms.doNotTranslate),
    rules: compileRules(setup.terms),
    engine: engineVersion(setup),
  };
}

export const sourceHash = (unit: Pick<UnitRecord, "source">) => shortHash(unit.source);

function literalOf(unit: Pick<UnitRecord, "format">, text: string): string {
  if (unit.format !== "icu") return text;
  try {
    return literalText(text);
  } catch (error) {
    if (error instanceof Error) return text;
    throw error;
  }
}

function planUnit(unit: UnitRecord, t: Tools): Plan {
  const protect = (text: string) => t.protector.ranges(text, unit.id);
  if (unit.format === "icu") return planIcu(unit.source, protect);
  if (unit.format === "markdown")
    return planMarkdown(unit.source, protect, { frontMatter: unit.surface.frontMatter ?? [] });
  return planText(unit.source, protect);
}

function makeJob(unit: UnitRecord, t: Tools): Job {
  const plan = planUnit(unit, t);
  const glossary = t.rules.usesGlossary(unit.id, literalOf(unit, unit.source));
  const keys = plan.segments.map((s) =>
    s.translatable ? `${t.engine}:${shortHash(`${glossary ? "g" : "n"}\n${s.html}`)}` : null,
  );
  return { unit, plan, glossary, keys };
}

/** Problems with a target value: ICU structure, protected words and terminology rules. */
export function validateTarget(
  unit: Pick<UnitRecord, "id" | "format" | "source">,
  value: string,
  locale: string,
  t: Pick<Tools, "protector" | "rules">,
): string[] {
  const problems: string[] = [];
  let sourceText = unit.source;
  let targetText = value;
  if (unit.format === "icu") {
    try {
      problems.push(...compareStructure(unit.source, value, locale));
      sourceText = literalText(unit.source);
      targetText = literalText(value);
    } catch (error) {
      return [`not valid ICU: ${error instanceof Error ? error.message : String(error)}`];
    }
    problems.push(...t.rules.violations(unit.id, sourceText, locale, targetText));
  }
  for (const word of t.protector.required(sourceText, unit.id)) {
    if (!containsWord(targetText, word)) problems.push(`keeps "${word}" unchanged`);
  }
  if (value.includes("\u2014")) problems.push("contains an em dash");
  return problems;
}

const codePoints = (s: string) => [...s].length;

function priceOf(setup: Setup, characters: number): number {
  const p = setup.config.pricing;
  const estimate =
    (characters / 1e6) * p.inputPerMillion +
    ((characters * p.outputRatio) / 1e6) * p.outputPerMillion;
  return Math.round(estimate * 100) / 100;
}

/** Looks segments up in the memory and, with a transport, translates the misses into it. */
async function fill(
  ctx: Context,
  target: TargetLocale,
  memory: Memory,
  jobs: readonly Job[],
): Promise<Cost> {
  const misses = new Map<string, { html: string; glossary: boolean }>();
  let segments = 0;
  let cached = 0;
  for (const job of jobs) {
    job.keys.forEach((key, i) => {
      if (key === null) return;
      segments += 1;
      if (memory.segments.has(key)) cached += 1;
      else misses.set(key, { html: job.plan.segments[i]?.html ?? "", glossary: job.glossary });
    });
  }
  const list = [...misses];
  const characters = list.reduce((n, [, m]) => n + codePoints(m.html), 0);
  const textCharacters = list.reduce(
    (n, [, m]) => n + codePoints(m.html.replace(/<[^>]*>/g, "")),
    0,
  );
  const cost = {
    segments,
    cached,
    misses: list.length,
    characters,
    textCharacters,
    estimate: priceOf(ctx.setup, characters),
  };
  if (!ctx.transport || list.length === 0) return cost;

  const { maxSegments, maxCodePoints, concurrency } = ctx.setup.config.google.batch;
  const batches: Array<{ glossary: boolean; items: Array<[string, string]> }> = [];
  for (const glossary of [true, false]) {
    let current: Array<[string, string]> = [];
    let size = 0;
    for (const [key, m] of list.filter(([, x]) => x.glossary === glossary)) {
      const n = codePoints(m.html);
      if (current.length > 0 && (current.length >= maxSegments || size + n > maxCodePoints)) {
        batches.push({ glossary, items: current });
        current = [];
        size = 0;
      }
      current.push([key, m.html]);
      size += n;
    }
    if (current.length > 0) batches.push({ glossary, items: current });
  }
  const transport = ctx.transport;
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < batches.length) {
      const batch = batches[next++];
      if (!batch) break;
      const out = await transport.translate({
        contents: batch.items.map(([, html]) => html),
        target: target.google,
        glossary: batch.glossary,
      });
      batch.items.forEach(([key], i) => memory.segments.set(key, out[i] ?? ""));
      done += 1;
      if (done % 10 === 0 || done === batches.length)
        ctx.log(`  ${target.locale}: ${done} of ${batches.length} requests`);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, batches.length)) }, worker),
  );
  return cost;
}

/**
 * Rebuilds a unit from the cached segments and validates it. On failure the unit's segments leave the
 * memory, so the next run asks Google again instead of reusing a rejected answer.
 */
function assemble(
  job: Job,
  memory: Memory,
  locale: string,
  t: Tools,
): { value: string } | { error: string } {
  const outputs = job.keys.map((k) => (k === null ? "" : (memory.segments.get(k) ?? "")));
  const forget = (error: string) => {
    for (const k of job.keys) if (k !== null) memory.segments.delete(k);
    return { error };
  };
  let value: string;
  try {
    value = job.plan.assemble(outputs);
  } catch (error) {
    if (error instanceof PlanError)
      return forget(`Google's markup did not survive: ${error.message}`);
    throw error;
  }
  const problems = validateTarget(job.unit, value, locale, t);
  return problems.length > 0 ? forget(problems.join("; ")) : { value };
}

function selectedSurfaces(ctx: Context): SurfaceConfig[] {
  return ctx.setup.config.surfaces.filter((s) => !ctx.surfaces || ctx.surfaces.includes(s.id));
}

function readAll(ctx: Context, locale: string): UnitRecord[] {
  return selectedSurfaces(ctx).flatMap((s) =>
    readUnits(ctx.setup.root, s, ctx.setup.config.source.locale, locale),
  );
}

function countStatuses(
  units: readonly UnitRecord[],
  statuses: readonly Status[],
): Record<string, Record<Status, number>> {
  const counts: Record<string, Record<Status, number>> = {};
  units.forEach((u, i) => {
    const c = (counts[u.surface.id] ??= Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<
      Status,
      number
    >);
    const s = statuses[i] ?? "missing";
    c[s] += 1;
  });
  return counts;
}

/**
 * Drops memory entries for keys that no longer exist, cached segments of older engines and, when the
 * run covered every surface, cached segments that no current en-US string uses any more.
 */
function prune(
  ctx: Context,
  memory: Memory,
  units: readonly UnitRecord[],
  t: Tools,
  jobs: readonly Job[],
): void {
  const engine = t.engine;
  const surfaces = selectedSurfaces(ctx);
  const ids = new Set(units.map((u) => u.id));
  const catalogIds = surfaces.some((s) => s.kind === "catalog");
  const surfaceIds = new Set(surfaces.map((s) => s.id));
  for (const id of [...memory.entries.keys()]) {
    const slash = id.indexOf("/");
    const mine = slash === -1 ? catalogIds : surfaceIds.has(id.slice(0, slash));
    if (mine && !ids.has(id)) memory.entries.delete(id);
  }
  const live = ctx.surfaces ? null : new Set(jobs.flatMap((j) => j.keys.filter((k) => k !== null)));
  for (const key of [...memory.segments.keys()]) {
    if (!key.startsWith(`${engine}:`) || (live !== null && !live.has(key)))
      memory.segments.delete(key);
  }
}

/** Jobs for every unit whose source can be planned, to know which cached segments are still used. */
function allJobs(units: readonly UnitRecord[], t: Tools): Job[] {
  return units.flatMap((unit) => {
    try {
      return [makeJob(unit, t)];
    } catch (error) {
      if (error instanceof Error) return [];
      throw error;
    }
  });
}

/** Fills missing targets and re-translates stale ones in every target locale (or the given ones). */
export async function translate(
  ctx: Context,
  locales?: readonly string[],
): Promise<TranslateResult[]> {
  const t = tools(ctx.setup);
  const results: TranslateResult[] = [];
  const targets = locales
    ? locales.map((l) => targetFor(ctx.setup.config, l))
    : ctx.setup.config.targets;
  for (const target of targets) {
    const memory = loadMemory(ctx.setup.root, ctx.setup.config, target.locale);
    const units = readAll(ctx, target.locale);
    const statuses = units.map((u) => statusOf(sourceHash(u), u.target, memory.entries.get(u.id)));
    const selected = units.filter((_, i) => statuses[i] === "missing" || statuses[i] === "stale");
    const failures: Failure[] = [];
    const jobs: Job[] = [];
    for (const unit of selected) {
      try {
        jobs.push(makeJob(unit, t));
      } catch (error) {
        failures.push({
          id: unit.id,
          reason: `the en-US source cannot be planned: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    const cost = await fill(ctx, target, memory, jobs);
    const lockedStale = units.filter((_, i) => statuses[i] === "locked-stale").map((u) => u.id);
    const base = {
      locale: target.locale,
      counts: countStatuses(units, statuses),
      selected: selected.length,
      cost,
      lockedStale,
    };
    if (!ctx.transport) {
      results.push({ ...base, dryRun: true, written: [], failures, changes: [] });
      continue;
    }
    const values = new Map<string, string>();
    const changes: Array<{ id: string; before: string | undefined; after: string }> = [];
    for (const job of jobs) {
      const result = assemble(job, memory, target.locale, t);
      const hash = sourceHash(job.unit);
      if ("value" in result) {
        values.set(job.unit.id, result.value);
        memory.entries.set(job.unit.id, { by: "google", source: hash, locked: false });
        if (result.value !== job.unit.target)
          changes.push({ id: job.unit.id, before: job.unit.target, after: result.value });
      } else {
        failures.push({ id: job.unit.id, reason: result.error });
        if (job.unit.target === undefined) {
          values.set(job.unit.id, job.unit.source);
          memory.entries.set(job.unit.id, { by: "fallback", source: hash, locked: false });
        }
      }
    }
    for (const surface of selectedSurfaces(ctx).filter((s) => s.kind === "catalog")) {
      const extra = new Set(
        extraCatalogKeys(
          ctx.setup.root,
          surface,
          ctx.setup.config.source.locale,
          target.locale,
        ).map((id) => id.split(".")[0]),
      );
      for (const ns of extra) {
        const unit = units.find(
          (u) => u.surface.id === surface.id && u.file === `${ns}.json` && u.target !== undefined,
        );
        if (unit && !values.has(unit.id)) values.set(unit.id, unit.target ?? unit.source);
      }
    }
    prune(ctx, memory, units, t, allJobs(units, t));
    const written: string[] = [];
    for (const surface of selectedSurfaces(ctx)) {
      written.push(
        ...(await writeUnits(ctx.setup.root, surface, target.locale, units, values, ctx.format)),
      );
    }
    written.push(saveMemory(ctx.setup.root, ctx.setup.config, memory));
    results.push({ ...base, dryRun: false, written, failures, changes });
  }
  return results;
}

export type Decision =
  | "same"
  | "applied"
  | "applied-current-broken"
  | "kept-locked"
  | "kept-domain-term"
  | "kept-google-failed";

export interface ReviewItem {
  readonly id: string;
  readonly surface: string;
  /** Catalog namespace, or the file of a markdown or text surface. */
  readonly group: string;
  readonly source: string;
  readonly current: string | undefined;
  readonly google: string | undefined;
  readonly decision: Decision;
  readonly reasons: readonly string[];
  /** Markdown and text units: lines whose wording differs, as [en-US, current, Google]. */
  readonly lines?: ReadonlyArray<readonly [string, string, string]>;
}

export interface ReviewResult {
  readonly locale: string;
  readonly dryRun: boolean;
  readonly applied: boolean;
  readonly units: number;
  readonly cost: Cost;
  readonly items: readonly ReviewItem[];
  readonly written: readonly string[];
}

/** Lower case, no punctuation or symbols, single spaces: wording only. */
export function normalizeWording(text: string): string {
  return text
    .normalize("NFC")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const contentLines = (text: string) => text.split("\n").filter((l) => /\p{L}/u.test(l));

function differingLines(
  unit: UnitRecord,
  current: string,
  fresh: string,
): Array<readonly [string, string, string]> {
  const s = contentLines(unit.source);
  const c = contentLines(current);
  const g = contentLines(fresh);
  if (c.length !== g.length)
    return [
      ["(the files have different numbers of lines)", `${c.length} lines`, `${g.length} lines`],
    ];
  const out: Array<readonly [string, string, string]> = [];
  c.forEach((line, i) => {
    if (normalizeWording(line) !== normalizeWording(g[i] ?? ""))
      out.push([s[i] ?? "", line, g[i] ?? ""]);
  });
  return out;
}

/**
 * Translates every source string fresh, compares Google's version with the current target, and
 * (with apply) writes Google's version except where the current one is locked, keeps a glossary
 * domain term Google dropped, or where Google's version fails the checks.
 */
export async function review(ctx: Context, locale: string, apply: boolean): Promise<ReviewResult> {
  const t = tools(ctx.setup);
  const target = targetFor(ctx.setup.config, locale);
  const memory = loadMemory(ctx.setup.root, ctx.setup.config, locale);
  const units = readAll(ctx, locale);
  const items: ReviewItem[] = [];
  const jobs: Job[] = [];
  for (const unit of units) {
    try {
      jobs.push(makeJob(unit, t));
    } catch (error) {
      items.push({
        id: unit.id,
        surface: unit.surface.id,
        group: groupOf(unit),
        source: unit.source,
        current: unit.target,
        google: undefined,
        decision: "kept-google-failed",
        reasons: [
          `the en-US source cannot be planned: ${error instanceof Error ? error.message : String(error)}`,
        ],
      });
    }
  }
  const cost = await fill(ctx, target, memory, jobs);
  if (!ctx.transport)
    return {
      locale,
      dryRun: true,
      applied: false,
      units: units.length,
      cost,
      items: [],
      written: [],
    };

  const glossaryLanguages = { source: ctx.setup.config.source.google, target: target.google };
  const values = new Map<string, string>();
  /** Memory entries of the units whose Google version is applied, committed only with apply. */
  const appliedEntries = new Map<string, Entry>();
  for (const job of jobs) {
    const unit = job.unit;
    const hash = sourceHash(unit);
    const entry = memory.entries.get(unit.id);
    const assembled = assemble(job, memory, locale, t);
    let google: string | undefined;
    if ("value" in assembled)
      google =
        unit.format === "icu" ? assembled.value : await ctx.format(assembled.value, unit.file);
    const current = unit.target;
    const base = {
      id: unit.id,
      surface: unit.surface.id,
      group: groupOf(unit),
      source: unit.source,
      current,
      google,
    };
    const keep = (decision: Decision, reasons: string[], by: Entry["by"] = "human") => {
      items.push({ ...base, decision, reasons });
      if (current !== undefined && !entry?.locked)
        memory.entries.set(unit.id, { by, source: hash, locked: false });
    };
    const take = (decision: Decision, reasons: string[]) => {
      if (google === undefined) return;
      items.push({
        ...base,
        decision,
        reasons,
        ...(unit.format === "icu" || current === undefined
          ? {}
          : { lines: differingLines(unit, current, google) }),
      });
      values.set(unit.id, google);
      appliedEntries.set(unit.id, { by: "google", source: hash, locked: false });
    };
    if (google === undefined) {
      keep("kept-google-failed", ["error" in assembled ? assembled.error : "no output"]);
      continue;
    }
    if (current === undefined) {
      take("applied", ["the target was missing"]);
      continue;
    }
    const same =
      unit.format === "icu"
        ? normalizeWording(current) === normalizeWording(google)
        : contentLines(current).length === contentLines(google).length &&
          differingLines(unit, current, google).length === 0;
    if (same) {
      if (!entry?.locked)
        memory.entries.set(unit.id, {
          by: current === google ? "google" : "human",
          source: hash,
          locked: false,
        });
      continue;
    }
    if (entry?.locked) {
      items.push({ ...base, decision: "kept-locked", reasons: ["a person locked this string"] });
      continue;
    }
    const broken = validateTarget(unit, current, locale, t);
    if (broken.length > 0) {
      take("applied-current-broken", broken);
      continue;
    }
    const term =
      unit.format === "icu"
        ? keptDomainTerm(
            ctx.setup.glossary,
            glossaryLanguages.source,
            glossaryLanguages.target,
            literalOf(unit, unit.source),
            literalOf(unit, current),
            literalOf(unit, google),
          )
        : null;
    if (term !== null) {
      keep("kept-domain-term", [`keeps the glossary term "${term}"`]);
      continue;
    }
    take("applied", []);
  }
  const written: string[] = [];
  if (apply) {
    for (const [id, entry] of appliedEntries) memory.entries.set(id, entry);
    prune(ctx, memory, units, t, jobs);
    for (const surface of selectedSurfaces(ctx))
      written.push(
        ...(await writeUnits(ctx.setup.root, surface, locale, units, values, async (text) => text)),
      );
  }
  written.push(saveMemory(ctx.setup.root, ctx.setup.config, memory));
  return { locale, dryRun: false, applied: apply, units: units.length, cost, items, written };
}

function groupOf(unit: UnitRecord): string {
  return unit.format === "icu" ? unit.file.replace(/\.json$/, "") : unit.file;
}

/** Locks (or unlocks) keys: translate and review never overwrite a locked target. */
export function setLock(
  setup: Setup,
  locale: string,
  ids: readonly string[],
  locked: boolean,
): { changed: string[]; unknown: string[] } {
  targetFor(setup.config, locale);
  const memory = loadMemory(setup.root, setup.config, locale);
  const units = new Map(
    setup.config.surfaces
      .flatMap((s) => readUnits(setup.root, s, setup.config.source.locale, locale))
      .map((u) => [u.id, u]),
  );
  const changed: string[] = [];
  const unknown: string[] = [];
  for (const id of ids) {
    const unit = units.get(id);
    if (!unit || unit.target === undefined) {
      unknown.push(id);
      continue;
    }
    const entry = memory.entries.get(id);
    memory.entries.set(id, {
      by: locked ? "human" : (entry?.by ?? "human"),
      source: sourceHash(unit),
      locked,
    });
    changed.push(id);
  }
  saveMemory(setup.root, setup.config, memory);
  return { changed, unknown };
}
