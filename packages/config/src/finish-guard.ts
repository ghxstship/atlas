/**
 * Finish guard (Section 18, gate 2).
 *
 * Fails the build on unfinished-work markers, filler text, the stand-in word
 * outside a form attribute, test doubles in production paths, and em dash characters.
 * Patterns are assembled from fragments so this file never matches itself.
 */

export type GuardRule =
  "marker" | "filler-text" | "filler-word" | "test-double-in-production" | "em-dash";

export interface GuardFinding {
  readonly file: string;
  readonly line: number;
  readonly rule: GuardRule;
  readonly excerpt: string;
}

const MARKER = new RegExp(`\\b(${["TO" + "DO", "FIX" + "ME", "X".repeat(3)].join("|")})\\b`);
const FILLER = new RegExp(`\\b(${["lor" + "em", "ip" + "sum"].join("|")})\\b`, "i");
const STAND_IN_WORD = "place" + "holder";
const STAND_IN = new RegExp(STAND_IN_WORD, "gi");
const TEST_DOUBLE = new RegExp(`\\b${"mo" + "ck"}`, "i");
const EM_DASH = String.fromCharCode(0x2014);

/** Paths whose content is third-party verbatim text or canon input, never our copy. */
const EXCLUDED_PATHS: readonly RegExp[] = [
  /(^|\/)node_modules\//,
  /^canon\/source\//,
  /^docs\/spec\//,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)LICENSE(\.[a-z]+)?$/,
  /(^|\/)CODE_OF_CONDUCT\.md$/,
];

const SCANNED_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "mts",
  "cts",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "json",
  "yaml",
  "yml",
  "toml",
  "md",
  "mdx",
  "sql",
  "css",
  "html",
  "txt",
  "sh",
]);

const TEST_PATH = [
  /(^|\/)(test|tests|__tests__|e2e|fixtures|stories|\.maestro)\//,
  /\.(test|spec|stories)\.[cm]?[jt]sx?$/,
  /^packages\/testing\//,
];

export function isScannable(path: string): boolean {
  if (EXCLUDED_PATHS.some((re) => re.test(path))) return false;
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return SCANNED_EXTENSIONS.has(ext);
}

export function isProductionPath(path: string): boolean {
  return !TEST_PATH.some((re) => re.test(path));
}

/** A form attribute or prop (`placeholder=`, `placeholder:`, `placeholder?:`) or the CSS `::placeholder` pseudo-element. */
function isAttributeUse(lineText: string, index: number): boolean {
  const before = lineText.slice(Math.max(0, index - 2), index);
  const after = lineText.slice(index + STAND_IN_WORD.length);
  return before === "::" || /^\??\s*[=:]/.test(after);
}

function hasBareStandIn(lineText: string): boolean {
  for (const match of lineText.matchAll(STAND_IN)) {
    if (!isAttributeUse(lineText, match.index)) return true;
  }
  return false;
}

export function scanText(file: string, text: string): GuardFinding[] {
  const findings: GuardFinding[] = [];
  const production = isProductionPath(file);
  const lines = text.split(/\r?\n/);
  lines.forEach((lineText, i) => {
    const push = (rule: GuardRule) =>
      findings.push({ file, line: i + 1, rule, excerpt: lineText.trim().slice(0, 120) });
    if (MARKER.test(lineText)) push("marker");
    if (FILLER.test(lineText)) push("filler-text");
    if (hasBareStandIn(lineText)) push("filler-word");
    if (production && TEST_DOUBLE.test(lineText)) push("test-double-in-production");
    if (lineText.includes(EM_DASH)) push("em-dash");
  });
  return findings;
}

export function formatFinding(f: GuardFinding): string {
  return `${f.file}:${f.line} [${f.rule}] ${f.excerpt}`;
}
