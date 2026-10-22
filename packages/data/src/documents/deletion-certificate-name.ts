import type { DeletionCertificateData } from "./deletion-certificate.ts";
import type { Paper } from "./model.ts";

/**
 * The certificate's key and file name, without the document renderer: the org-purge worker names stored
 * certificates with these, so the org-lifecycle Edge Function loads the renderer only when it renders one
 * (A85, cold starts). deletion-certificate.ts re-exports both.
 */

/** The short key printed on a certificate and in its file name. */
export function certificateKey(id: string): string {
  return `DEL-${id.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

/** File name of a certificate PDF. */
export function deletionCertificateFileName(
  data: Pick<DeletionCertificateData, "id" | "orgSlug">,
  paper: Paper = "letter",
): string {
  const slug = data.orgSlug.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "org";
  return `deletion-certificate-${slug}-${certificateKey(data.id)}-${paper}.pdf`;
}
