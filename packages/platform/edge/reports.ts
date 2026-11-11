/**
 * The report.run and report.deliver workers for the Edge bundle (A35, RRR-79; A43, RRR-87). The
 * workers live with the report builder in @xos/data (report-runs.ts, report-deliveries.ts), so a run
 * aggregates exactly as the preview does; this file re-exports them and adds the file headers from
 * @xos/i18n. Only the two namespaces the headers use (workflow and reporting) are read, and each
 * locale's pair loads the first time a run asks for that locale (A85). The scheduled report and
 * stakeholder pack emails are the org's branded packages/email emails (report-email.ts), loaded the
 * first time a delivery needs one.
 */
import { defaultLocale, isLaunchLocale, type LaunchLocale } from "@xos/i18n/locales";
import type { ComposeReportEmail } from "../../data/src/report-deliveries.ts";
import type { RunLabels } from "../../data/src/report-runs.ts";
import type { ComposePackEmail } from "../../data/src/stakeholder-packs.ts";
import type { PackEmailOptions, ReportEmailOptions } from "./report-email.ts";

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

/** The pack.deliver worker, loaded when a run reaches it, so report-run's boot stays inside its budget. */
export const loadPackDeliveries = () => import("../../data/src/stakeholder-packs.ts");

/** The branded report and pack emails, with React Email, loaded the first time a delivery needs one. */
export const loadReportEmail = () => import("./report-email.ts");

/** The org's branded scheduled report email, its module loaded on the first delivery. */
export function lazyReportEmailComposer(options: ReportEmailOptions): ComposeReportEmail {
  let built: ComposeReportEmail | null = null;
  return async (delivery, attachment) => {
    built ??= (await loadReportEmail()).reportEmailComposer(options);
    return built(delivery, attachment);
  };
}

/** The org's branded stakeholder pack email, its module loaded on the first delivery. */
export function lazyPackEmailComposer(options: PackEmailOptions): ComposePackEmail {
  let built: ComposePackEmail | null = null;
  return async (link, links, env) => {
    built ??= (await loadReportEmail()).packEmailComposer(options);
    return built(link, links, env);
  };
}

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
    // A102: a report PDF whose columns classify above Internal names its viewer and the time (Section 8.6).
    watermark: ({ email, at }) =>
      fill(file("watermark"), {
        email,
        time: new Intl.DateTimeFormat(known, {
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          timeZone: "UTC",
          timeZoneName: "short",
        }).format(at),
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
