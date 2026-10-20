/**
 * Markdown reports of a run: the review report (docs/i18n/review/<locale>/, one file per catalog
 * namespace or markdown surface plus a summary), the translate report, and the tests whose
 * expectations quote a target string that a run changed.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Decision, ReviewItem, ReviewResult, TranslateResult } from "./pipeline.ts";

const DECISION_TEXT: Readonly<Record<Decision, string>> = {
  same: "same wording",
  applied: "applied Google's version",
  "applied-current-broken": "applied Google's version; the current one failed the checks",
  "kept-locked": "kept the current version; a person locked it",
  "kept-domain-term": "kept the current version; it uses a glossary term Google's version drops",
  "kept-google-failed": "kept the current version; Google's version failed the checks",
};

/** An inline code span that holds any text. */
export function code(text: string | undefined): string {
  if (text === undefined) return "(missing)";
  if (text === "") return "(empty)";
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  const pad =
    text.startsWith("`") || text.endsWith("`") || text.startsWith(" ") || text.endsWith(" ")
      ? " "
      : "";
  return `${fence}${pad}${text.replace(/\n/g, " ")}${pad}${fence}`;
}

function counts(items: readonly ReviewItem[]): Record<Decision, number> {
  const out = {
    same: 0,
    applied: 0,
    "applied-current-broken": 0,
    "kept-locked": 0,
    "kept-domain-term": 0,
    "kept-google-failed": 0,
  } as Record<Decision, number>;
  for (const i of items) out[i.decision] += 1;
  return out;
}

export interface RunInfo {
  readonly date: string;
  readonly model: string;
  readonly glossary: string;
}

/** The files of a review report, by path relative to the report directory of the locale. */
export function reviewReport(
  result: ReviewResult,
  totals: ReadonlyMap<string, number>,
  tests: ReadonlyMap<string, readonly string[]>,
  info: RunInfo,
): Map<string, string> {
  const files = new Map<string, string>();
  const groups = new Map<string, ReviewItem[]>();
  for (const item of result.items) {
    const name = item.surface === "catalogs" ? item.group : item.surface;
    groups.set(name, [...(groups.get(name) ?? []), item]);
  }
  const summary: string[] = [
    `# ${result.locale} review by Google Cloud Translation`,
    "",
    `Run on ${info.date} with \`${info.model}\` and glossary \`${info.glossary}\`. Every en-US string and file was translated fresh and compared with the current ${result.locale} version after normalizing case, punctuation and whitespace. Only the ones whose wording differs are listed. ${result.applied ? "Decisions were applied to the catalogs and files." : "Nothing was written (run without --no-apply to apply)."}`,
    "",
    `Compared ${result.units} strings and files; ${result.items.length} differ.`,
    "",
    "| Catalog or surface | Compared | Differ | Applied | Kept |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const name of [...new Set([...totals.keys(), ...groups.keys()])].sort()) {
    const items = groups.get(name) ?? [];
    const c = counts(items);
    const applied = c.applied + c["applied-current-broken"];
    const kept = c["kept-locked"] + c["kept-domain-term"] + c["kept-google-failed"];
    const link = items.length > 0 ? `[${name}](${name}.md)` : name;
    summary.push(
      `| ${link} | ${totals.get(name) ?? items.length} | ${items.length} | ${applied} | ${kept} |`,
    );
  }
  summary.push("", "## Decisions", "");
  for (const [decision, text] of Object.entries(DECISION_TEXT)) {
    if (decision !== "same")
      summary.push(`- ${text}: ${counts(result.items)[decision as Decision]}`);
  }
  if (tests.size > 0) {
    summary.push(
      "",
      "## Test expectations to update",
      "",
      "These tests quote a string this review changed. Update the expectation, or lock the key with `pnpm --filter @xos/i18n translate:lock <key>` and restore it.",
      "",
    );
    for (const [id, paths] of [...tests].sort()) summary.push(`- \`${id}\`: ${paths.join(", ")}`);
  }
  files.set("README.md", `${summary.join("\n")}\n`);

  for (const [name, items] of groups) {
    const lines = [
      `# ${result.locale} review: ${name}`,
      "",
      `${items.length} of ${totals.get(name) ?? items.length} differ. Back to the [summary](README.md).`,
    ];
    for (const item of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
      lines.push("", `## ${code(item.id)}`, "");
      lines.push(
        `- Decision: ${DECISION_TEXT[item.decision]}${item.reasons.length > 0 ? ` (${item.reasons.join("; ")})` : ""}`,
      );
      if (item.lines) {
        for (const [en, current, google] of item.lines.slice(0, 20)) {
          lines.push(
            `- en-US: ${code(en)}`,
            `  - Current: ${code(current)}`,
            `  - Google: ${code(google)}`,
          );
        }
        if (item.lines.length > 20) lines.push(`- ${item.lines.length - 20} more lines differ.`);
      } else {
        lines.push(
          `- en-US: ${code(item.source)}`,
          `- Current: ${code(item.current)}`,
          `- Google: ${code(item.google)}`,
        );
      }
    }
    files.set(`${name}.md`, `${lines.join("\n")}\n`);
  }
  return files;
}

export function translateReport(
  result: TranslateResult,
  tests: ReadonlyMap<string, readonly string[]>,
  info: RunInfo,
): string {
  const lines = [
    `# ${result.locale} translate run`,
    "",
    `Run on ${info.date} with \`${info.model}\` and glossary \`${info.glossary}\`: ${result.selected} missing or stale strings and files, ${result.changes.length} changed, ${result.failures.length} failed, ${result.cost.misses} segments sent to Google (${result.cost.characters} characters), ${result.cost.cached} answered from the translation memory.`,
  ];
  if (result.failures.length > 0) {
    lines.push(
      "",
      "## Failed",
      "",
      "These kept their current value, or the en-US text where they had none (marked fallback in the translation memory, so the next run retries them).",
      "",
    );
    for (const f of result.failures) lines.push(`- ${code(f.id)}: ${f.reason}`);
  }
  if (result.lockedStale.length > 0) {
    lines.push(
      "",
      "## Locked strings whose en-US changed",
      "",
      "Update each by hand, then run `pnpm --filter @xos/i18n translate:lock <key>` again.",
      "",
    );
    for (const id of result.lockedStale) lines.push(`- ${code(id)}`);
  }
  if (tests.size > 0) {
    lines.push("", "## Test expectations to update", "");
    for (const [id, paths] of [...tests].sort()) lines.push(`- \`${id}\`: ${paths.join(", ")}`);
  }
  return `${lines.join("\n")}\n`;
}

const TEST_DIRS = [/^apps\/[^/]+\/(test|e2e)$/, /^packages\/[^/]+\/test$/, /^infra\/[^/]+\/test$/];

function testFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const full = join(dir, name);
      const rel = relative(root, full);
      const isDir = statSync(full).isDirectory();
      if (isDir && TEST_DIRS.some((re) => re.test(rel))) collect(full);
      else if (isDir && depth < 2) walk(full, depth + 1);
    }
  };
  const collect = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) collect(full);
      else if (/\.(ts|tsx)$/.test(name)) out.push(full);
    }
  };
  for (const top of ["apps", "packages", "infra"])
    if (existsSync(join(root, top))) walk(join(root, top), 1);
  return out;
}

/**
 * Tests that quote the old value of a changed string: the whole value in quotes, or its longest
 * literal run outside ICU arguments when that run has at least two words and 12 characters.
 */
export function findTestReferences(
  root: string,
  changes: ReadonlyArray<{ readonly id: string; readonly before: string | undefined }>,
): Map<string, string[]> {
  const probes = changes
    .filter((c) => c.before !== undefined && c.before !== "" && !c.id.includes("/"))
    .map((c) => {
      const before = c.before ?? "";
      const run = before
        .split(/\{[^{}]*\}|<\/?\w+>/)
        .reduce((a, b) => (b.trim().length > a.length ? b.trim() : a), "");
      const quoted = ['"', "'", "`"].map((q) => `${q}${before}${q}`);
      return { id: c.id, needles: run.length >= 12 && /\s/.test(run) ? [run] : quoted };
    });
  const out = new Map<string, string[]>();
  if (probes.length === 0) return out;
  for (const file of testFiles(root)) {
    const text = readFileSync(file, "utf8");
    for (const p of probes) {
      if (p.needles.some((n) => text.includes(n))) {
        out.set(p.id, [...(out.get(p.id) ?? []), relative(root, file)]);
      }
    }
  }
  return out;
}
