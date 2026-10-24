/**
 * Supabase advisors against a hosted project (gate 11), through the Management API:
 *
 *   GET https://api.supabase.com/v1/projects/{ref}/advisors/security
 *   GET https://api.supabase.com/v1/projects/{ref}/advisors/performance
 *
 * The same splinter lints `infra/security/supabase-advisors.sh` runs against the local stack, plus the ones
 * only a hosted project has (Auth settings, the Postgres version). Any WARN or ERROR fails, as locally,
 * unless `infra/security/advisors-accepted.json` lists the lint by name with a reason; INFO is reported only.
 */

export type AdvisorKind = "security" | "performance";

export interface Lint {
  readonly name: string;
  readonly title?: string;
  readonly level: string;
  readonly description?: string;
  readonly detail?: string;
  readonly remediation?: string;
  readonly categories?: readonly string[];
  readonly cache_key?: string;
}

export interface AcceptedLint {
  /** The lint name, for example `auth_leaked_password_protection`. */
  readonly name: string;
  /** Narrows the acceptance to lints whose cache_key contains this text (one table or function). */
  readonly match?: string;
  readonly reason: string;
  readonly recorded: string;
}

export interface AdvisorFinding {
  readonly kind: AdvisorKind;
  readonly name: string;
  readonly level: "ERROR" | "WARN" | "INFO";
  readonly title: string;
  readonly detail: string;
  readonly remediation: string;
}

export interface AdvisorVerdict {
  readonly failures: readonly AdvisorFinding[];
  readonly accepted: readonly AdvisorFinding[];
  readonly info: readonly AdvisorFinding[];
}

const PROJECT_REF = /^[a-z]{20}$/;

export function advisorsUrl(projectRef: string, kind: AdvisorKind): string {
  if (!PROJECT_REF.test(projectRef))
    throw new Error(`"${projectRef}" is not a Supabase project ref`);
  return `https://api.supabase.com/v1/projects/${projectRef}/advisors/${kind}`;
}

function levelOf(value: string): AdvisorFinding["level"] {
  const upper = value.toUpperCase();
  return upper === "INFO" || upper === "WARN" ? upper : "ERROR";
}

export function evaluateAdvisors(
  results: ReadonlyArray<{ readonly kind: AdvisorKind; readonly lints: readonly Lint[] }>,
  accepted: readonly AcceptedLint[],
): AdvisorVerdict {
  const failures: AdvisorFinding[] = [];
  const kept: AdvisorFinding[] = [];
  const info: AdvisorFinding[] = [];
  for (const { kind, lints } of results) {
    for (const lint of lints) {
      const finding: AdvisorFinding = {
        kind,
        name: lint.name,
        level: levelOf(lint.level),
        title: lint.title ?? lint.name,
        detail: lint.detail ?? lint.description ?? "",
        remediation: lint.remediation ?? "",
      };
      if (finding.level === "INFO") {
        info.push(finding);
        continue;
      }
      const isAccepted = accepted.some(
        (a) =>
          a.name === lint.name &&
          a.reason.trim().length >= 20 &&
          (a.match === undefined || (lint.cache_key ?? "").includes(a.match)),
      );
      (isAccepted ? kept : failures).push(finding);
    }
  }
  return { failures, accepted: kept, info };
}

export function advisorsSummary(projectRef: string, verdict: AdvisorVerdict): string {
  const rows = (findings: readonly AdvisorFinding[]) => [
    "| Level | Kind | Lint | Detail |",
    "| --- | --- | --- | --- |",
    ...findings.map(
      (f) =>
        `| ${f.level} | ${f.kind} | [${f.name}](${f.remediation}) | ${f.detail.replaceAll("|", "\\|").replaceAll("\n", " ")} |`,
    ),
    "",
  ];
  return [
    `## Supabase advisors for ${projectRef}: ${verdict.failures.length === 0 ? "passed" : "failed"}`,
    "",
    ...(verdict.failures.length > 0 ? ["### WARN and ERROR", "", ...rows(verdict.failures)] : []),
    ...(verdict.accepted.length > 0
      ? ["### Accepted in infra/security/advisors-accepted.json", "", ...rows(verdict.accepted)]
      : []),
    `${verdict.info.length} INFO lint(s), not shown (unused indexes on a quiet database, tables with RLS and no policy by design).`,
  ].join("\n");
}

/** Fetches both advisor kinds with a bearer token. `fetchImpl` is injectable for tests. */
export async function fetchAdvisors(
  projectRef: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ kind: AdvisorKind; lints: Lint[] }[]> {
  const kinds: AdvisorKind[] = ["security", "performance"];
  return Promise.all(
    kinds.map(async (kind) => {
      const response = await fetchImpl(advisorsUrl(projectRef, kind), {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(
          `The Management API answered ${response.status} for the ${kind} advisors of ${projectRef}.`,
        );
      }
      const body = (await response.json()) as { lints?: Lint[] };
      return { kind, lints: body.lints ?? [] };
    }),
  );
}
