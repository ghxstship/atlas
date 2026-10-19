import type { ExternalDocumentKind } from "@xos/data/documents/sources-external";
import { getTranslations } from "next-intl/server";
import { DownloadLink } from "@/components/ui";
import { documentHref } from "@/lib/documents/links";

/**
 * Download actions for a generated document in Gateway (Section 11.9, ADR 0031): the tagged PDF on
 * US Letter and on A4. Both are secondary, so the row keeps its one primary action.
 */
export async function DocumentActions({
  kind,
  id,
  engagementKey,
}: {
  kind: ExternalDocumentKind;
  id: string;
  engagementKey: string;
}) {
  const t = await getTranslations("documents.actions");
  const href = documentHref(kind, id, engagementKey);
  return (
    <span className="inline-flex flex-wrap items-center gap-8" data-document={kind}>
      <DownloadLink href={href}>{t("download")}</DownloadLink>
      <DownloadLink href={`${href}&paper=a4`} variant="ghost">
        {t("downloadA4")}
      </DownloadLink>
    </span>
  );
}
