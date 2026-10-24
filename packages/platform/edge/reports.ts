/**
 * The report.run and report.deliver workers for the Edge bundle (A35, RRR-79; A43, RRR-87). The
 * workers live with the report builder in @xos/data (report-runs.ts, report-deliveries.ts), so a run
 * aggregates exactly as the preview does; this file re-exports them and adds the file headers and
 * the scheduled email copy from @xos/i18n. Only the two namespaces the copy uses (workflow and
 * reporting) are read, and each locale's pair loads the first time a run asks for that locale (A85).
 */
import { defaultLocale, isLaunchLocale, type LaunchLocale } from "@xos/i18n/locales";
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

export { READ_REPLICA_ENV, readReplicaUrl } from "../../data/src/read-replica.ts";

type Tree = { readonly [key: string]: Tree | string };

/**
 * The workflow and reporting namespaces of each launch locale, loaded on first use. A Beta locale (ADR 0053)
 * reads en-US here: the Edge bundle carries no Beta catalog.
 */
const namespaces: Readonly<Record<LaunchLocale, () => Promise<Tree>>> = {
  "en-US": async () => {
    const [workflow, reporting] = await Promise.all([
      import("@xos/i18n/messages/en-US/workflow.json", { with: { type: "json" } }),
      import("@xos/i18n/messages/en-US/reporting.json", { with: { type: "json" } }),
    ]);
    return { workflow: workflow.default, reporting: reporting.default };
  },
  "es-US": async () => {
    const [workflow, reporting] = await Promise.all([
      import("@xos/i18n/messages/es-US/workflow.json", { with: { type: "json" } }),
      import("@xos/i18n/messages/es-US/reporting.json", { with: { type: "json" } }),
    ]);
    return { workflow: workflow.default, reporting: reporting.default };
  },
};

function messagesFor(locale: string): Promise<Tree> {
  return namespaces[isLaunchLocale(locale) ? locale : defaultLocale]();
}

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
export async function reportRunLabels(locale: string): Promise<RunLabels> {
  const known = isLaunchLocale(locale) ? locale : defaultLocale;
  const messages = await messagesFor(known);
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
export async function reportDeliveryCopy(locale: string): Promise<DeliveryCopy> {
  const messages = await messagesFor(locale);
  const email = (key: string) => lookup(messages, ["reporting", "email", key]) ?? key;
  return {
    subject: (values) => fill(email("subject"), values),
    body: (values) => fill(email("body"), values),
  };
}
