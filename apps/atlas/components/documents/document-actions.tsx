import {
  DOCUMENT_CLASSIFICATION,
  type DocumentKind,
  type PrintSize,
} from "@xos/data/documents/model";
import { FilePreviewButton } from "@/components/files/file-preview";
import { SelectField } from "@/components/operations/fields";
import { Button, DownloadLink } from "@/components/ui";
import { documentHref } from "@/lib/documents/links";
import { getTranslate } from "@/lib/shell/translate";

/**
 * Download actions for a generated document (Section 11.9, ADR 0031): the tagged PDF on US Letter,
 * and the same document on A4. Both are secondary buttons of one style (A59-029), so the screen keeps
 * its one primary action. Preview opens the Letter PDF from the same route in the file previewer
 * (A142), watermarked when the document's classification calls for it. A kind with more sizes (the
 * credential badge also prints on A6 and CR80 cards, P5) gets a size choice and one download button
 * instead: a plain GET form, so it needs no client code.
 */
export async function DocumentActions({
  org,
  kind,
  id,
  sizes,
}: {
  org: string;
  kind: DocumentKind;
  id: string;
  sizes?: readonly PrintSize[];
}) {
  const t = await getTranslate();
  const href = documentHref(org, kind, id);
  if (sizes && sizes.length > 2) {
    const select = `document-size-${kind}`;
    return (
      <form
        action={href}
        method="get"
        className="inline-flex flex-wrap items-end gap-8"
        data-document={kind}
      >
        <SelectField
          id={select}
          name="paper"
          label={t("documents.actions.size")}
          defaultValue={sizes[0] as string}
          options={sizes.map((size) => ({ value: size, label: t(`documents.paper.${size}`) }))}
        />
        <Button type="submit" variant="secondary" size="sm">
          {t("documents.actions.downloadSize")}
        </Button>
      </form>
    );
  }
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
