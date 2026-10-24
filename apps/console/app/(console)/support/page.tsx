import { listOpenSupportSessions } from "@xos/data/console";
import type { Metadata, Route } from "next";
import NextLink from "next/link";
import { Empty, PageHeader, Table } from "@/components/page";
import { getConsoleFormat } from "@/lib/format";
import { requirePermission } from "@/lib/operator";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getConsoleFormat();
  return { title: t("support.title") };
}

/** Open platform support sessions (Section 8): the org, the Owner's reason and when access ends. */
export default async function SupportPage() {
  const ctx = await requirePermission("support.sessions");
  const { t, instant } = await getConsoleFormat();
  const result = await listOpenSupportSessions(ctx.db);
  return (
    <>
      <PageHeader title={t("support.title")} intro={t("support.intro")} />
      {!result.ok ? (
        <Empty>{t("common.loadError")}</Empty>
      ) : result.data.length === 0 ? (
        <Empty>{t("support.none")}</Empty>
      ) : (
        <Table
          caption={t("support.title")}
          testId="support-sessions"
          columns={[
            t("support.org"),
            t("support.reason"),
            t("support.grantedBy"),
            t("support.ends"),
          ]}
          rows={result.data.map((s) => ({
            key: s.id,
            cells: [
              <NextLink
                key="org"
                href={`/support/${s.id}` as Route}
                className="font-medium text-accent-text underline"
              >
                {s.orgName}
              </NextLink>,
              s.reason,
              s.grantedByName ?? t("common.unknownPerson"),
              instant(s.endsAt),
            ],
          }))}
        />
      )}
    </>
  );
}
