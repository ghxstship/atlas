import { listActionLog } from "@xos/data/console";
import type { Metadata, Route } from "next";
import NextLink from "next/link";
import { Empty, PageHeader, Table } from "@/components/page";
import { getConsoleFormat } from "@/lib/format";
import { requirePermission } from "@/lib/operator";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getConsoleFormat();
  return { title: t("activity.title") };
}

/** The console ledger (app.platform_operator_actions), newest first. */
export default async function ActivityPage() {
  const ctx = await requirePermission("tenants.read");
  const { t, label, instant } = await getConsoleFormat();
  const result = await listActionLog(ctx.db, { limit: 200 });
  return (
    <>
      <PageHeader title={t("activity.title")} intro={t("activity.intro")} />
      {!result.ok ? (
        <Empty>{t("common.loadError")}</Empty>
      ) : result.data.length === 0 ? (
        <Empty>{t("activity.none")}</Empty>
      ) : (
        <Table
          caption={t("activity.title")}
          testId="activity"
          columns={[
            t("common.when"),
            t("activity.operator"),
            t("activity.action"),
            t("activity.org"),
            t("activity.reason"),
          ]}
          rows={result.data.map((a) => ({
            key: a.id,
            cells: [
              instant(a.actedAt),
              a.operatorName ?? t("common.unknownPerson"),
              label("actionNames", a.action),
              a.targetOrgId && a.targetOrgName ? (
                <NextLink
                  key="org"
                  href={`/tenants/${a.targetOrgId}` as Route}
                  className="text-accent-text underline"
                >
                  {a.targetOrgName}
                </NextLink>
              ) : (
                t("activity.platform")
              ),
              a.reason ?? t("common.none"),
            ],
          }))}
        />
      )}
    </>
  );
}
