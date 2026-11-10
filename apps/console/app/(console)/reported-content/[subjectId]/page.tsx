import { getEscalationDetail } from "@xos/data/console";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { z } from "zod";
import { DecideEscalationForm } from "@/components/moderation-forms";
import { Empty, Facts, PageHeader, Panel, Section } from "@/components/page";
import { InlineAlert } from "@/components/ui";
import { getConsoleFormat } from "@/lib/format";
import { requirePermission } from "@/lib/operator";

export async function generateMetadata(): Promise<Metadata> {
  const nav = await getTranslations("nav");
  return { title: nav("console.reportedItem") };
}

/**
 * One post, comment or message whose reports the org left undecided past their 24 hours (migration 6891): the item,
 * its reports without who made them, every decision, and the form to decide it for GHXSTSHIP. The read is logged in
 * the console ledger; an item never escalated is not found.
 */
export default async function ReportedItemPage({
  params,
}: PageProps<"/reported-content/[subjectId]">) {
  const { subjectId } = await params;
  if (!z.uuid().safeParse(subjectId).success) notFound();
  const ctx = await requirePermission("moderation.decide");
  const [detail, f] = await Promise.all([
    getEscalationDetail(ctx.db, subjectId),
    getConsoleFormat(),
  ]);
  if (!detail.ok) {
    if (detail.error.kind === "not-found") notFound();
    throw new Error(`Cannot read the reported item: ${detail.error.kind}`);
  }
  const { subject, reports, decisions } = detail.data;
  const { t, label, instant } = f;
  const open = reports.some((r) => r.open);
  return (
    <>
      <PageHeader
        title={t("reportedContent.itemTitle", {
          kind: label("reportedContent.kinds", subject.kind),
          org: subject.orgName,
        })}
        intro={t("reportedContent.detailIntro", {
          org: subject.orgName,
          context: subject.context ?? t("common.none"),
          author: subject.authorName ?? t("common.unknownPerson"),
          state: subject.removed ? t("reportedContent.removed") : t("reportedContent.visible"),
        })}
      />
      <Panel>
        {subject.body === null ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("reportedContent.bodyRemoved")}</p>
        ) : (
          <p className="m-0 whitespace-pre-line text-text-13" data-testid="reported-body">
            {subject.body}
          </p>
        )}
      </Panel>

      <Section id="reports" title={t("reportedContent.reportsTitle")}>
        <ul className="m-0 flex list-none flex-col gap-8 p-0" data-testid="reports">
          {reports.map((r) => (
            <li
              key={r.id}
              className="flex flex-col gap-4 rounded-card border border-border-subtle p-12 text-text-13"
            >
              <span className="flex flex-wrap gap-8">
                <span className="font-medium">{label("contentReasons", r.reason)}</span>
                <span className="text-text-secondary">
                  {r.open ? t("moderation.reportOpen") : t("moderation.reportDecided")}
                </span>
              </span>
              {r.details ? <span>{r.details}</span> : null}
              <Facts items={[{ label: t("reportedContent.excerpt"), value: r.excerpt }]} />
              <span className="text-text-12 text-text-secondary">
                {r.escalatedAt
                  ? t("reportedContent.reported", {
                      when: instant(r.reportedAt),
                      escalated: instant(r.escalatedAt),
                    })
                  : t("reportedContent.reportedNotEscalated", { when: instant(r.reportedAt) })}
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="decide" title={t("reportedContent.decideTitle")}>
        <Panel>
          {open ? (
            <DecideEscalationForm subjectId={subject.id} />
          ) : (
            <InlineAlert tone="info">{t("reportedContent.nothingOpen")}</InlineAlert>
          )}
        </Panel>
      </Section>

      <Section id="decisions" title={t("reportedContent.decisionsTitle")}>
        {decisions.length === 0 ? (
          <Empty>{t("reportedContent.noDecisions")}</Empty>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-8 p-0" data-testid="decisions">
            {decisions.map((d) => (
              <li
                key={d.id}
                className="flex flex-col gap-8 rounded-card border border-border-subtle p-12"
              >
                <span className="text-text-13 font-medium">
                  {t("reportedContent.decidedBy", {
                    action: label("actions", d.action),
                    when: instant(d.decidedAt),
                    who: d.byPlatform
                      ? t("reportedContent.byPlatform")
                      : t("reportedContent.byOrg"),
                  })}
                </span>
                <Facts
                  items={[
                    { label: t("moderation.ground"), value: label("grounds", d.ground) },
                    { label: t("moderation.ruleReference"), value: d.ruleReference },
                    { label: t("moderation.facts"), value: d.facts },
                    { label: t("moderation.statement"), value: d.statement },
                  ]}
                />
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
