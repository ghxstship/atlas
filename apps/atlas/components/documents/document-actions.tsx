import { DOCUMENT_CLASSIFICATION, type DocumentKind } from "@xos/data/documents/model";
import { FilePreviewButton } from "@/components/files/file-preview";
import { DownloadLink } from "@/components/ui";
import { documentHref } from "@/lib/documents/links";
import { getTranslate } from "@/lib/shell/translate";

/**
 * Download actions for a generated document (Section 11.9, ADR 0031): the tagged PDF on US Letter,
 * and the same document on A4. Both are secondary buttons of one style (A59-029), so the screen keeps
 * its one primary action. Preview opens the Letter PDF from the same route in the file previewer
 * (A142), watermarked when the document's classification calls for it.
 */
export async function DocumentActions({
  org,
  kind,
  id,
}: {
  org: string;
  kind: DocumentKind;
  id: string;
}) {
  const t = await getTranslate();
  const href = documentHref(org, kind, id);
  return (
    <span className="inline-flex flex-wrap items-center gap-8" data-document={kind}>
      <FilePreviewButton
        src={href}
        name={t(`documents.kinds.${kind}`)}
        contentType="application/pdf"
        classification={DOCUMENT_CLASSIFICATION[kind]}
      />
      <DownloadLink href={href}>{t("documents.actions.download")}</DownloadLink>
      <DownloadLink href={`${href}?paper=a4`}>{t("documents.actions.downloadA4")}</DownloadLink>
    </span>
  );
}
