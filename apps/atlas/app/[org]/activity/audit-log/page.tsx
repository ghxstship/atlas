import { listAuditEvents } from "@xos/data/activity";
import { getTranslations } from "next-intl/server";
import { AuditLog } from "@/components/activity/audit-log";
import { LoadError } from "@/components/projects/load-error";
import { PageHeader } from "@/components/projects/ui";
import { requireNode } from "@/lib/shell/require-node";
import { nodeHref } from "@/lib/shell/sitemap";

/** Activity > Audit log (Section 4.5.5): the compliance ledger, Owner and Admin only. */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/activity/audit-log">) {
  const routeParams = await params;
  const ctx = await requireNode("activity.audit-log", routeParams);
  const t = await getTranslations("activity.audit");
  const search = await searchParams;
  const raw = typeof search["before"] === "string" ? search["before"] : null;
  const before = raw && !Number.isNaN(Date.parse(raw)) ? raw : null;
  const page = await listAuditEvents(ctx.viewer.db, { orgId: ctx.org.id, before, limit: 50 });
  if (!page.ok) return <LoadError title={t("title")} />;
  return (
    <>
      <PageHeader title={t("title")} />
      <p className="mb-12 mt-0 max-w-layout-form text-text-13 text-text-secondary">{t("lead")}</p>
      <AuditLog
        entries={page.data.entries}
        next={page.data.next}
        paged={before !== null}
        membersHref={nodeHref("settings.members", routeParams) ?? `/${ctx.org.slug}/settings`}
      />
    </>
  );
}
