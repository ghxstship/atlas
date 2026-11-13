import { getRatingDisputeDetail } from "@xos/data/console";
import type { Metadata, Route } from "next";
import NextLink from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { z } from "zod";
import { DecideRatingDisputeForm } from "@/components/moderation-forms";
import { Facts, PageHeader, Panel, Section } from "@/components/page";
import { InlineAlert } from "@/components/ui";
import { getConsoleFormat } from "@/lib/format";
import { requirePermission } from "@/lib/operator";

export async function generateMetadata(): Promise<Metadata> {
  const nav = await getTranslations("nav");
  return { title: nav("console.ratingDispute") };
}

/**
 * One rating dispute (ADR 0158): what the person says, the rating's comment without its score, the org's answer, and the
 * form to decide. Reading it is logged in the console ledger.
 */
export default async function RatingDisputePage({
  params,
}: PageProps<"/rating-disputes/[disputeId]">) {
  const { disputeId } = await params;
  if (!z.uuid().safeParse(disputeId).success) notFound();
  const ctx = await requirePermission("moderation.decide");
  const [detail, f] = await Promise.all([
    getRatingDisputeDetail(ctx.db, disputeId),
    getConsoleFormat(),
  ]);
  if (!detail.ok) {
    if (detail.error.kind === "not-found") notFound();
    throw new Error(`Cannot read the rating dispute: ${detail.error.kind}`);
  }
  const d = detail.data;
  const { t, label, instant } = f;
  const person = d.disputantName ?? t("common.unknownPerson");
  return (
    <>
      {/* The record names the dispute and leads back to its queue, the open or the decided one (crawl 4.9). */}
      <NextLink
        href={(d.state === "Open" ? "/rating-disputes" : "/rating-disputes?view=decided") as Route}
        className="inline-flex min-h-target-fine items-center self-start text-text-13 text-accent-text underline"
      >
        {t("ratingDisputes.back")}
      </NextLink>
      <PageHeader
        title={t("ratingDisputes.detailTitle", { person })}
        intro={t("ratingDisputes.detailIntro", {
          person,
          org: d.orgName,
          project: d.projectName ?? t("common.none"),
          when: instant(d.submittedAt),
        })}
      />
      <Section id="dispute" title={t("ratingDisputes.what")}>
        <Panel>
          <Facts
            items={[
              { label: t("ratingDisputes.ground"), value: label("ratingDisputeGrounds", d.ground) },
              { label: t("ratingDisputes.what"), value: d.details },
              {
                label: t("ratingDisputes.comment"),
                value: d.comment ?? t("ratingDisputes.noComment"),
              },
              { label: t("ratingDisputes.reply"), value: d.reply ?? t("common.none") },
              {
                label: t("ratingDisputes.orgAnswer"),
                value: d.orgResponse ?? t("ratingDisputes.noAnswer"),
              },
            ]}
          />
        </Panel>
      </Section>
      <Section id="decide" title={t("ratingDisputes.decideTitle")}>
        {d.state !== "Open" ? (
          <Panel>
            <p className="m-0 text-text-13 font-medium">
              {t("ratingDisputes.decidedBy", {
                state: label("ratingDisputeStates", d.state),
                when: instant(d.decidedAt),
                name: d.decidedByName ?? t("common.unknownPerson"),
              })}
            </p>
            <Facts
              items={[
                {
                  label: t("ratingDisputes.decisionGround"),
                  value: d.decisionGround
                    ? label("ratingDisputeGrounds", d.decisionGround)
                    : t("common.none"),
                },
                { label: t("ratingDisputes.statement"), value: d.decisionStatement ?? "" },
              ]}
            />
          </Panel>
        ) : d.decidableByMe ? (
          <Panel>
            <DecideRatingDisputeForm disputeId={d.id} />
          </Panel>
        ) : (
          <InlineAlert tone="info">{t("ratingDisputes.own")}</InlineAlert>
        )}
      </Section>
    </>
  );
}
