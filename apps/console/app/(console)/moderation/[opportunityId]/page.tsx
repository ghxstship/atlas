import { getListingDetail } from "@xos/data/console";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { z } from "zod";
import { DecideAppealForm, DecideListingForm } from "@/components/moderation-forms";
import { Empty, Facts, PageHeader, Panel, Section } from "@/components/page";
import { InlineAlert } from "@/components/ui";
import { getConsoleFormat } from "@/lib/format";
import { requirePermission } from "@/lib/operator";

export async function generateMetadata(): Promise<Metadata> {
  const nav = await getTranslations("nav");
  return { title: nav("console.listing") };
}

/**
 * One reported listing (Section 4.4.3, Section 14.9; Digital Services Act articles 16, 17 and 20): the listing, its
 * reports, every decision with its statement of reasons in parts, its appeals, and the forms to decide.
 */
export default async function ListingPage({ params }: PageProps<"/moderation/[opportunityId]">) {
  const { opportunityId } = await params;
  if (!z.uuid().safeParse(opportunityId).success) notFound();
  const ctx = await requirePermission("moderation.decide");
  const [detail, f] = await Promise.all([
    getListingDetail(ctx.db, opportunityId),
    getConsoleFormat(),
  ]);
  if (!detail.ok) {
    if (detail.error.kind === "not-found") notFound();
    throw new Error(`Cannot read the listing: ${detail.error.kind}`);
  }
  const { listing, reports, decisions, appeals } = detail.data;
  const { t, label, instant } = f;
  return (
    <>
      <PageHeader
        title={listing.title}
        intro={t("moderation.detailIntro", {
          org: listing.org.name,
          project: listing.projectName ?? t("common.none"),
          state: listing.removed ? t("moderation.removed") : t("moderation.listed"),
        })}
      />
      {listing.description ? (
        <Panel>
          <p className="m-0 whitespace-pre-line text-text-13">{listing.description}</p>
        </Panel>
      ) : null}

      <Section id="reports" title={t("moderation.reportsTitle")}>
        <ul className="m-0 flex list-none flex-col gap-8 p-0" data-testid="reports">
          {reports.map((r) => (
            <li
              key={r.id}
              className="flex flex-col gap-4 rounded-card border border-border-subtle p-12 text-text-13"
            >
              <span className="flex flex-wrap gap-8">
                <span className="font-medium">{label("reportReasons", r.reason)}</span>
                <span className="text-text-secondary">
                  {r.open ? t("moderation.reportOpen") : t("moderation.reportDecided")}
                </span>
              </span>
              {r.details ? <span>{r.details}</span> : null}
              <span className="text-text-12 text-text-secondary">
                {t("moderation.reporter", {
                  name: r.reporterName ?? t("common.unknownPerson"),
                  when: instant(r.reportedAt),
                })}
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="decide" title={t("moderation.decideTitle")}>
        <Panel>
          <DecideListingForm opportunityId={listing.id} removed={listing.removed} />
        </Panel>
      </Section>

      <Section id="decisions" title={t("moderation.decisionsTitle")}>
        {decisions.length === 0 ? (
          <Empty>{t("moderation.noDecisions")}</Empty>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-8 p-0" data-testid="decisions">
            {decisions.map((d) => (
              <li
                key={d.id}
                className="flex flex-col gap-8 rounded-card border border-border-subtle p-12"
              >
                <span className="text-text-13 font-medium">
                  {t("moderation.decidedBy", {
                    action: label("actions", d.action),
                    when: instant(d.decidedAt),
                    name: d.decidedByName ?? t("common.unknownPerson"),
                  })}
                </span>
                <Facts
                  items={[
                    {
                      label: t("moderation.ground"),
                      value: d.ground ? label("grounds", d.ground) : t("common.none"),
                    },
                    {
                      label: t("moderation.ruleReference"),
                      value: d.ruleReference ?? t("common.none"),
                    },
                    { label: t("moderation.facts"), value: d.facts ?? t("common.none") },
                    { label: t("moderation.statement"), value: d.statement },
                    {
                      label: t("moderation.automated"),
                      value:
                        d.automatedDetection || d.automatedDecision
                          ? t("common.yes")
                          : t("moderation.automatedNone"),
                    },
                  ]}
                />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="appeals" title={t("moderation.appealsTitle")}>
        {appeals.length === 0 ? (
          <Empty>{t("moderation.noAppeals")}</Empty>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-8 p-0" data-testid="appeals">
            {appeals.map((a) => (
              <li
                key={a.id}
                className="flex flex-col gap-8 rounded-card border border-border-subtle p-12 text-text-13"
              >
                <span className="font-medium">
                  {t("moderation.appealBy", {
                    name: a.appellantName ?? t("common.unknownPerson"),
                    decision: label("actions", a.decision),
                    when: instant(a.filedAt),
                  })}
                </span>
                <span>{a.grounds}</span>
                {a.state === "Open" ? (
                  a.decidableByMe ? (
                    <DecideAppealForm
                      opportunityId={listing.id}
                      appealId={a.id}
                      reversesNoAction={a.decision === "No Action" || a.decision === "Restored"}
                    />
                  ) : (
                    <InlineAlert tone="info">{t("moderation.appealOwn")}</InlineAlert>
                  )
                ) : (
                  <span className="text-text-12 text-text-secondary">
                    {t("moderation.appealState", {
                      state: label("appealStates", a.state),
                      when: instant(a.decidedAt),
                      name: a.decidedByName ?? t("common.unknownPerson"),
                      statement: a.decisionStatement ?? "",
                    })}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
