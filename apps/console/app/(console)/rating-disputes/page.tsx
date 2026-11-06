import { getRatingDisputeQueue } from "@xos/data/console";
import type { Metadata, Route } from "next";
import NextLink from "next/link";
import { getTranslations } from "next-intl/server";
import { Empty, PageHeader, Table } from "@/components/page";
import { getConsoleFormat } from "@/lib/format";
import { requirePermission } from "@/lib/operator";

export async function generateMetadata(): Promise<Metadata> {
  const nav = await getTranslations("nav");
  return { title: nav("console.ratingDisputes") };
}

/**
 * Rating disputes (ADR 0156): people disputing a rating an org gave them, oldest open first, or the decided ones. The score
 * is not on this page or the next: what a rating scored cannot decide its dispute.
 */
export default async function RatingDisputesPage({
  searchParams,
}: PageProps<"/rating-disputes">) {
  const ctx = await requirePermission("moderation.decide");
  const decided = (await searchParams)["view"] === "decided";
  const { t, label, instant } = await getConsoleFormat();
  const result = await getRatingDisputeQueue(ctx.db, !decided);
  return (
    <>
      <PageHeader title={t("ratingDisputes.title")} intro={t("ratingDisputes.intro")} />
      <nav aria-label={t("ratingDisputes.title")}>
        <ul className="m-0 flex list-none flex-wrap gap-8 p-0">
          {[
            { href: "/rating-disputes", current: !decided, text: t("moderation.openTab") },
            {
              href: "/rating-disputes?view=decided",
              current: decided,
              text: t("moderation.decidedTab"),
            },
            { href: "/moderation", current: false, text: t("ratingDisputes.backToListings") },
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
        <Empty>{decided ? t("ratingDisputes.noneDecided") : t("ratingDisputes.none")}</Empty>
      ) : (
        <Table
          caption={decided ? t("moderation.decidedTab") : t("moderation.openTab")}
          testId="rating-dispute-queue"
          columns={[
            t("ratingDisputes.person"),
            t("ratingDisputes.org"),
            t("ratingDisputes.ground"),
            t("ratingDisputes.answered"),
            decided ? t("ratingDisputes.state") : t("ratingDisputes.waiting"),
          ]}
          rows={result.data.map((row) => ({
            key: row.disputeId,
            cells: [
              <NextLink
                key="person"
                href={`/rating-disputes/${row.disputeId}` as Route}
                className="font-medium text-accent-text underline"
              >
                {row.disputantName ?? t("common.unknownPerson")}
              </NextLink>,
              row.orgName,
              label("ratingDisputeGrounds", row.ground),
              row.orgAnswered ? t("common.yes") : t("common.no"),
              decided
                ? `${label("ratingDisputeStates", row.state)}, ${instant(row.decidedAt)}`
                : instant(row.filedAt),
            ],
          }))}
        />
      )}
    </>
  );
}
