/**
 * The org-lifecycle worker for the Edge bundle (A79, migrations 1351 and 1355): the day-90 deletion's storage
 * clearing, certificate PDF and email (@xos/data org-purge.ts, the document pipeline of ADR 0031), and custom
 * domain provisioning through Vercel and Resend (@xos/integrations domains). This file re-exports them and
 * adds the certificate's catalog copy from @xos/i18n.
 *
 * Cold starts (A85): the document renderer, with pdfkit and its embedded fonts, loads only when a certificate
 * is rendered, and the copy reads only the documents and email namespaces of each locale, never every catalog.
 */
import type {
  DeletionCertificateData,
  DeletionCertificateOptions,
} from "../../data/src/documents/deletion-certificate.ts";
import type { CertificateEmailCopy } from "../../data/src/org-purge.ts";
import type { Paper } from "../../data/src/documents/model.ts";
import { defaultLocale, isLocale, type Locale } from "@xos/i18n/locales";
import enDocuments from "@xos/i18n/messages/en-US/documents.json" with { type: "json" };
import enEmail from "@xos/i18n/messages/en-US/email.json" with { type: "json" };
import esDocuments from "@xos/i18n/messages/es-US/documents.json" with { type: "json" };
import esEmail from "@xos/i18n/messages/es-US/email.json" with { type: "json" };

export {
  DELETION_CERTIFICATES_BUCKET,
  runDeletionCertificates,
  supabasePurgeStorage,
  supabasePurgeStore,
  type CertificateResult,
  type ClaimedCertificate,
} from "../../data/src/org-purge.ts";
// The domains module is self-contained apart from the framework's HTTP client and errors.
export {
  httpFromFetch,
  resendSendingDomains,
  runDomainJobs,
  supabaseDomainJobStore,
  vercelHosts,
  type DomainJobResult,
  type DomainProviders,
} from "../../integrations/src/domains/index.ts";

type Tree = { readonly [key: string]: Tree | string };

const namespaces: Readonly<Record<Locale, { readonly documents: Tree; readonly email: Tree }>> = {
  "en-US": { documents: enDocuments, email: enEmail },
  "es-US": { documents: esDocuments, email: esEmail },
};

/**
 * Renders a deletion certificate (tagged PDF/UA). The renderer and its fonts load on the first call. The
 * renderer decodes its embedded fonts with Buffer, which the Edge runtime exposes only to npm packages; the
 * bundle is not one, so it gets Node's first.
 */
export async function renderDeletionCertificate(
  data: DeletionCertificateData,
  options: DeletionCertificateOptions & { readonly paper?: Paper },
): Promise<{ bytes: Uint8Array; fileName: string }> {
  const scope = globalThis as { Buffer?: unknown };
  if (scope.Buffer === undefined) scope.Buffer = (await import("node:buffer")).Buffer;
  const { renderDeletionCertificate: render } =
    await import("../../data/src/documents/deletion-certificate.ts");
  return render(data, options);
}

function lookup(tree: Tree, path: readonly string[]): string | null {
  let node: Tree | string | undefined = tree;
  for (const part of path) {
    if (typeof node !== "object" || node === null) return null;
    node = node[part];
  }
  return typeof node === "string" ? node : null;
}

function fill(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (all, name: string) =>
    values[name] === undefined ? all : String(values[name]),
  );
}

const known = (locale: string): Locale => (isLocale(locale) ? locale : defaultLocale);

/** The `documents` namespace in a locale (en-US when unknown), for the certificate PDF. */
export function documentMessages(locale: string): unknown {
  return namespaces[known(locale)].documents;
}

/** The certificate email in a locale (en-US when unknown). */
export function deletionCertificateCopy(locale: string): CertificateEmailCopy {
  const lang = known(locale);
  const messages = namespaces[lang];
  const email = (key: string) => lookup(messages.email, ["deletionCertificate", key]) ?? key;
  return {
    subject: (values) => fill(email("subject"), values),
    text: (values) => fill(email("body"), values),
    date: (iso, timeZone) => {
      const zone = (() => {
        try {
          new Intl.DateTimeFormat(lang, { timeZone });
          return timeZone;
        } catch {
          return "UTC";
        }
      })();
      return new Intl.DateTimeFormat(lang, { dateStyle: "long", timeZone: zone }).format(
        new Date(iso),
      );
    },
  };
}
