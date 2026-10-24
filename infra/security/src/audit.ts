/**
 * Dependency audit (Section 9 dependency scanning, gate 11).
 *
 * Reads two `pnpm audit --json` reports, production dependencies and the whole tree, and applies one policy:
 *
 * - a production advisory of any severity fails, because it ships;
 * - an advisory of critical severity anywhere fails, including build and test tooling, because that code runs
 *   in CI with the repository's secrets (GitHub's malware advisories are critical);
 * - everything else is reported as a warning.
 *
 * An advisory listed in `infra/security/audit-allowlist.json` passes until its `review_by` date; after that it
 * fails until someone reviews it again. Entries that no report mentions any more are reported so they can be
 * removed.
 */

export const SEVERITIES = ["info", "low", "moderate", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Production dependencies fail from this severity up. */
export const PRODUCTION_FAIL_AT: Severity = "low";
/** The whole tree, development dependencies included, fails from this severity up. */
export const TREE_FAIL_AT: Severity = "critical";

/** The parts of a `pnpm audit --json` advisory the policy reads. */
export interface PnpmAdvisory {
  readonly github_advisory_id?: string;
  readonly id?: number;
  readonly module_name: string;
  readonly severity: string;
  readonly title: string;
  readonly url?: string;
  readonly vulnerable_versions?: string;
  readonly patched_versions?: string;
  readonly findings?: readonly { readonly version?: string; readonly paths?: readonly string[] }[];
}

export interface PnpmAuditReport {
  readonly advisories?: Readonly<Record<string, PnpmAdvisory>>;
}

export interface AllowlistEntry {
  readonly id: string;
  readonly package: string;
  readonly severity: string;
  readonly path?: string;
  /**
   * The installed versions the entry accepts. When set, a finding that also reports any other version is not
   * accepted, so an entry for a version reached only through a build tool never covers that package returning to a
   * shipped dependency at a vulnerable version.
   */
  readonly versions?: readonly string[];
  readonly reason: string;
  readonly recorded: string;
  readonly review_by: string;
}

export interface Allowlist {
  readonly advisories: readonly AllowlistEntry[];
}

export type Scope = "production" | "development";

export interface Finding {
  readonly id: string;
  readonly package: string;
  readonly severity: Severity;
  readonly scope: Scope;
  readonly title: string;
  readonly url: string;
  readonly path: string;
  /** The installed versions the report found vulnerable. */
  readonly versions: readonly string[];
}

export interface AuditResult {
  /** Advisories that fail the audit. */
  readonly failures: readonly Finding[];
  /** Advisories below the failing severity for their scope. */
  readonly warnings: readonly Finding[];
  /** Allowlisted advisories that are still within their review date. */
  readonly accepted: readonly Finding[];
  /** Allowlist entries past their review date; each fails the audit. */
  readonly expired: readonly AllowlistEntry[];
  /** Allowlist entries no report mentions; remove them. */
  readonly stale: readonly AllowlistEntry[];
  /** Allowlist entries that are malformed (missing id, reason or dates); each fails the audit. */
  readonly invalid: readonly string[];
}

export function severityOf(value: string): Severity {
  const lower = value.toLowerCase();
  return (SEVERITIES as readonly string[]).includes(lower) ? (lower as Severity) : "critical";
}

export function atLeast(severity: Severity, floor: Severity): boolean {
  return SEVERITIES.indexOf(severity) >= SEVERITIES.indexOf(floor);
}

function advisoryId(advisory: PnpmAdvisory): string {
  return advisory.github_advisory_id ?? `npm-${advisory.id ?? advisory.module_name}`;
}

function findingsOf(report: PnpmAuditReport, scope: Scope): Finding[] {
  return Object.values(report.advisories ?? {}).map((advisory) => ({
    id: advisoryId(advisory),
    package: advisory.module_name,
    severity: severityOf(advisory.severity),
    scope,
    title: advisory.title,
    url: advisory.url ?? "",
    path: advisory.findings?.[0]?.paths?.[0]?.replaceAll("__", "/").replaceAll(">", " > ") ?? "",
    versions: [
      ...new Set((advisory.findings ?? []).flatMap((f) => (f.version ? [f.version] : []))),
    ].sort(),
  }));
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function validate(entry: AllowlistEntry): string | null {
  if (!/^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/.test(entry.id ?? ""))
    return `${String(entry.id)}: not a GHSA identifier`;
  if (!entry.package) return `${entry.id}: names no package`;
  if (!entry.reason || entry.reason.trim().length < 20) return `${entry.id}: gives no reason`;
  if (!DATE.test(entry.recorded ?? "")) return `${entry.id}: recorded is not a YYYY-MM-DD date`;
  if (!DATE.test(entry.review_by ?? "")) return `${entry.id}: review_by is not a YYYY-MM-DD date`;
  if (
    entry.versions !== undefined &&
    (!Array.isArray(entry.versions) || entry.versions.length === 0)
  )
    return `${entry.id}: versions, when given, lists at least one version`;
  return null;
}

/**
 * Applies the policy. `today` is a YYYY-MM-DD date; an entry whose `review_by` is before it has expired.
 * An advisory found in both reports counts once, as production.
 */
export function evaluateAudit(
  reports: { readonly production: PnpmAuditReport; readonly tree: PnpmAuditReport },
  allowlist: Allowlist,
  today: string,
): AuditResult {
  const production = findingsOf(reports.production, "production");
  const productionIds = new Set(production.map((f) => `${f.id} ${f.package}`));
  const development = findingsOf(reports.tree, "development").filter(
    (f) => !productionIds.has(`${f.id} ${f.package}`),
  );
  const findings = [...production, ...development];

  const invalid: string[] = [];
  const valid = new Map<string, AllowlistEntry>();
  for (const entry of allowlist.advisories) {
    const problem = validate(entry);
    if (problem === null) valid.set(`${entry.id} ${entry.package}`, entry);
    else invalid.push(problem);
  }

  const failures: Finding[] = [];
  const warnings: Finding[] = [];
  const accepted: Finding[] = [];
  const expired = new Map<string, AllowlistEntry>();
  const used = new Set<string>();

  for (const finding of findings) {
    const key = `${finding.id} ${finding.package}`;
    const entry = valid.get(key);
    const covered =
      entry !== undefined &&
      (entry.versions === undefined || finding.versions.every((v) => entry.versions?.includes(v)));
    if (entry !== undefined && covered) {
      used.add(key);
      if (entry.review_by < today) expired.set(key, entry);
      else accepted.push(finding);
      continue;
    }
    if (entry !== undefined) used.add(key);
    const floor = finding.scope === "production" ? PRODUCTION_FAIL_AT : TREE_FAIL_AT;
    (atLeast(finding.severity, floor) ? failures : warnings).push(finding);
  }

  const stale = [...valid.entries()].filter(([key]) => !used.has(key)).map(([, entry]) => entry);
  const order = (a: Finding, b: Finding) =>
    SEVERITIES.indexOf(b.severity) - SEVERITIES.indexOf(a.severity) || a.id.localeCompare(b.id);
  return {
    failures: failures.sort(order),
    warnings: warnings.sort(order),
    accepted: accepted.sort(order),
    expired: [...expired.values()],
    stale,
    invalid,
  };
}

export function auditPasses(result: AuditResult): boolean {
  return result.failures.length === 0 && result.expired.length === 0 && result.invalid.length === 0;
}

/** A Markdown summary for the job summary and the console. */
export function auditSummary(result: AuditResult): string {
  const line = (f: Finding) =>
    `| ${f.severity} | ${f.scope} | \`${f.package}\` | [${f.id}](${f.url}) | ${f.title.replaceAll("|", "\\|")} |`;
  const table = (title: string, rows: readonly Finding[]) =>
    rows.length === 0
      ? []
      : [
          `### ${title} (${rows.length})`,
          "",
          "| Severity | Scope | Package | Advisory | Title |",
          "| --- | --- | --- | --- | --- |",
          ...rows.map(line),
          "",
        ];
  const verdict = auditPasses(result) ? "passed" : "failed";
  return [
    `## Dependency audit ${verdict}`,
    "",
    `Production advisories fail from ${PRODUCTION_FAIL_AT}; the whole tree fails from ${TREE_FAIL_AT}.`,
    "",
    ...table("Failing", result.failures),
    ...(result.expired.length === 0
      ? []
      : [
          `### Allowlist entries past their review date (${result.expired.length})`,
          "",
          ...result.expired.map((e) => `- ${e.id} (\`${e.package}\`), review_by ${e.review_by}`),
          "",
        ]),
    ...(result.invalid.length === 0
      ? []
      : ["### Malformed allowlist entries", "", ...result.invalid.map((p) => `- ${p}`), ""]),
    ...table("Accepted in infra/security/audit-allowlist.json", result.accepted),
    ...table("Warnings", result.warnings),
    ...(result.stale.length === 0
      ? []
      : [
          "### Allowlist entries no report mentions (remove them)",
          "",
          ...result.stale.map((e) => `- ${e.id} (\`${e.package}\`)`),
          "",
        ]),
  ].join("\n");
}
