/**
 * The offline check (no network): run by `pnpm --filter @xos/i18n test` and so by `pnpm verify`.
 *
 * Errors: a target catalog misses a namespace or key (except a Beta locale or a partial surface such
 * as the canon labels, ADR 0053, whose missing units are only counted), has an extra or empty one, a message is not
 * valid ICU or its arguments, plural and select structure or tags differ from en-US, a protected word
 * (product name, canon code, plan name, identifier, URL) is not kept, a terminology rule is broken
 * (es-US calls a project gate a "compuerta"), a markdown file is missing, or its code blocks and
 * untranslated front matter differ from en-US.
 *
 * Warnings (errors with `check.stale: "error"` in translation/config.json, or with strict): a target
 * is stale against the translation memory (its en-US source changed since it was translated), a
 * locked target's source changed, a target is an en-US fallback, or a memory entry names a key that
 * no longer exists.
 */
import { existsSync, readdirSync } from "node:fs";
import { missingAllowed, surfacesFor, type Setup } from "./config.ts";
import { loadMemory, statusOf, type Status } from "./memory.ts";
import { sourceHash, validateTarget } from "./pipeline.ts";
import { compileProtector } from "./protect.ts";
import { compileRules } from "./rules.ts";
import { extraCatalogKeys, readUnits, surfaceDir } from "./surfaces.ts";

export interface Finding {
  readonly locale: string;
  readonly id: string;
  readonly message: string;
}

export interface CheckResult {
  readonly errors: readonly Finding[];
  readonly warnings: readonly Finding[];
  /** Per locale, how many units are in each memory status. */
  readonly statuses: Readonly<Record<string, Readonly<Partial<Record<Status, number>>>>>;
}

function skeleton(
  text: string,
  frontMatter: readonly string[],
): { meta: string[]; code: string[] } {
  const lines = text.split("\n");
  const meta: string[] = [];
  const code: string[] = [];
  let i = 0;
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    for (i = 1; i < end; i++) {
      const line = lines[i] ?? "";
      const key = /^\s*([A-Za-z_][\w-]*):/.exec(line)?.[1];
      if (key === undefined || !frontMatter.includes(key)) meta.push(line);
    }
    i = end + 1;
  }
  let fence: string | null = null;
  for (; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const open = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence !== null) {
      // A person may translate a trailing comment; the code itself must match.
      code.push(line.replace(/\s+(#|\/\/)\s.*$/, "").trimEnd());
      if (open && open[0] === fence[0]) fence = null;
    } else if (open) {
      fence = open;
      code.push(line);
    }
  }
  return { meta, code };
}

export function runCheck(setup: Setup, options: { strict?: boolean } = {}): CheckResult {
  const errors: Finding[] = [];
  const warnings: Finding[] = [];
  const statuses: Record<string, Partial<Record<Status, number>>> = {};
  const t = {
    protector: compileProtector(setup.terms.doNotTranslate),
    rules: compileRules(setup.terms),
  };
  const staleIsError = options.strict === true || setup.config.check.stale === "error";
  const source = setup.config.source.locale;

  for (const target of setup.config.targets) {
    const { locale } = target;
    const memory = loadMemory(setup.root, setup.config, locale);
    const counts: Partial<Record<Status, number>> = {};
    statuses[locale] = counts;
    const error = (id: string, message: string) => errors.push({ locale, id, message });
    const drift = (id: string, message: string) =>
      (staleIsError ? errors : warnings).push({ locale, id, message });
    const ids = new Set<string>();

    for (const surface of surfacesFor(setup.config, target)) {
      const units = readUnits(setup.root, surface, source, locale);
      // A Beta locale or the canon labels (ADR 0053) may be partial: missing units are counted, not
      // errors, because every reader falls back to en-US key by key.
      const partial = missingAllowed(target, surface);
      if (surface.kind === "catalog") {
        const list = (dir: string) =>
          existsSync(dir)
            ? readdirSync(dir)
                .filter((f) => f.endsWith(".json"))
                .sort()
            : [];
        const theirs = new Set(list(surfaceDir(setup.root, surface, locale)));
        for (const file of list(surfaceDir(setup.root, surface, source)))
          if (!theirs.has(file) && !partial) error(file, `namespace file ${file} is missing`);
        for (const id of extraCatalogKeys(setup.root, surface, source, locale))
          error(id, "key is not in en-US");
      } else {
        const sourceFiles = new Set(units.map((u) => u.file));
        const dir = surfaceDir(setup.root, surface, locale);
        const ext = surface.extension ?? (surface.kind === "markdown" ? ".md" : ".txt");
        for (const f of existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith(ext)) : []) {
          if (!sourceFiles.has(f)) error(`${surface.id}/${f}`, "file is not in en-US");
        }
      }
      for (const unit of units) {
        ids.add(unit.id);
        const entry = memory.entries.get(unit.id);
        const status = statusOf(sourceHash(unit), unit.target, entry);
        counts[status] = (counts[status] ?? 0) + 1;
        if (unit.target === undefined) {
          if (!partial) error(unit.id, "missing");
          continue;
        }
        if (unit.target.trim() === "") {
          error(unit.id, "empty");
          continue;
        }
        for (const problem of validateTarget(unit, unit.target, locale, t)) error(unit.id, problem);
        if (unit.format !== "icu") {
          const a = skeleton(unit.source, unit.surface.frontMatter ?? []);
          const b = skeleton(unit.target, unit.surface.frontMatter ?? []);
          if (a.meta.join("\n") !== b.meta.join("\n"))
            error(unit.id, "front matter outside the translated keys differs from en-US");
          if (a.code.join("\n") !== b.code.join("\n"))
            error(unit.id, "code blocks differ from en-US");
        }
        if (status === "stale")
          drift(
            unit.id,
            entry?.by === "fallback"
              ? "is an en-US fallback; run translate again"
              : "en-US changed since this was translated; run translate",
          );
        if (status === "locked-stale")
          drift(
            unit.id,
            "is locked, but en-US changed; update it by hand, then run translate:lock again",
          );
      }
    }
    const surfaceIds = new Set(surfacesFor(setup.config, target).map((s) => s.id));
    for (const id of memory.entries.keys()) {
      const slash = id.indexOf("/");
      const known = slash === -1 || surfaceIds.has(id.slice(0, slash));
      if (known && !ids.has(id))
        drift(id, "the translation memory names a key that no longer exists; translate prunes it");
    }
  }
  return { errors, warnings, statuses };
}

export function formatFindings(result: CheckResult): string {
  const lines: string[] = [];
  for (const [locale, counts] of Object.entries(result.statuses)) {
    lines.push(
      `${locale}: ${Object.entries(counts)
        .map(([s, n]) => `${n} ${s}`)
        .join(", ")}`,
    );
  }
  for (const f of result.errors) lines.push(`error ${f.locale} ${f.id}: ${f.message}`);
  for (const f of result.warnings) lines.push(`warning ${f.locale} ${f.id}: ${f.message}`);
  lines.push(`${result.errors.length} errors, ${result.warnings.length} warnings.`);
  return lines.join("\n");
}
