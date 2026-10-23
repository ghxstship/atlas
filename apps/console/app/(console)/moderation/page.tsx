import { getModerationQueue } from "@xos/data/console";
import type { Metadata, Route } from "next";
import NextLink from "next/link";
import { Empty, PageHeader, Table } from "@/components/page";
import { getConsoleFormat } from "@/lib/format";
import { requirePermission } from "@/lib/operator";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getConsoleFormat();
  return { title: t("moderation.title") };
}

/**
 * The moderation queue (Section 4.4.3 abuse, Section 14.9): listings with open reports or appeals, appeals first,
 * then the oldest report; or the decided ones.
 */
export default async function ModerationPage({ searchParams }: PageProps<"/moderation">) {
  const ctx = await requirePermission("moderation.decide");
  const decided = (await searchParams)["view"] === "decided";
  const { t, label, instant } = await getConsoleFormat();
  const result = await getModerationQueue(ctx.db, !decided);
  return (
    <>
      <PageHeader title={t("moderation.title")} intro={t("moderation.intro")} />
      <nav aria-label={t("moderation.title")}>
        <ul className="m-0 flex list-none gap-8 p-0">
          {[
            { href: "/moderation", current: !decided, text: t("moderation.openTab") },
            {
              href: "/moderation?view=decided",
              current: decided,
              text: t("moderation.decidedTab"),
            },
          ].map((tab) => (
            <li key={tab.href}>
              <NextLink
                href={tab.href as Route}
                aria-current={tab.current ? "page" : undefined}
                className={`inline-flex h-control-md items-center rounded-control px-8 text-text-13 ${
                  tab.current ? "bg-bg-raised font-medium" : "text-accent-text underline"
                }`}
              >
                {tab.text}
              </NextLink>
            </li>
          ))}
        </ul>
      </nav>
      {!result.ok ? (
        <Empty>{t("common.loadError")}</Empty>
      ) : result.data.length === 0 ? (
        <Empty>{decided ? t("moderation.noneDecided") : t("moderation.none")}</Empty>
      ) : (
        <Table
          caption={decided ? t("moderation.decidedTab") : t("moderation.openTab")}
          testId="moderation-queue"
          columns={[
            t("moderation.listing"),
            t("moderation.org"),
            t("moderation.reports"),
            t("moderation.appeals"),
            t("moderation.reasons"),
            decided ? t("moderation.lastDecision") : t("moderation.waiting"),
          ]}
          rows={result.data.map((row) => ({
            key: row.opportunityId,
            cells: [
              <span key="listing" className="flex flex-col gap-4">
                <NextLink
                  href={`/moderation/${row.opportunityId}` as Route}
                  className="font-medium text-accent-text underline"
                >
                  {row.title}
                </NextLink>
                <span className="text-text-12 text-text-secondary">
                  {row.removed ? t("moderation.removed") : t("moderation.listed")}
                </span>
              </span>,
              row.orgName,
              t("moderation.reportsCount", { open: row.openReports, total: row.totalReports }),
              String(row.openAppeals),
              row.reasons.map((r) => label("reportReasons", r)).join(", "),
              decided
                ? row.lastDecision
                  ? `${label("actions", row.lastDecision)}, ${instant(row.lastDecidedAt)}`
                  : t("common.none")
                : instant(row.firstReportedAt),
            ],
          }))}
        />
      )}
    </>
  );
}
