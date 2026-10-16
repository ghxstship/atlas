/**
 * Design QA audit (Sections 11.3, 11.4 and 18, gates 8 and 9). Pure checks over source text, so the
 * same rules run in unit tests and in the CLI over the repository:
 * - raw values: colors, lengths and durations written as literals instead of tokens
 * - token usage: every `var(--name)` names a token or a custom property the code defines
 * - component inventory: every Section 11.4 component is exported by the web library
 */

export type FindingRule = "raw-color" | "raw-length" | "raw-duration" | "unknown-token";

export interface Finding {
  readonly file: string;
  readonly line: number;
  readonly rule: FindingRule;
  readonly text: string;
}

const RAW_COLOR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch)\(\s*[\d.]/g;
/** Tailwind arbitrary values that carry a literal, for example `w-[13px]` or `bg-[#fff]`. */
const ARBITRARY = /\b[a-z][a-z0-9-]*-\[([^\]\s]+)\]/g;
const LENGTH = /^-?[\d.]+(?:px|rem|em|pt)$/;
const DURATION = /^[\d.]+m?s$/;
/** Inline style objects written with literal lengths, for example `{ width: "13px" }`. */
const INLINE_LENGTH =
  /\b(?:width|height|margin\w*|padding\w*|gap|top|left|right|bottom|fontSize|borderRadius|inset\w*)\s*:\s*["'`]-?[\d.]+(?:px|rem|em)["'`]/g;
const VAR_REF = /var\(\s*(--[a-zA-Z0-9-]+)/g;
const VAR_DEF = /(--[a-zA-Z0-9-]+)\s*:/g;
/** Lines that opt out with a reason, for values that are data rather than design (a brand color). */
const ALLOW = /design-audit-allow:\s*\S/;

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (source.charCodeAt(i) === 10) line += 1;
  return line;
}

function allowed(source: string, index: number): boolean {
  const start = source.lastIndexOf("\n", index) + 1;
  const end = source.indexOf("\n", index);
  const previous = source.lastIndexOf("\n", start - 2) + 1;
  return ALLOW.test(source.slice(previous, end === -1 ? undefined : end));
}

/** Raw colors, lengths and durations in one file. */
export function findRawValues(file: string, source: string): Finding[] {
  const findings: Finding[] = [];
  const push = (rule: FindingRule, index: number, text: string) => {
    if (!allowed(source, index)) findings.push({ file, line: lineOf(source, index), rule, text });
  };
  for (const match of source.matchAll(RAW_COLOR)) push("raw-color", match.index, match[0]);
  for (const match of source.matchAll(ARBITRARY)) {
    const value = match[1] ?? "";
    if (value.startsWith("#")) continue; // already reported as a raw color
    if (LENGTH.test(value)) push("raw-length", match.index, match[0]);
    else if (DURATION.test(value)) push("raw-duration", match.index, match[0]);
  }
  for (const match of source.matchAll(INLINE_LENGTH)) push("raw-length", match.index, match[0]);
  return findings;
}

/** Custom property names a file defines (`--name:`), in CSS or in inline style objects. */
export function definedProperties(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(VAR_DEF)) if (match[1]) names.add(match[1]);
  for (const match of source.matchAll(/["'](--[a-zA-Z0-9-]+)["']\s*:/g)) {
    if (match[1]) names.add(match[1]);
  }
  return names;
}

/** `var(--name)` references to properties that no token or stylesheet defines. */
export function findUnknownTokens(
  file: string,
  source: string,
  defined: ReadonlySet<string>,
): Finding[] {
  const findings: Finding[] = [];
  for (const match of source.matchAll(VAR_REF)) {
    const name = match[1] ?? "";
    if (defined.has(name) || allowed(source, match.index)) continue;
    findings.push({ file, line: lineOf(source, match.index), rule: "unknown-token", text: name });
  }
  return findings;
}

/** How often each token is referenced, for the usage table in the report. */
export function tokenUsage(sources: Iterable<string>): Map<string, number> {
  const usage = new Map<string, number>();
  for (const source of sources) {
    for (const match of source.matchAll(VAR_REF)) {
      const name = match[1] ?? "";
      usage.set(name, (usage.get(name) ?? 0) + 1);
    }
  }
  return usage;
}

/** Names a module exports: functions, constants, classes and re-exported bindings. */
export function exportedNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(
    /export\s+(?:declare\s+)?(?:function|const|class|let)\s+([A-Za-z0-9_]+)/g,
  )) {
    if (match[1]) names.add(match[1]);
  }
  for (const match of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of (match[1] ?? "").split(",")) {
      const name = part
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name && !part.trim().startsWith("type ")) names.add(name);
    }
  }
  return names;
}

export interface InventoryResult {
  readonly missing: readonly string[];
  readonly present: readonly string[];
}

/** Which spec components a set of exported names covers. */
export function checkInventory(
  spec: readonly string[],
  exported: ReadonlySet<string>,
): InventoryResult {
  const missing = spec.filter((name) => !exported.has(name));
  return { missing, present: spec.filter((name) => exported.has(name)) };
}
