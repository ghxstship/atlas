import {
  listDocumentFileLinks,
  listLinkableConnections,
  type LinkProvider,
} from "@xos/data/storage-links";
import { getFormatter, getTranslations } from "next-intl/server";
import { LinkedFileRemove, StoragePicker } from "@/components/lazy-ui/storage-picker";
import type { OrgContext } from "@/lib/shell/context";

/**
 * A document's linked files in its peek drawer (B16, ADR 0155 D5; Section 17): each file Google Drive or OneDrive
 * holds, opened at the provider, with Remove for writers, and "Link a file" opening the picker of a linkable
 * connection's linking folder. Readers list the links through app.document_file_links; the picker and the remove
 * control load on demand, never with the page.
 */

const OPEN: Readonly<Record<LinkProvider, string>> = {
  google_drive: "openDrive",
  onedrive_sharepoint: "openOneDrive",
  dropbox: "openDropbox",
};

export async function LinkedFiles({
  ctx,
  documentId,
  canWrite,
}: {
  ctx: OrgContext;
  documentId: string;
  canWrite: boolean;
}) {
  const [t, format, links, connections] = await Promise.all([
    getTranslations("storageLinks") as unknown as Promise<
      (key: string, values?: Record<string, string>) => string
    >,
    getFormatter(),
    listDocumentFileLinks(ctx.viewer.db, documentId),
    canWrite ? listLinkableConnections(ctx.viewer.db, ctx.org.id) : Promise.resolve(null),
  ]);
  const shown = links.ok ? links.data : [];
  const linkable = connections?.ok ? connections.data : [];
  return (
    <section
      aria-labelledby={`linked-files-${documentId}`}
      className="flex flex-col gap-8"
      data-testid="linked-files"
    >
      <h3 id={`linked-files-${documentId}`} className="m-0 text-label-14 font-semibold">
        {t("title")}
      </h3>
      {shown.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("empty")}</p>
      ) : null}
      <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
        {shown.map((l) => (
          <li
            key={l.linkId}
            className="flex flex-wrap items-start justify-between gap-8 py-8 text-text-13"
          >
            <div className="flex min-w-0 flex-col gap-2">
              <span className="font-medium break-words">{l.fileName}</span>
              {l.modifiedAt ? (
                <span className="text-text-12 text-text-secondary">
                  {t("modified", {
                    date: format.dateTime(new Date(l.modifiedAt), { dateStyle: "medium" }),
                  })}
                </span>
              ) : null}
              {l.webUrl ? (
                <a
                  href={l.webUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-accent-text underline"
                >
                  {t(OPEN[l.provider])}
                </a>
              ) : null}
            </div>
            {canWrite ? (
              <LinkedFileRemove org={ctx.org.slug} linkId={l.linkId} label={t("remove")} />
            ) : null}
          </li>
        ))}
      </ul>
      {canWrite ? (
        linkable.length === 0 ? (
          <p className="m-0 text-text-12 text-text-secondary">{t("noConnection")}</p>
        ) : (
          linkable.map((c) => (
            <details key={c.connectionId} className="flex flex-col gap-8">
              <summary className="cursor-pointer text-label-13 font-medium">
                {t("link")} · {t("pickerTitle", { name: c.displayName })}
              </summary>
              <StoragePicker
                org={ctx.org.slug}
                connectionId={c.connectionId}
                documentId={documentId}
                mode="link"
                labels={{
                  loading: t("pickerLoading"),
                  empty: t("pickerEmpty"),
                  up: t("pickerUp"),
                  choose: t("pickerChoose"),
                  open: t("pickerOpen"),
                  useFolder: t("useFolder"),
                }}
              />
            </details>
          ))
        )
      ) : null}
    </section>
  );
}
