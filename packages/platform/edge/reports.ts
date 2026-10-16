/**
 * The report.run worker for the Edge bundle (A35, RRR-79). The worker itself lives with the report
 * builder in @xos/data (report-runs.ts), so a run aggregates exactly as the preview does; this file
 * re-exports it and adds the CSV headers from the report builder copy in @xos/i18n.
 */
import { defaultLocale, getMessages, isLocale } from "@xos/i18n";
import type { RunLabels } from "../../data/src/report-runs.ts";

export {
  REPORT_RESULTS_BUCKET,
  REPORT_RUN_JOB,
  runReportJobs,
  supabaseReportRunStore,
  supabaseResultStorage,
  type ReportRunResult,
} from "../../data/src/report-runs.ts";

type Tree = { readonly [key: string]: Tree | string };

function lookup(tree: Tree, path: readonly string[]): string | null {
  let node: Tree | string | undefined = tree;
  for (const part of path) {
    if (typeof node !== "object" || node === null) return null;
    node = node[part];
  }
  return typeof node === "string" ? node : null;
}

/** Column headers of a run file in a locale (en-US when unknown), from the builder's field labels. */
export function reportRunLabels(locale: string): RunLabels {
  const messages = getMessages(isLocale(locale) ? locale : defaultLocale) as unknown as Tree;
  const field = (source: string, key: string) =>
    lookup(messages, ["workflow", "builder", "fields", source, key]) ?? key;
  return {
    field,
    column(source, key, aggregate) {
      const template = lookup(messages, ["workflow", "builder", "columnAggregate"]);
      const name = lookup(messages, ["workflow", "builder", "aggregates", aggregate]) ?? aggregate;
      return template === null
        ? `${name} ${field(source, key)}`
        : template.replace("{aggregate}", name).replace("{field}", field(source, key));
    },
  };
}
