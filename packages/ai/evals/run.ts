import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AnthropicModelClient, anthropicConfigured } from "../src/anthropic.ts";
import { AI_FEATURES, isAiFeature, type AiFeature } from "../src/model.ts";
import { baselineThresholds, belowThreshold, runSuite, type Thresholds } from "./suite.ts";

/**
 * `pnpm --filter @xos/ai evals [feature ...] [--write-baseline]`
 *
 * Runs the fixed test sets against the configured Claude models and fails (exit 1) when any feature
 * drops below its threshold in thresholds.json (Section 18, gate 21). Without an Anthropic API key
 * on the host it reports that it skipped and exits 0, so CI runs it only where the secret exists.
 * `--write-baseline` records a passing run as the baseline and sets thresholds from it.
 */

const thresholdsPath = fileURLToPath(new URL("./thresholds.json", import.meta.url));
const args = process.argv.slice(2);
const writeBaseline = args.includes("--write-baseline");
const requested = args.filter((a) => !a.startsWith("--"));
const unknown = requested.filter((a) => !isAiFeature(a));
if (unknown.length > 0) {
  console.error(`Unknown features: ${unknown.join(", ")}. Choose from ${AI_FEATURES.join(", ")}.`);
  process.exit(2);
}
const features: AiFeature[] = requested.length > 0 ? (requested as AiFeature[]) : [...AI_FEATURES];

if (!anthropicConfigured()) {
  console.log("Aurora evals skipped: no Anthropic API key is configured on this host.");
  process.exit(0);
}

const thresholds = JSON.parse(readFileSync(thresholdsPath, "utf8")) as Thresholds;
const reports = await runSuite(new AnthropicModelClient(), features);
for (const report of reports) {
  const threshold = thresholds.features[report.feature]?.threshold ?? 1;
  console.log(
    `${report.feature} (${report.model}): ${(report.accuracy * 100).toFixed(1)} percent, threshold ${(threshold * 100).toFixed(0)} percent`,
  );
  for (const c of report.cases.filter((x) => !x.pass)) console.log(`  failed ${c.id}: ${c.detail}`);
}

const failing = belowThreshold(reports, thresholds);
if (writeBaseline) {
  if (failing.length > 0) {
    console.error(
      "A baseline is recorded only from a run where every feature meets its current threshold.",
    );
    process.exit(1);
  }
  const next = baselineThresholds(reports, thresholds, new Date().toISOString().slice(0, 10));
  writeFileSync(thresholdsPath, `${JSON.stringify(next, null, 2)}\n`);
  console.log("Baseline written to thresholds.json.");
}
if (failing.length > 0) {
  console.error(`Below threshold: ${failing.map((r) => r.feature).join(", ")}.`);
  process.exit(1);
}
