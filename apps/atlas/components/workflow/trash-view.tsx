import { listProjects } from "@xos/data/finance";
import { listTrash } from "@xos/data/workflow";
import { getLocale, getTranslations } from "next-intl/server";
import { PageHeader, TemplateCollection } from "@/components/finance/ui";
import type { OrgContext } from "@/lib/shell/context";
import { EmptyPanel, ErrorPanel } from "./kit";
import { RestoreButton, TrashFilters } from "./trash-client";

/**
 * Trash (Section 4.10, A33): rows deleted in the org that the viewer may read, newest first, each
 * restorable until its table's retention period ends, when the nightly purge removes it for good.
 * Restoring runs as the viewer, so only rows they could edit come back; rows deleted together come
 * back together.
 */
export async function TrashView({
  ctx,
  table,
  q,
}: {
  ctx: OrgContext;
  table: string | null;
  q: string | null;
}) {
  const t = (await getTranslations("workflow")) as unknown as (
    key: string,
    values?: Record<string, string | number>,
  ) => string;
  const org = ctx.org.slug;
  const title = t("trash.title");
  const db = ctx.viewer.db;
  const [items, all, projects] = await Promise.all([
    listTrash(db, { orgId: ctx.org.id, table, q }),
    listTrash(db, { orgId: ctx.org.id }),
    listProjects(db, ctx.org.id),
  ]);
  if (!items.ok || !all.ok || !projects.ok) {
    return (
      <TemplateCollection header={<PageHeader title={title} />}>
        <ErrorPanel sentence={t("trash.loadError")} />
      </TemplateCollection>
    );
  }
  const locale = await getLocale();
  const day = (iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(iso));
  const when = (iso: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
  const projectKey = new Map(projects.data.map((p) => [p.id, p.key]));
  const tables = [...new Set(all.data.map((i) => i.table))].sort();
  const filtered = table !== null || (q ?? "") !== "";

  return (
    <TemplateCollection
      header={<PageHeader title={title} count={items.data.length} />}
      filters={<TrashFilters tables={tables} table={table} q={q} />}
    >
      <div className="flex flex-col gap-12">
        <p className="m-0 max-w-layout-reading text-text-13 text-text-secondary">{t("trash.sentence")}</p>
        {items.data.length === 0 ? (
          <EmptyPanel
            icon="Trash2"
            sentence={filtered ? t("trash.emptyFiltered") : t("trash.empty")}
            actionLabel={filtered ? t("trash.clearFilters") : t("trash.emptyAction")}
            href={filtered ? `/${org}/trash` : `/${org}/home`}
          />
        ) : (
          <div className="overflow-x-auto rounded-card border border-border-subtle">
            <table className="w-full min-w-[640px] border-collapse text-text-13">
              <caption className="sr-only">{t("trash.caption")}</caption>
              <thead>
                <tr className="border-b border-border-subtle text-left text-text-12 text-text-secondary">
                  <th scope="col" className="px-12 py-8 font-medium">{t("trash.columns.title")}</th>
                  <th scope="col" className="px-12 py-8 font-medium">{t("trash.columns.kind")}</th>
                  <th scope="col" className="px-12 py-8 font-medium">{t("trash.columns.project")}</th>
                  <th scope="col" className="px-12 py-8 font-medium">{t("trash.columns.deleted")}</th>
                  <th scope="col" className="px-12 py-8 font-medium">{t("trash.columns.purge")}</th>
                  <th scope="col" className="px-12 py-8 text-right font-medium">{t("trash.columns.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {items.data.map((i) => (
                  <tr key={i.urn} className="border-b border-border-subtle last:border-b-0">
                    <th scope="row" className="px-12 py-8 text-left font-medium">
                      {i.title ?? t("trash.untitled")}
                    </th>
                    <td className="px-12 py-8 font-mono text-text-12">{i.table}</td>
                    <td className="px-12 py-8">
                      {i.projectId ? (projectKey.get(i.projectId) ?? t("common.otherProject")) : t("common.orgWide")}
                    </td>
                    <td className="px-12 py-8">{when(i.deletedAt)}</td>
                    <td className="px-12 py-8">{day(i.purgeAfter)}</td>
                    <td className="px-12 py-8 text-right">
                      <RestoreButton org={org} table={i.table} id={i.id} title={i.title ?? i.table} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </TemplateCollection>
  );
}
