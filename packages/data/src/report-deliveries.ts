import type { SupabaseClient } from "@supabase/supabase-js";
import {
  REPORT_RESULTS_BUCKET,
  runReportJobs,
  type ReportRunResult,
  type ReportRunStore,
  type ResultStorage,
  type RunLabels,
} from "./report-runs.ts";
import type { Database } from "./database.types.ts";
import type { ReportEmail, ReportMailer } from "./report-mailers.ts";

/**
 * The report.deliver worker (A43, finding A38-004; Section 4.6.4, journey 29; migration 1127). The
 * scheduler queues a report run per recipient for each due schedule; when a run succeeds the database
 * queues a report.deliver job for its delivery, and this worker emails the run's file to the
 * recipient as an attachment, then records the outcome. Recipients are members of the org only.
 * The caller composes the email (report-run: the org's branded email, 904090003).
 *
 * Mail goes through a ReportMailer: mailpitMailer sends to the local stack's Inbucket (Mailpit) and
 * refuses any host that is not this machine, so a development or test run never emails anyone; the
 * production transport is plugged in by the Edge Function from the email environment, with its
 * recipient allow-list.
 */
export * from "./report-mailers.ts";

export const REPORT_DELIVER_JOB = "report.deliver";

export interface ReportDelivery {
  readonly deliveryId: string;
  readonly orgId: string;
  readonly orgSlug: string;
  readonly orgName: string;
  readonly reportName: string;
  readonly exportFormat: Database["app"]["Enums"]["export_format"];
  readonly storagePath: string | null;
  readonly rowCount: number | null;
  readonly unpricedCount: number | null;
  readonly recipientEmail: string | null;
  readonly recipientName: string | null;
  readonly status: string;
  readonly scheduledFor: string;
  readonly recipientPersonId: string | null;
  /** The report, only for a recipient who may open it in Atlas (app.report_delivery, 904090003). */
  readonly reportDefinitionId: string | null;
  /** True when the org's suppression list stops this recipient's report email. */
  readonly suppressed: boolean;
}

export interface ReportDeliveryStore {
  /** Runs the scheduler: queues a run and a delivery per recipient of each due schedule. */
  queueDue(): Promise<number>;
  claim(worker: string, limit: number): Promise<readonly { jobId: string; deliveryId: string }[]>;
  delivery(id: string): Promise<ReportDelivery | null>;
  finish(
    id: string,
    outcome: { sent: true; messageId: string } | { sent: false; error: string },
  ): Promise<void>;
  /** Records the job attempt; answers the job's status after it (Queued means it will retry). */
  finishJob(jobId: string, succeeded: boolean, error: string | null): Promise<string>;
}

export interface ResultFiles {
  download(bucket: string, name: string): Promise<Uint8Array>;
}

/** The file a delivery's email carries. */
export type ReportAttachment = NonNullable<ReportEmail["attachment"]>;

/**
 * Builds one delivery's email around its file: the recipient, subject, text and HTML parts, headers, From name and
 * reply-to. report-run passes the org's branded report_delivery email (packages/platform edge/report-email.ts).
 */
export type ComposeReportEmail = (
  delivery: ReportDelivery,
  attachment: ReportAttachment,
) => Promise<ReportEmail>;

export interface ReportDeliveryResult {
  readonly jobId: string;
  readonly deliveryId: string;
  readonly status: "Sent" | "Failed" | "Queued" | "Skipped";
  readonly error?: string;
}

const CONTENT_TYPES = {
  CSV: "text/csv",
  XLSX: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  PDF: "application/pdf",
} as const;

/** The attachment's file name: the report name in safe characters, then the format's extension. */
export function attachmentName(report: string, format: ReportDelivery["exportFormat"]): string {
  const base = report
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return `${base || "report"}.${format.toLowerCase()}`;
}

const SUPPRESSED =
  "The recipient stopped scheduled report emails, or the address is on the organization's suppression list.";

/** One pass of the delivery worker: sends each claimed delivery once. */
export async function runReportDeliveries(options: {
  readonly store: ReportDeliveryStore;
  readonly files: ResultFiles;
  readonly mailer: ReportMailer;
  readonly compose: ComposeReportEmail;
  readonly worker: string;
  readonly limit?: number;
}): Promise<readonly ReportDeliveryResult[]> {
  const { store, files, mailer, compose, worker } = options;
  const claimed = await store.claim(worker, options.limit ?? 10);
  const results: ReportDeliveryResult[] = [];
  for (const job of claimed) {
    const d = await store.delivery(job.deliveryId);
    if (!d || d.status !== "Queued") {
      await store.finishJob(job.jobId, true, null);
      results.push({ jobId: job.jobId, deliveryId: job.deliveryId, status: "Skipped" });
      continue;
    }
    try {
      if (d.suppressed) {
        // An unsubscribe from reports or all email, a bounce, a complaint or a manual entry: never mailed, never retried.
        await store.finish(d.deliveryId, { sent: false, error: SUPPRESSED });
        await store.finishJob(job.jobId, true, null);
        results.push({
          jobId: job.jobId,
          deliveryId: d.deliveryId,
          status: "Skipped",
          error: SUPPRESSED,
        });
        continue;
      }
      if (!d.recipientEmail) throw new Error("The recipient has no email address on file.");
      if (!d.storagePath) throw new Error("The report run has no file to attach.");
      const content = await files.download(REPORT_RESULTS_BUCKET, d.storagePath);
      const sent = await mailer.send(
        await compose(d, {
          filename: attachmentName(d.reportName, d.exportFormat),
          contentType: CONTENT_TYPES[d.exportFormat],
          content,
        }),
      );
      await store.finish(d.deliveryId, { sent: true, messageId: sent.messageId });
      await store.finishJob(job.jobId, true, null);
      results.push({ jobId: job.jobId, deliveryId: d.deliveryId, status: "Sent" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const jobStatus = await store.finishJob(job.jobId, false, message);
      if (jobStatus !== "Queued") await store.finish(d.deliveryId, { sent: false, error: message });
      results.push({
        jobId: job.jobId,
        deliveryId: d.deliveryId,
        status: jobStatus === "Queued" ? "Queued" : "Failed",
        error: message,
      });
    }
  }
  return results;
}

/**
 * The whole scheduled pass the report-run Edge Function makes: queue the due schedules, render every
 * queued run (each finished run releases its deliveries), then email the deliveries.
 */
export async function runScheduledReports(options: {
  readonly runs: ReportRunStore;
  readonly storage: ResultStorage;
  readonly labels: RunLabels;
  readonly deliveries: ReportDeliveryStore;
  readonly files: ResultFiles;
  readonly mailer: ReportMailer;
  readonly compose: ComposeReportEmail;
  readonly worker: string;
}): Promise<{
  readonly queued: number;
  readonly runs: readonly ReportRunResult[];
  readonly deliveries: readonly ReportDeliveryResult[];
}> {
  const queued = await options.deliveries.queueDue();
  const runs = await runReportJobs({
    store: options.runs,
    storage: options.storage,
    labels: options.labels,
    worker: options.worker,
    limit: 25,
  });
  const deliveries = await runReportDeliveries({
    store: options.deliveries,
    files: options.files,
    mailer: options.mailer,
    compose: options.compose,
    worker: options.worker,
    limit: 25,
  });
  return { queued, runs, deliveries };
}

// Mailers ---------------------------------------------------------------------------------------------

const text = (row: Record<string, unknown>, key: string): string => {
  const value = row[key];
  if (typeof value !== "string")
    throw new Error(`Expected text in ${key} of the database response.`);
  return value;
};
const textOrNull = (row: Record<string, unknown>, key: string): string | null => {
  const value = row[key];
  return typeof value === "string" ? value : null;
};
const numberOrNull = (row: Record<string, unknown>, key: string): number | null => {
  const value = row[key];
  return typeof value === "number" ? value : null;
};

/** ReportDeliveryStore over the service-role client: the 0510 queue RPCs and the 1127 RPCs. */
export function supabaseReportDeliveryStore(client: SupabaseClient): ReportDeliveryStore {
  const app = client.schema("app");
  const call = async (fn: string, args: Record<string, unknown>): Promise<unknown> => {
    const { data, error } = await app.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data;
  };
  return {
    async queueDue() {
      return Number(await call("queue_due_report_schedules", {}));
    },
    async claim(worker, limit) {
      const rows = (await call("claim_jobs", {
        p_worker: worker,
        p_job_kind: REPORT_DELIVER_JOB,
        p_limit: limit,
      })) as Record<string, unknown>[] | null;
      return (rows ?? []).map((r) => ({ jobId: text(r, "id"), deliveryId: text(r, "subject_id") }));
    },
    async delivery(id) {
      const rows = (await call("report_delivery", { p_delivery_id: id })) as
        Record<string, unknown>[] | null;
      const r = rows?.[0];
      if (!r) return null;
      return {
        deliveryId: text(r, "delivery_id"),
        orgId: text(r, "org_id"),
        orgSlug: text(r, "org_slug"),
        orgName: text(r, "org_name"),
        reportName: text(r, "report_name"),
        exportFormat: text(r, "export_format") as ReportDelivery["exportFormat"],
        storagePath: textOrNull(r, "storage_object_path"),
        rowCount: numberOrNull(r, "row_count"),
        unpricedCount: numberOrNull(r, "unpriced_count"),
        recipientEmail: textOrNull(r, "recipient_email"),
        recipientName: textOrNull(r, "recipient_name"),
        status: text(r, "delivery_status"),
        scheduledFor: text(r, "scheduled_for"),
        recipientPersonId: textOrNull(r, "recipient_person_id"),
        reportDefinitionId: textOrNull(r, "report_definition_id"),
        suppressed: r["suppressed"] === true,
      };
    },
    async finish(id, outcome) {
      await call(
        "finish_report_delivery",
        outcome.sent
          ? { p_delivery_id: id, p_sent: true, p_provider_message_id: outcome.messageId }
          : { p_delivery_id: id, p_sent: false, p_error: outcome.error },
      );
    },
    async finishJob(jobId, succeeded, error) {
      return String(
        await call("finish_job", { p_job_id: jobId, p_succeeded: succeeded, p_error: error }),
      );
    },
  };
}

/** ResultFiles over Supabase Storage of the service-role client. */
export function supabaseResultFiles(client: SupabaseClient): ResultFiles {
  return {
    async download(bucket, name) {
      const { data, error } = await client.storage.from(bucket).download(name);
      if (error || !data) throw new Error(`storage ${bucket}: ${error?.message ?? "missing file"}`);
      return new Uint8Array(await data.arrayBuffer());
    },
  };
}
