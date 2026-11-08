/**
 * Synthetic check runner for the scheduler (.github/workflows/synthetics.yml; infra/ci/README.md).
 *
 *   node --experimental-strip-types infra/synthetics/src/cli.ts --history status-data/history.json
 *
 * Reads targets from the environment, runs every check it has the settings for, and folds the results
 * into the history file the status page renders. A required check alerts on its second failure in a row:
 * the line goes to the on-call channel when XOS_ALERT_WEBHOOK_URL is set, and the run exits 1, so GitHub
 * notifies too. A run in the middle of an outage that is not due a reminder stays quiet and exits 0;
 * its log, its summary and the status page still show the failure.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CHECKS } from "./checks.ts";
import {
  decideAlerts,
  failingRequired,
  formatAlerts,
  parseHistory,
  postAlerts,
  publicResults,
  recordRun,
  runChecks,
} from "./run.ts";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const historyPath = argument("--history") ?? "status-data/history.json";
const region = process.env["XOS_SYNTHETICS_REGION"] ?? "us-east";
const repository = `${process.env["GITHUB_SERVER_URL"] ?? "https://github.com"}/${process.env["GITHUB_REPOSITORY"] ?? "ghxstship/atlas"}`;

const results = await runChecks(CHECKS, { env: process.env, region });
for (const result of results) {
  console.log(JSON.stringify(result));
}

const before = parseHistory(existsSync(historyPath) ? readFileSync(historyPath, "utf8") : null);
// The history is the public status page's: checks marked internal (the legal queue heartbeat) stay out of it.
const shown = publicResults(CHECKS, results);
const after = recordRun(before, shown, new Date());
mkdirSync(dirname(historyPath), { recursive: true });
writeFileSync(historyPath, `${JSON.stringify(after, null, 2)}\n`);

const decision = decideAlerts(CHECKS, shown, before, after, repository);
// An internal check has no public history to confirm a failure against, so it alerts on every failed run, as it did
// before confirmation existed.
const internalFailing = failingRequired(
  CHECKS.filter((c) => c.internal),
  results,
);
const lines = [...decision.lines, ...formatAlerts(internalFailing, repository)];
for (const line of lines) console.error(line);
for (const result of [...decision.failing, ...internalFailing]) {
  console.error(`::warning::${result.id} failed: ${result.detail ?? "unknown"}`);
}

const warning = await postAlerts(process.env["XOS_ALERT_WEBHOOK_URL"], lines);
if (warning) console.error(`::warning::${warning}`);

// The workflow publishes the status page when a failure was confirmed or a confirmed failure ended.
const output = process.env["GITHUB_OUTPUT"];
if (output) appendFileSync(output, `changed=${decision.changed}\n`);
const summary = process.env["GITHUB_STEP_SUMMARY"];
if (summary) {
  // recordRun leaves out a result that starts too soon after the last recorded one (MIN_RUN_GAP_MS).
  const counted = (r: (typeof results)[number]) =>
    r.status === "skipped" || !shown.includes(r) || after.regions[r.region]?.[r.id]?.last === r;
  const rows = results.map(
    (r) =>
      `| ${r.id} | ${r.status}${counted(r) ? "" : " (not counted: too soon after the last run)"} | ${r.latencyMs ?? ""} | ${r.detail ?? ""} |`,
  );
  appendFileSync(
    summary,
    `### Synthetic checks\n\n| Check | Result | ms | Detail |\n| --- | --- | --- | --- |\n${rows.join("\n")}\n`,
  );
}

process.exit(decision.alerted || internalFailing.length > 0 ? 1 : 0);
