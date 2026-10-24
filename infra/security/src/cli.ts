/**
 * Supply chain and security checks (Section 9, gate 11). Node built-ins only, so CI runs them without an
 * install:
 *
 *   node --experimental-strip-types infra/security/src/cli.ts audit
 *   node --experimental-strip-types infra/security/src/cli.ts pins [--remote]
 *   node --experimental-strip-types infra/security/src/cli.ts advisors <project-ref>   # SUPABASE_ACCESS_TOKEN
 *   node --experimental-strip-types infra/security/src/cli.ts zap <report.json> <target>
 *   node --experimental-strip-types infra/security/src/cli.ts redact <folder>   # VERCEL_AUTOMATION_BYPASS_SECRET
 *   node --experimental-strip-types infra/security/src/cli.ts sbom <sbom.cdx.json> <notices.md> <version>
 *
 * Each prints a Markdown summary, appends it to $GITHUB_STEP_SUMMARY in Actions, and exits 1 on a failure.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  checkPinAgainstTag,
  checkPinFormat,
  distinctPins,
  findUses,
  type PinProblem,
} from "./action-pins.ts";
import { advisorsSummary, evaluateAdvisors, fetchAdvisors, type AcceptedLint } from "./advisors.ts";
import {
  auditPasses,
  auditSummary,
  evaluateAudit,
  type Allowlist,
  type PnpmAuditReport,
} from "./audit.ts";
import { checkSbom, npmComponents, renderNotices, type CycloneDxBom } from "./sbom.ts";
import { evaluateZap, parseZapRules, zapSummary, type ZapReport } from "./zap.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const inActions = process.env["GITHUB_ACTIONS"] === "true";

function report(markdown: string): void {
  console.log(markdown);
  const summary = process.env["GITHUB_STEP_SUMMARY"];
  if (summary) appendFileSync(summary, `${markdown}\n`);
}

function annotate(
  level: "error" | "warning" | "notice",
  message: string,
  file?: string,
  line?: number,
): void {
  if (!inActions) return;
  const where =
    file === undefined ? "" : ` file=${file}${line === undefined ? "" : `,line=${line}`}`;
  console.log(`::${level}${where}::${message.replaceAll("\n", " ")}`);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** `pnpm audit --json` exits 1 when it finds anything; the report is still on stdout. */
function pnpmAudit(args: readonly string[]): PnpmAuditReport {
  try {
    return JSON.parse(
      execFileSync("pnpm", ["audit", "--json", ...args], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 64 << 20,
        stdio: ["ignore", "pipe", "inherit"],
      }),
    ) as PnpmAuditReport;
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout;
    if (typeof stdout === "string" && stdout.trim().startsWith("{")) {
      return JSON.parse(stdout) as PnpmAuditReport;
    }
    throw error;
  }
}

function audit(): number {
  const allowlist = readJson<Allowlist>(`${repoRoot}infra/security/audit-allowlist.json`);
  const result = evaluateAudit(
    { production: pnpmAudit(["--prod"]), tree: pnpmAudit([]) },
    allowlist,
    new Date().toISOString().slice(0, 10),
  );
  for (const f of result.failures)
    annotate("error", `${f.severity} ${f.scope} advisory ${f.id} in ${f.package}: ${f.title}`);
  for (const e of result.expired)
    annotate(
      "error",
      `Allowlisted advisory ${e.id} (${e.package}) is past its review date ${e.review_by}.`,
    );
  for (const e of result.stale)
    annotate(
      "warning",
      `Allowlisted advisory ${e.id} (${e.package}) is no longer reported; remove it.`,
    );
  report(auditSummary(result));
  return auditPasses(result) ? 0 : 1;
}

function pins(remote: boolean): number {
  const directory = `${repoRoot}.github/workflows`;
  const uses = readdirSync(directory)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .flatMap((name) =>
      findUses(`.github/workflows/${name}`, readFileSync(`${directory}/${name}`, "utf8")),
    );
  const problems: PinProblem[] = uses
    .map(checkPinFormat)
    .filter((p): p is PinProblem => p !== null);
  const verified: string[] = [];
  if (remote && problems.length === 0) {
    for (const use of distinctPins(uses)) {
      const output = execFileSync(
        "git",
        [
          "ls-remote",
          `https://github.com/${use.repository}`,
          `refs/tags/${use.version}`,
          `refs/tags/${use.version}^{}`,
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
      );
      const problem = checkPinAgainstTag(use, output);
      if (problem === null) verified.push(`- \`${use.repository}\` ${use.version}: ${use.ref}`);
      else problems.push(problem);
    }
  }
  for (const p of problems) annotate("error", p.message, p.file, p.line);
  report(
    [
      `## Actions pinned by SHA: ${problems.length === 0 ? "passed" : "failed"}`,
      "",
      `${uses.length} \`uses:\` references in .github/workflows.`,
      ...(remote
        ? [
            "",
            "Each pin equals the commit its upstream tag points at (git ls-remote):",
            "",
            ...verified,
          ]
        : []),
      ...(problems.length === 0
        ? []
        : ["", "### Problems", "", ...problems.map((p) => `- ${p.file}:${p.line} ${p.message}`)]),
    ].join("\n"),
  );
  return problems.length === 0 ? 0 : 1;
}

async function advisors(projectRef: string | undefined): Promise<number> {
  const token = process.env["SUPABASE_ACCESS_TOKEN"];
  if (!projectRef) throw new Error("Pass the Supabase project ref of staging.");
  if (!token) throw new Error("Set SUPABASE_ACCESS_TOKEN.");
  const accepted = readJson<{ accepted: AcceptedLint[] }>(
    `${repoRoot}infra/security/advisors-accepted.json`,
  ).accepted;
  const verdict = evaluateAdvisors(await fetchAdvisors(projectRef, token), accepted);
  for (const f of verdict.failures)
    annotate("error", `${f.level} ${f.kind} advisor ${f.name}: ${f.detail}`);
  report(advisorsSummary(projectRef, verdict));
  return verdict.failures.length === 0 ? 0 : 1;
}

function zap(reportPath: string | undefined, target: string | undefined): number {
  if (!reportPath || !target) throw new Error("Pass the ZAP JSON report and the target URL.");
  const rules = parseZapRules(
    readFileSync(`${repoRoot}infra/security/zap/baseline-rules.tsv`, "utf8"),
  );
  const verdict = evaluateZap(readJson<ZapReport>(reportPath), rules);
  for (const a of verdict.failures)
    annotate("error", `ZAP ${a.risk} alert ${a.pluginId} ${a.name} on ${a.example}`);
  for (const a of verdict.warnings)
    annotate("warning", `ZAP ${a.risk} alert ${a.pluginId} ${a.name} on ${a.example}`);
  report(zapSummary(target, verdict));
  return verdict.failures.length === 0 ? 0 : 1;
}

function sbom(
  sbomPath: string | undefined,
  noticesPath: string | undefined,
  version: string | undefined,
): number {
  if (!sbomPath || !noticesPath || !version)
    throw new Error("Pass the SBOM, the notices path and the version.");
  const bom = readJson<CycloneDxBom>(sbomPath);
  const problems = checkSbom(bom);
  for (const p of problems) annotate("error", `SBOM: ${p}`);
  writeFileSync(noticesPath, renderNotices(bom, version));
  const unknown = npmComponents(bom).filter((c) => c.license === "Unknown");
  report(
    [
      `## CycloneDX SBOM ${version}: ${problems.length === 0 ? "passed" : "failed"}`,
      "",
      `CycloneDX ${String(bom.specVersion)}, ${npmComponents(bom).length} npm components, ${unknown.length} without a declared license.`,
      ...problems.map((p) => `- ${p}`),
    ].join("\n"),
  );
  return problems.length === 0 ? 0 : 1;
}

/** Removes the Vercel bypass value from every report file in a folder before it is uploaded. */
function redact(directory: string | undefined): number {
  if (!directory) throw new Error("Pass the report folder.");
  const secret = process.env["VERCEL_AUTOMATION_BYPASS_SECRET"] ?? "";
  if (secret.length < 8) return 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = `${directory}/${entry.name}`;
    const text = readFileSync(path, "latin1");
    if (text.includes(secret)) writeFileSync(path, text.replaceAll(secret, "[redacted]"), "latin1");
  }
  return 0;
}

const [command, ...args] = process.argv.slice(2);
const run: Record<string, () => number | Promise<number>> = {
  audit: () => audit(),
  pins: () => pins(args.includes("--remote")),
  advisors: () => advisors(args[0]),
  zap: () => zap(args[0], args[1]),
  redact: () => redact(args[0]),
  sbom: () => sbom(args[0], args[1], args[2]),
};
const task = command === undefined ? undefined : run[command];
if (task === undefined) {
  console.error(`Usage: cli.ts <${Object.keys(run).join("|")}> ...`);
  process.exit(2);
}
process.exitCode = await task();
