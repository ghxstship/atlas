/**
 * License check (Section 18, gate 11).
 *
 * Reads `pnpm licenses list --json --prod` and fails on any production dependency whose license is not on the
 * allowlist. An SPDX expression passes when every `AND` term passes and at least one `OR` alternative passes,
 * so a dual-licensed package passes on its permissive option. Anything else (copyleft, source-available,
 * unknown) is a decision for counsel: it is reported with the packages that carry it and never allowed here.
 */

/** Licenses that permit use in the AGPL-3.0 platform and the MIT packages without further review. */
export const ALLOWED_LICENSES: ReadonlySet<string> = new Set([
  "0BSD",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC-BY-4.0",
  "CC0-1.0",
  "ISC",
  "MIT",
  "MIT-0",
  "MPL-2.0",
  "Python-2.0",
  "Unlicense",
  "Zlib",
]);

/** Non-SPDX spellings found in package metadata, mapped to their SPDX identifier. */
const ALIASES: Readonly<Record<string, string>> = {
  "MIT/X11": "MIT",
  "Apache 2.0": "Apache-2.0",
  BSD: "BSD-2-Clause",
};

export interface LicensedPackage {
  readonly name: string;
  readonly versions: readonly string[];
  readonly license: string;
}

export interface LicenseViolation {
  readonly license: string;
  readonly packages: readonly string[];
}

/** Splits `a OR (b AND c)` at its top level on `operator`, ignoring case and parentheses. */
function splitTop(expression: string, operator: "AND" | "OR"): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  const tokens = expression.split(/(\(|\)|\s+)/).filter((t) => t !== "");
  for (const token of tokens) {
    if (token === "(") depth += 1;
    if (token === ")") depth -= 1;
    if (depth === 0 && token.toUpperCase() === operator) {
      parts.push(current.trim());
      current = "";
    } else {
      current += token;
    }
  }
  parts.push(current.trim());
  return parts.filter((p) => p !== "");
}

/** True when the parenthesis opening `t` closes at its last character. */
function wrapped(t: string): boolean {
  if (!t.startsWith("(") || !t.endsWith(")")) return false;
  let depth = 0;
  for (let i = 0; i < t.length; i += 1) {
    if (t[i] === "(") depth += 1;
    if (t[i] === ")") depth -= 1;
    if (depth === 0 && i < t.length - 1) return false;
  }
  return true;
}

function unwrap(term: string): string {
  let t = term.trim();
  while (wrapped(t)) t = t.slice(1, -1).trim();
  return t;
}

/** True when the SPDX expression is satisfied by the allowlist. */
export function isAllowed(
  expression: string,
  allowed: ReadonlySet<string> = ALLOWED_LICENSES,
): boolean {
  const e = unwrap(expression);
  const alternatives = splitTop(e, "OR");
  if (alternatives.length > 1) return alternatives.some((a) => isAllowed(a, allowed));
  const terms = splitTop(e, "AND");
  if (terms.length > 1) return terms.every((t) => isAllowed(t, allowed));
  const id = ALIASES[e] ?? e;
  return allowed.has(id);
}

/**
 * A package whose license is outside the allowlist, recorded in `packages/config/license-exceptions.json`
 * while counsel reviews it or after counsel approves it. It covers that package under that exact license
 * only: the same package under another license, or another package under the same license, still fails.
 */
export interface LicenseException {
  /** The package name; a trailing `*` matches platform builds such as `@img/sharp-libvips-*`. */
  readonly package: string;
  readonly license: string;
  readonly status: "Pending counsel" | "Approved by counsel";
  /** Why the package is used and why the license may be acceptable. */
  readonly reason: string;
  /** Where the decision is tracked (a gate-status row, an ADR, an owner decision). */
  readonly decision: string;
  readonly recorded: string;
}

export interface ExceptedLicense {
  readonly license: string;
  readonly packages: readonly string[];
  readonly exception: LicenseException;
}

export interface LicenseReview {
  /** Licenses that fail: outside the allowlist with no exception. */
  readonly violations: readonly LicenseViolation[];
  /** Licenses outside the allowlist that an exception covers. */
  readonly excepted: readonly ExceptedLicense[];
  /** Exceptions that matched nothing; remove them. */
  readonly unused: readonly LicenseException[];
  /** Exceptions that are malformed; each fails. */
  readonly invalid: readonly string[];
}

function matches(pattern: string, name: string): boolean {
  return pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern;
}

function invalidException(e: LicenseException): string | null {
  if (!e.package || !e.license) return `${e.package || "?"}: names no package or license`;
  if (e.status !== "Pending counsel" && e.status !== "Approved by counsel") {
    return `${e.package}: status must be "Pending counsel" or "Approved by counsel"`;
  }
  if (!e.reason || e.reason.trim().length < 20) return `${e.package}: gives no reason`;
  if (!e.decision) return `${e.package}: names no decision record`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.recorded ?? "")) return `${e.package}: recorded is not a date`;
  return null;
}

/**
 * Like {@link checkLicenses}, but a package covered by an exception (same name pattern, same license) is
 * reported as excepted instead of failing.
 */
export function reviewLicenses(
  byLicense: Readonly<Record<string, readonly LicensedPackage[]>>,
  exceptions: readonly LicenseException[],
  allowed: ReadonlySet<string> = ALLOWED_LICENSES,
): LicenseReview {
  const invalid = exceptions.map(invalidException).filter((p): p is string => p !== null);
  const valid = exceptions.filter((e) => invalidException(e) === null);
  const used = new Set<LicenseException>();
  const violations: LicenseViolation[] = [];
  const excepted = new Map<LicenseException, { license: string; packages: string[] }>();
  for (const [license, packages] of Object.entries(byLicense)) {
    if (isAllowed(license, allowed)) continue;
    const failing: string[] = [];
    for (const p of packages) {
      const label = `${p.name}@${p.versions.join(",")}`;
      const exception = valid.find((e) => e.license === license && matches(e.package, p.name));
      if (exception === undefined) {
        failing.push(label);
        continue;
      }
      used.add(exception);
      const entry = excepted.get(exception) ?? { license, packages: [] };
      entry.packages.push(label);
      excepted.set(exception, entry);
    }
    if (failing.length > 0) violations.push({ license, packages: failing.sort() });
  }
  return {
    violations: violations.sort((a, b) => a.license.localeCompare(b.license)),
    excepted: [...excepted.entries()]
      .map(([exception, e]) => ({ license: e.license, packages: e.packages.sort(), exception }))
      .sort((a, b) => a.license.localeCompare(b.license)),
    unused: valid.filter((e) => !used.has(e)),
    invalid,
  };
}

/** Groups the packages whose license fails the allowlist, by license, sorted. */
export function checkLicenses(
  byLicense: Readonly<Record<string, readonly LicensedPackage[]>>,
  allowed: ReadonlySet<string> = ALLOWED_LICENSES,
): LicenseViolation[] {
  return Object.entries(byLicense)
    .filter(([license]) => !isAllowed(license, allowed))
    .map(([license, packages]) => ({
      license,
      packages: packages.map((p) => `${p.name}@${p.versions.join(",")}`).sort(),
    }))
    .sort((a, b) => a.license.localeCompare(b.license));
}
