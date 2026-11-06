// Org lifecycle worker (A79, RRR-124; migrations 1351 and 1355). Called on a schedule with the service key,
// like report-run and upload-scan:
//   1. Deletion certificates (Section 14.7): deletes the storage objects of each org due for deletion through
//      the Storage API, so the hourly lifecycle job can purge its rows; then renders each purged org's
//      certificate (tagged PDF/UA), stores it in the private deletion-certificates bucket and emails it to
//      the former Owner.
//   2. Custom domains (Section 12): domain.provision, domain.check and domain.release jobs through the Vercel
//      Domains API (Atlas and Gateway hosts) and the Resend domains API (sending domains).
//   3. Stripe cancels (ADR 0161, migration 6140): sends each cancel that is due and has not been accepted, retrying with
//      backoff until it is, then closes Checkout sessions on orgs that are ending and emails open billing alerts to
//      XOS_BILLING_ALERT_EMAIL. It runs first, since an org cannot finish deletion until its cancel is accepted.
//
// Mail: XOS_LIFECYCLE_MAILPIT_URL sends to the local stack's Inbucket (Mailpit) and only to a local host;
// otherwise XOS_EMAIL_TRANSPORT=resend sends through Resend to recipients XOS_EMAIL_ALLOWLIST allows (any
// recipient only with XOS_EMAIL_DELIVER_TO_ANY=true). With neither, certificates wait and say why.
// Domains: VERCEL_API_TOKEN with VERCEL_PROJECT_ID_ATLAS and VERCEL_PROJECT_ID_GATEWAY (and VERCEL_TEAM_ID for a
// team), and RESEND_DOMAINS_API_KEY. A provider left unset records its domains as not set up yet.
// Stripe: STRIPE_SECRET_KEY, already set for stripe-webhook. Without it, cancels stay queued and say so.
// Every secret is the owner's (infra/runbooks/org-lifecycle.md); none is read anywhere else.
//
// The certificate renderer (pdfkit and its fonts) and Resend load only when a certificate is rendered or sent
// (A85, cold starts).
import { createClient } from "@supabase/supabase-js";
import {
  billingLivemode,
  createStripeClient,
  deletionCertificateCopy,
  documentMessages,
  httpFromFetch,
  lazyResendClient,
  mailpitMailer,
  readBillingEnv,
  readEmailEnv,
  recipientAllowed,
  renderDeletionCertificate,
  resendMailer,
  resendSendingDomains,
  runDeletionCertificates,
  runDomainJobs,
  runStripeCancellations,
  stripeCancellationStore,
  supabaseDomainJobStore,
  supabasePurgeStorage,
  supabasePurgeStore,
  vercelHosts,
  type BillingAlert,
  type DomainProviders,
  type ReportMailer,
} from "../_vendor/org-lifecycle.js";
import { env, hasBearer, json, serve, serviceDb } from "../_shared/runtime.ts";

const optional = (name: string): string | null => {
  const value = Deno.env.get(name);
  return value && value.length > 0 ? value : null;
};

function lifecycleMailer(): ReportMailer {
  const emailEnv = readEmailEnv(Deno.env.toObject());
  const address = emailEnv.XOS_EMAIL_FROM.replace(/^.*<([^>]+)>$/, "$1");
  const mailpit = optional("XOS_LIFECYCLE_MAILPIT_URL");
  if (mailpit) return mailpitMailer(mailpit, { email: address, name: "XOS" });
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
      throw new Error("No email transport is configured for deletion certificates.");
    },
  };
}

function domainProviders(): DomainProviders {
  const http = httpFromFetch(fetch);
  const token = optional("VERCEL_API_TOKEN");
  const teamId = optional("VERCEL_TEAM_ID");
  const host = (projectId: string | null) =>
    token && projectId ? vercelHosts(http, { token, projectId, teamId }) : null;
  const resendKey = optional("RESEND_DOMAINS_API_KEY");
  return {
    atlas: host(optional("VERCEL_PROJECT_ID_ATLAS")),
    gateway: host(optional("VERCEL_PROJECT_ID_GATEWAY")),
    sending: resendKey ? resendSendingDomains(http, { token: resendKey }) : null,
  };
}

/** Emails a billing alert to the platform owner. Without an address it waits, and the console and the logs still show it. */
function billingAlertSink(mailer: ReportMailer) {
  const to = optional("XOS_BILLING_ALERT_EMAIL");
  if (to === null) return null;
  return {
    send: async (alert: BillingAlert) => {
      const text = `${alert.detail}\n\nAlert ${alert.alertId}, raised ${alert.raisedAt}.`;
      await mailer.send({
        to,
        toName: null,
        subject: `XOS billing alert: ${alert.kind}`,
        text,
        html: `<p>${text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c)}</p>`,
        attachment: {
          filename: "billing-alert.txt",
          contentType: "text/plain",
          content: new TextEncoder().encode(text),
        },
      });
    },
  };
}

/** Stripe cancels and billing alerts. A failure here is logged and never stops certificates or domains. */
async function stripeCancellations(worker: string) {
  try {
    const billing = readBillingEnv(Deno.env.toObject());
    const run = await runStripeCancellations({
      stripe: billing.STRIPE_SECRET_KEY ? await createStripeClient(billing) : null,
      store: stripeCancellationStore(serviceDb()),
      worker,
      livemode: billingLivemode(billing),
      sink: billingAlertSink(lifecycleMailer()),
    });
    // Sentry and the log drain see this whatever the mail does.
    if (run.failed > 0 || run.alertsWaiting > 0) {
      console.error(JSON.stringify({ event: "billing_attention_needed", ...run }));
    }
    return run;
  } catch (error) {
    console.error(
      JSON.stringify({ event: "billing_worker_failed", error: String(error).slice(0, 500) }),
    );
    return { failed: true };
  }
}

serve(async (request) => {
  if (!hasBearer(request, env("SUPABASE_SERVICE_ROLE_KEY"))) {
    return json(401, { type: "/problems/unauthorized", title: "Unauthorized", status: 401 });
  }
  const client = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const atlas = (optional("ATLAS_SITE_URL") ?? "https://atlas.invalid").replace(/\/+$/, "");
  const worker = `org-lifecycle:${crypto.randomUUID()}`;
  const stripe = await stripeCancellations(worker);
  const certificates = await runDeletionCertificates({
    store: supabasePurgeStore(client),
    storage: supabasePurgeStorage(client),
    render: (certificate) =>
      renderDeletionCertificate(certificate, {
        locale: certificate.locale,
        messages: documentMessages(certificate.locale),
        recordUrl: `${atlas}/deletion-certificates/${certificate.id}`,
      }),
    mailer: lifecycleMailer(),
    copy: deletionCertificateCopy,
    worker,
  });
  const domains = await runDomainJobs({
    store: supabaseDomainJobStore(client.schema("app")),
    providers: domainProviders(),
    worker,
  });
  return json(200, { stripe, certificates, domains });
});
