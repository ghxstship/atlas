/**
 * Synthetic check runner for the scheduler (GitHub Actions on the free tier, see infra/README.md).
 *
 *   node --experimental-strip-types infra/synthetics/src/cli.ts --history status-data/history.json
 *
 * Reads targets and the synthetic user from the environment, runs every check, folds the results
 * into the history file the status page renders, prints one alert line per failure and, when
 * XOS_ALERT_WEBHOOK_URL is set, posts them to the on-call channel. Exits 1 when a required check
 * fails, so the scheduled run is marked failed and GitHub notifies the on-call rotation too.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CHECKS } from "./checks.ts";
import { failingRequired, formatAlerts, parseHistory, recordRun, runChecks } from "./run.ts";

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

const history = recordRun(
  parseHistory(existsSync(historyPath) ? readFileSync(historyPath, "utf8") : null),
  results,
  new Date(),
);
mkdirSync(dirname(historyPath), { recursive: true });
writeFileSync(historyPath, `${JSON.stringify(history, null, 2)}\n`);

const alerts = formatAlerts(results, repository);
for (const line of alerts) console.error(`::error::${line}`);

const webhook = process.env["XOS_ALERT_WEBHOOK_URL"];
if (webhook && alerts.length > 0) {
  const response = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: alerts.join("\n") }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) console.error(`::warning::Alert webhook answered ${response.status}.`);
}

process.exit(failingRequired(CHECKS, results).length > 0 ? 1 : 0);
