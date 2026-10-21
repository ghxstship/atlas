// Report worker (A35, RRR-79; A43, RRR-87): queues the due report schedules (migration 1127), claims due
// report.run jobs and reads each run's rows as the person it runs for (1050, app.report_run_rows),
// aggregates them as the report builder preview does, stores the CSV, .xlsx or PDF (1126) in the private
// report-results bucket, then emails each scheduled delivery's file to its recipient. Called on a schedule
// with the service key, like webhook-dispatch and upload-scan.
//
// Mail: XOS_REPORT_MAILPIT_URL sends to the local stack's Inbucket (Mailpit) and only to a local host;
// otherwise XOS_EMAIL_TRANSPORT=resend sends through Resend to recipients XOS_EMAIL_ALLOWLIST allows (any
// recipient only with XOS_EMAIL_DELIVER_TO_ANY=true, production, Section 19.8). With neither, deliveries
// fail with the reason and nothing is sent.
//
// Resend, exceljs and pdfkit load only when a run needs them (A85), and the file and email copy load per
// locale on first use.
import { createClient } from "@supabase/supabase-js";
import {
  lazyResendClient,
  mailpitMailer,
  readEmailEnv,
  recipientAllowed,
  reportDeliveryCopy,
  reportRunLabels,
  resendMailer,
  runScheduledReports,
  supabaseReportDeliveryStore,
  supabaseReportRunStore,
  supabaseResultFiles,
  supabaseResultStorage,
  type ReportMailer,
} from "../_vendor/report-run.js";
import { env, hasBearer, json, serve } from "../_shared/runtime.ts";

function reportMailer(): ReportMailer {
  const emailEnv = readEmailEnv(Deno.env.toObject());
  const address = emailEnv.XOS_EMAIL_FROM.replace(/^.*<([^>]+)>$/, "$1");
  const mailpit = Deno.env.get("XOS_REPORT_MAILPIT_URL");
  if (mailpit) return mailpitMailer(mailpit, { email: address, name: "XOS Reports" });
  if (emailEnv.XOS_EMAIL_TRANSPORT === "resend" && emailEnv.RESEND_API_KEY) {
    const policy = {
      allowed: emailEnv.XOS_EMAIL_ALLOWLIST,
      deliverToAny: emailEnv.XOS_EMAIL_DELIVER_TO_ANY,
    };
    return resendMailer(lazyResendClient(emailEnv.RESEND_API_KEY), emailEnv.XOS_EMAIL_FROM, (to) =>
      recipientAllowed(to, policy),
    );
  }
  return {
    name: "none",
    send: () => {
      throw new Error("No email transport is configured for scheduled reports.");
    },
  };
}

serve(async (request) => {
  if (!hasBearer(request, env("SUPABASE_SERVICE_ROLE_KEY"))) {
    return json(401, { type: "/problems/unauthorized", title: "Unauthorized", status: 401 });
  }
  const client = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const outcome = await runScheduledReports({
    runs: supabaseReportRunStore(client),
    storage: supabaseResultStorage(client),
    labels: await reportRunLabels("en-US"),
    deliveries: supabaseReportDeliveryStore(client),
    files: supabaseResultFiles(client),
    mailer: reportMailer(),
    copy: await reportDeliveryCopy("en-US"),
    worker: `report-run:${crypto.randomUUID()}`,
  });
  return json(200, {
    queued: outcome.queued,
    processed: outcome.runs.length,
    results: outcome.runs,
    delivered: outcome.deliveries,
  });
});
