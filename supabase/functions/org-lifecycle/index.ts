// Org lifecycle worker (A79, RRR-124; migrations 1351 and 1355). Called on a schedule with the service key,
// like report-run and upload-scan:
//   1. Deletion certificates (Section 14.7): deletes the storage objects of each org due for deletion through
//      the Storage API, so the hourly lifecycle job can purge its rows; then renders each purged org's
//      certificate (tagged PDF/UA), stores it in the private deletion-certificates bucket and emails it to
//      the former Owner.
//   2. Custom domains (Section 12): domain.provision, domain.check and domain.release jobs through the Vercel
//      Domains API (Atlas and Gateway hosts) and the Resend domains API (sending domains).
//
// Mail: XOS_LIFECYCLE_MAILPIT_URL sends to the local stack's Inbucket (Mailpit) and only to a local host;
// otherwise XOS_EMAIL_TRANSPORT=resend sends through Resend to recipients XOS_EMAIL_ALLOWLIST allows (any
// recipient only with XOS_EMAIL_DELIVER_TO_ANY=true). With neither, certificates wait and say why.
// Domains: VERCEL_API_TOKEN with VERCEL_PROJECT_ID_ATLAS and VERCEL_PROJECT_ID_GATEWAY (and VERCEL_TEAM_ID for a
// team), and RESEND_DOMAINS_API_KEY. A provider left unset records its domains as not set up yet.
// Every secret is the owner's (infra/runbooks/org-lifecycle.md); none is read anywhere else.
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";
import {
  deletionCertificateCopy,
  documentMessages,
  httpFromFetch,
  mailpitMailer,
  readEmailEnv,
  recipientAllowed,
  renderDeletionCertificate,
  resendMailer,
  resendSendingDomains,
  runDeletionCertificates,
  runDomainJobs,
  supabaseDomainJobStore,
  supabasePurgeStorage,
  supabasePurgeStore,
  vercelHosts,
  type DomainProviders,
  type ReportMailer,
} from "../_vendor/xos-platform.js";
import { env, hasBearer, json, serve } from "../_shared/runtime.ts";

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
    return resendMailer(new Resend(emailEnv.RESEND_API_KEY), emailEnv.XOS_EMAIL_FROM, (to) =>
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

serve(async (request) => {
  if (!hasBearer(request, env("SUPABASE_SERVICE_ROLE_KEY"))) {
    return json(401, { type: "/problems/unauthorized", title: "Unauthorized", status: 401 });
  }
  const client = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const atlas = (optional("ATLAS_SITE_URL") ?? "https://atlas.invalid").replace(/\/+$/, "");
  const worker = `org-lifecycle:${crypto.randomUUID()}`;
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
  return json(200, { certificates, domains });
});
