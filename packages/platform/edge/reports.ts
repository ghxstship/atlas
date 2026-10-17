/**
 * The report.run and report.deliver workers for the Edge bundle (A35, RRR-79; A43, RRR-87). The
 * workers live with the report builder in @xos/data (report-runs.ts, report-deliveries.ts), so a run
 * aggregates exactly as the preview does; this file re-exports them and adds the file headers and
 * the scheduled email copy from @xos/i18n.
 */
import { defaultLocale, getMessages, isLocale } from "@xos/i18n";
import type { DeliveryCopy } from "../../data/src/report-deliveries.ts";
import type { RunLabels } from "../../data/src/report-runs.ts";

export {
  REPORT_DELIVER_JOB,
  mailpitMailer,
  resendMailer,
  runReportDeliveries,
  runScheduledReports,
  supabaseReportDeliveryStore,
  supabaseResultFiles,
  type ReportMailer,
} from "../../data/src/report-deliveries.ts";

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

/** Fills the `{name}` slots of a catalog template with their values. */
function fill(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (all, name: string) =>
    values[name] === undefined ? all : String(values[name]),
  );
}

/** Column headers and file copy of a run file in a locale (en-US when unknown). */
export function reportRunLabels(locale: string): RunLabels {
  const known = isLocale(locale) ? locale : defaultLocale;
  const messages = getMessages(known) as unknown as Tree;
  const field = (source: string, key: string) =>
    lookup(messages, ["workflow", "builder", "fields", source, key]) ?? key;
  const file = (key: string) => lookup(messages, ["reporting", "file", key]) ?? key;
  return {
    field,
    unpriced: file("unpriced"),
    truncated: file("truncated"),
    subtitle: ({ rows, unpriced, at }) =>
      fill(file("subtitle"), {
        rows,
        unpriced,
        date: new Intl.DateTimeFormat(known, { dateStyle: "medium", timeZone: "UTC" }).format(at),
      }),
    column(source, key, aggregate) {
      const template = lookup(messages, ["workflow", "builder", "columnAggregate"]);
      const name = lookup(messages, ["workflow", "builder", "aggregates", aggregate]) ?? aggregate;
      return template === null
        ? `${name} ${field(source, key)}`
        : template.replace("{aggregate}", name).replace("{field}", field(source, key));
    },
  };
}

/** The scheduled report email in a locale (en-US when unknown). */
export function reportDeliveryCopy(locale: string): DeliveryCopy {
  const messages = getMessages(isLocale(locale) ? locale : defaultLocale) as unknown as Tree;
  const email = (key: string) => lookup(messages, ["reporting", "email", key]) ?? key;
  return {
    subject: (values) => fill(email("subject"), values),
    body: (values) => fill(email("body"), values),
  };
}
