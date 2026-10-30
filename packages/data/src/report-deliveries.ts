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

/**
 * The report.deliver worker (A43, finding A38-004; Section 4.6.4, journey 29; migration 1127). The
 * scheduler queues a report run per recipient for each due schedule; when a run succeeds the database
 * queues a report.deliver job for its delivery, and this worker emails the run's file to the
 * recipient as an attachment, then records the outcome. Recipients are members of the org only.
 *
 * Mail goes through a ReportMailer: mailpitMailer sends to the local stack's Inbucket (Mailpit) and
 * refuses any host that is not this machine, so a development or test run never emails anyone; the
 * production transport is plugged in by the Edge Function from the email environment, with its
 * recipient allow-list.
 */
export const REPORT_DELIVER_JOB = "report.deliver";

export interface ReportDelivery {
  readonly deliveryId: string;
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

export interface ReportEmail {
  readonly to: string;
  readonly toName: string | null;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly attachment: {
    readonly filename: string;
    readonly contentType: string;
    readonly content: Uint8Array;
  };
}

export interface ReportMailer {
  readonly name: string;
  send(email: ReportEmail): Promise<{ readonly messageId: string }>;
}

/** The email copy, in the recipient's language where the caller knows it. */
export interface DeliveryCopy {
  subject(input: { readonly report: string; readonly org: string }): string;
  body(input: {
    readonly report: string;
    readonly org: string;
    readonly rows: number;
    readonly unpriced: number;
  }): string;
}

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

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The attachment's file name: the report name in safe characters, then the format's extension. */
export function attachmentName(report: string, format: ReportDelivery["exportFormat"]): string {
  const base = report
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return `${base || "report"}.${format.toLowerCase()}`;
}

/** One pass of the delivery worker: sends each claimed delivery once. */
export async function runReportDeliveries(options: {
  readonly store: ReportDeliveryStore;
  readonly files: ResultFiles;
  readonly mailer: ReportMailer;
  readonly copy: DeliveryCopy;
  readonly worker: string;
  readonly limit?: number;
}): Promise<readonly ReportDeliveryResult[]> {
  const { store, files, mailer, copy, worker } = options;
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
      if (!d.recipientEmail) throw new Error("The recipient has no email address on file.");
      if (!d.storagePath) throw new Error("The report run has no file to attach.");
      const content = await files.download(REPORT_RESULTS_BUCKET, d.storagePath);
      const words = { report: d.reportName, org: d.orgName };
      const body = copy.body({ ...words, rows: d.rowCount ?? 0, unpriced: d.unpricedCount ?? 0 });
      const sent = await mailer.send({
        to: d.recipientEmail,
        toName: d.recipientName,
        subject: copy.subject(words),
        text: body,
        html: `<p>${escapeHtml(body)}</p>`,
        attachment: {
          filename: attachmentName(d.reportName, d.exportFormat),
          contentType: CONTENT_TYPES[d.exportFormat],
          content,
        },
      });
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
  readonly copy: DeliveryCopy;
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
    copy: options.copy,
    worker: options.worker,
    limit: 25,
  });
  return { queued, runs, deliveries };
}

// Mailers ---------------------------------------------------------------------------------------------

/** Base64 of bytes without Node's Buffer, so the Edge runtime can use it too. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1", "host.docker.internal"]);

/**
 * Sends through Mailpit's HTTP API (`POST /api/v1/send`), the Inbucket of a local Supabase stack.
 * Only a local host is accepted (or a Docker service name of a supabase_inbucket container), so this
 * mailer can never reach a real recipient (Section 19.8).
 */
export function mailpitMailer(
  baseUrl: string,
  from: { readonly email: string; readonly name: string },
  fetchImpl: typeof fetch = fetch,
): ReportMailer {
  const url = new URL(baseUrl);
  if (!LOCAL_HOSTS.has(url.hostname) && !url.hostname.startsWith("supabase_inbucket_")) {
    throw new Error(`The Mailpit mailer only sends to a local inbox, not ${url.hostname}.`);
  }
  return {
    name: "mailpit",
    async send(email) {
      const response = await fetchImpl(new URL("/api/v1/send", url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          From: { Email: from.email, Name: from.name },
          To: [{ Email: email.to, Name: email.toName ?? "" }],
          Subject: email.subject,
          Text: email.text,
          HTML: email.html,
          Attachments: [
            {
              Content: toBase64(email.attachment.content),
              Filename: email.attachment.filename,
              ContentType: email.attachment.contentType,
            },
          ],
        }),
      });
      if (!response.ok) {
        throw new Error(`Mailpit refused the message: ${response.status} ${await response.text()}`);
      }
      const json = (await response.json()) as { ID?: string };
      return { messageId: json.ID ?? "" };
    },
  };
}

/** The part of the Resend client a production mailer needs. */
export interface ResendLike {
  readonly emails: {
    send(payload: {
      from: string;
      to: string[];
      subject: string;
      text: string;
      html: string;
      attachments: { filename: string; content: string; contentType?: string }[];
    }): Promise<{ data: { id: string } | null; error: { message: string } | null }>;
  };
}

/**
 * Sends through the owner's Resend account, only to recipients `allowed` accepts (the email
 * environment's allow-list outside production, Section 19.8).
 */
export function resendMailer(
  client: ResendLike,
  from: string,
  allowed: (address: string) => boolean,
): ReportMailer {
  return {
    name: "resend",
    async send(email) {
      if (!allowed(email.to)) throw new Error(`${email.to} is outside the email allow-list.`);
      const { data, error } = await client.emails.send({
        from,
        to: [email.to],
        subject: email.subject,
        text: email.text,
        html: email.html,
        attachments: [
          {
            filename: email.attachment.filename,
            content: toBase64(email.attachment.content),
            contentType: email.attachment.contentType,
          },
        ],
      });
      if (error || !data) throw new Error(`Resend refused the message: ${error?.message ?? ""}`);
      return { messageId: data.id };
    },
  };
}

// Stores --------------------------------------------------------------------------------------------

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
