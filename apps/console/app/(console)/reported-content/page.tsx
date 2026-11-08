import { getContentEscalations } from "@xos/data/console";
import type { Metadata, Route } from "next";
import NextLink from "next/link";
import { Empty, PageHeader, Table } from "@/components/page";
import { getConsoleFormat } from "@/lib/format";
import { requirePermission } from "@/lib/operator";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getConsoleFormat();
  return { title: t("reportedContent.title") };
}

/**
 * Reported content an org left undecided (migration 6196; App Store Review Guideline 1.2): posts, comments and
 * messages whose reports passed their 24 hours without a decision, the longest escalated first, without their text;
 * or the escalated items decided since. Opening one logs the read.
 */
export default async function ReportedContentPage({
  searchParams,
}: PageProps<"/reported-content">) {
  const ctx = await requirePermission("moderation.decide");
  const decided = (await searchParams)["view"] === "decided";
  const { t, label, instant } = await getConsoleFormat();
  const result = await getContentEscalations(ctx.db, !decided);
  return (
    <>
      <PageHeader title={t("reportedContent.title")} intro={t("reportedContent.intro")} />
      <nav aria-label={t("reportedContent.title")}>
        <ul className="m-0 flex list-none gap-8 p-0">
          {[
            { href: "/reported-content", current: !decided, text: t("reportedContent.openTab") },
            {
              href: "/reported-content?view=decided",
              current: decided,
              text: t("reportedContent.decidedTab"),
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
        <Empty>{decided ? t("reportedContent.noneDecided") : t("reportedContent.none")}</Empty>
      ) : (
        <Table
          caption={decided ? t("reportedContent.decidedTab") : t("reportedContent.openTab")}
          testId="reported-content"
          columns={[
            t("reportedContent.item"),
            t("reportedContent.reports"),
            t("reportedContent.reasons"),
            decided ? t("reportedContent.lastDecision") : t("reportedContent.escalated"),
          ]}
          rows={result.data.map((row) => ({
            key: row.id,
            cells: [
              <span key="item" className="flex flex-col gap-4">
                <NextLink
                  href={`/reported-content/${row.id}` as Route}
                  className="font-medium text-accent-text underline"
                >
                  {t("reportedContent.itemTitle", {
                    kind: label("reportedContent.kinds", row.kind),
                    org: row.orgName,
                  })}
                </NextLink>
                <span className="text-text-12 text-text-secondary">
                  {row.removed ? t("reportedContent.removed") : t("reportedContent.visible")}
                </span>
              </span>,
              t("moderation.reportsCount", { open: row.openReports, total: row.totalReports }),
              row.reasons.map((r) => label("contentReasons", r)).join(", "),
              decided
                ? row.lastAction
                  ? t("reportedContent.decidedBy", {
                      action: label("actions", row.lastAction),
                      when: instant(row.lastDecidedAt),
                      who: row.decidedByPlatform
                        ? t("reportedContent.byPlatform")
                        : t("reportedContent.byOrg"),
                    })
                  : t("common.none")
                : instant(row.escalatedAt),
            ],
          }))}
        />
      )}
    </>
  );
}
