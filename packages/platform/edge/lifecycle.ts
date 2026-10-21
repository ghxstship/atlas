/**
 * The org-lifecycle worker for the Edge bundle (A79, migrations 1351 and 1355): the day-90 deletion's storage
 * clearing, certificate PDF and email (@xos/data org-purge.ts, the document pipeline of ADR 0031), and custom
 * domain provisioning through Vercel and Resend (@xos/integrations domains). This file re-exports them and
 * adds the certificate's catalog copy from @xos/i18n.
 */
import { Buffer as NodeBuffer } from "node:buffer";
import { defaultLocale, getMessages, isLocale } from "@xos/i18n";
import type { CertificateEmailCopy } from "../../data/src/org-purge.ts";

// The document renderer decodes its embedded fonts with Buffer, which the Edge runtime exposes only to npm
// packages; the bundle is not one, so it gets Node's.
const scope = globalThis as { Buffer?: unknown };
scope.Buffer ??= NodeBuffer;

export {
  DELETION_CERTIFICATES_BUCKET,
  runDeletionCertificates,
  supabasePurgeStorage,
  supabasePurgeStore,
  type CertificateResult,
  type ClaimedCertificate,
} from "../../data/src/org-purge.ts";
export { renderDeletionCertificate } from "../../data/src/documents/deletion-certificate.ts";
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

const known = (locale: string) => (isLocale(locale) ? locale : defaultLocale);

/** The `documents` namespace in a locale (en-US when unknown), for the certificate PDF. */
export function documentMessages(locale: string): unknown {
  return (getMessages(known(locale)) as unknown as Tree)["documents"];
}

/** The certificate email in a locale (en-US when unknown). */
export function deletionCertificateCopy(locale: string): CertificateEmailCopy {
  const lang = known(locale);
  const messages = getMessages(lang) as unknown as Tree;
  const email = (key: string) => lookup(messages, ["email", "deletionCertificate", key]) ?? key;
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
