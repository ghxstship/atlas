import {
  listEngagements,
  listRatingDisputes,
  listRatings,
  type EngagementCard,
  type Rating,
  type RatingDispute,
} from "@xos/data/opportunities";
import { resolveSettings } from "@xos/data/settings";
import { ActionForm } from "@/components/opportunities/action-form";
import { Muted, RowLink, Section, Table, ViewSwitch } from "@/components/opportunities/parts";
import { PageHeader, StatTile, TemplateCollection } from "@/components/opportunities/ui";
import { EmptyStateLink } from "@/components/ui";
import { enumKey } from "@/lib/opportunities/format";
import { must, setupPage, type PageSetup, type SearchParams } from "@/lib/opportunities/page";
import { engagementsToRate, ratingPromptsOn } from "@/lib/shell/org-settings";
import { nodeHref } from "@/lib/shell/sitemap";
import { rateAction, replyAction, respondToRatingDisputeAction } from "../actions";

/**
 * Ratings (Section 4.4.3, Section 14.9): two-sided ratings of completed engagements. The org rates the party here; both
 * ratings release together once both are in or 14 days after completion; the org replies once to the party's rating.
 * Ratings are never edited, withdrawn or suppressed, and internal notes never appear here. A rating of a person stays with
 * this org and that person (ADR 0158): the person may dispute it, the org answers here, and a platform operator decides.
 * gateway.ratings_enabled decides only whether members are prompted to rate (ADR 0038): with prompts off the list of
 * engagements waiting for a rating goes, and every rating still shows.
 */
export default async function RatingsPage({
  params,
  searchParams,
}: PageProps<"/[org]/opportunities/ratings">) {
  const routeParams = await params;
  const page = await setupPage(
    "opportunities.ratings",
    routeParams,
    (await searchParams) as SearchParams,
  );
  const { ctx, t } = page;
  const [ratings, completed, settings, disputes] = await Promise.all([
    listRatings(ctx.viewer.db, ctx.org.id),
    listEngagements(ctx.viewer.db, ctx.org.id, { states: ["Complete"] }),
    resolveSettings(ctx.viewer.db, { orgId: ctx.org.id }),
    listRatingDisputes(ctx.viewer.db, ctx.org.id),
  ]);
  const all = must(ratings, "ratings");
  const disputed = must(disputes, "rating disputes");
  const engagements = new Map(must(completed, "engagements").map((e) => [e.id, e]));
  const setting = (key: string) => (settings.ok ? settings.data.get(key)?.value : undefined);
  const prompts = ratingPromptsOn(setting);
  const toRate = engagementsToRate(setting, [...engagements.values()]);
  const received = all.filter((r) => r.side === "Party");
  const average =
    received.length === 0
      ? null
      : Math.round((received.reduce((s, r) => s + r.score, 0) / received.length) * 10) / 10;
  const canRate = ctx.capabilities.has("opportunities.rating.write");
  const engagementsHref = nodeHref("opportunities.engagements", routeParams) ?? page.base;
  return (
    <TemplateCollection
      header={
        <PageHeader
          title={t("ratings.title")}
          count={all.length}
          views={
            <ViewSwitch
              label={t("views.label")}
              views={page.views}
              current={page.view}
              hrefFor={(v) => page.href({ view: v })}
            />
          }
        />
      }
    >
      <div className="grid grid-cols-[repeat(auto-fit,minmax(12rem,1fr))] gap-12">
        <StatTile label={t("ratings.received")} value={received.length} />
        <StatTile
          label={t("ratings.average")}
          value={average}
          caption={average === null ? t("ratings.noAverage") : t("ratings.outOfFive")}
        />
        {prompts ? <StatTile label={t("ratings.toRate")} value={toRate.length} /> : null}
      </div>
      {canRate && toRate.length > 0 ? (
        <Section id="ratings-to-rate" title={t("ratings.toRateTitle")}>
          <ul className="m-0 flex list-none flex-col gap-8 p-0">
            {toRate.map((e) => (
              <li
                key={e.id}
                className="flex flex-col gap-8 rounded-card border border-border-subtle p-8 text-text-13"
              >
                <RowLink href={`${engagementsHref}?id=${e.id}`}>
                  {e.partyName ?? t("engagements.unnamed")} · {e.projectKey}
                </RowLink>
                <ActionForm
                  action={rateAction}
                  hidden={{ org: ctx.org.slug, engagementId: e.id }}
                  inline
                  fields={[
                    {
                      name: "score",
                      label: t("fields.score"),
                      kind: "select",
                      defaultValue: "5",
                      options: ["5", "4", "3", "2", "1"].map((s) => ({
                        value: s,
                        label: t("engagements.stars", { score: Number(s) }),
                      })),
                    },
                    { name: "comment", label: t("fields.publicComment"), kind: "text" },
                  ]}
                  submitLabel={t("engagements.rate")}
                />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {disputed.length > 0 ? (
        <Section id="ratings-disputes" title={t("ratings.disputes.title")}>
          <p className="m-0 text-text-13 text-text-secondary">{t("ratings.disputes.help")}</p>
          <ul className="m-0 flex list-none flex-col gap-8 p-0">
            {disputed.map((d) => (
              <DisputeItem
                key={d.id}
                page={page}
                d={d}
                canRate={canRate}
                engagementsHref={engagementsHref}
              />
            ))}
          </ul>
        </Section>
      ) : null}
      <Section id="ratings-all" title={t("ratings.all")}>
        {all.length === 0 ? (
          <EmptyStateLink
            icon="Star"
            sentence={t("ratings.empty")}
            actionLabel={t("ratings.emptyAction")}
            href={engagementsHref}
          />
        ) : page.view === "list" ? (
          <ul className="m-0 flex list-none flex-col gap-8 p-0">
            {all.map((r) => (
              <RatingItem
                key={r.id}
                page={page}
                r={r}
                e={engagements.get(r.engagementId)}
                canRate={canRate}
              />
            ))}
          </ul>
        ) : (
          <Table
            caption={t("ratings.all")}
            rowKey={(r: Rating) => r.id}
            rows={all}
            columns={[
              {
                key: "party",
                label: t("fields.party"),
                cell: (r: Rating) =>
                  engagements.get(r.engagementId)?.partyName ?? t("engagements.unnamed"),
              },
              {
                key: "side",
                label: t("fields.side"),
                cell: (r: Rating) => t(`ratingSides.${enumKey(r.side)}`),
              },
              {
                key: "score",
                label: t("fields.score"),
                numeric: true,
                cell: (r: Rating) => r.score,
              },
              {
                key: "comment",
                label: t("fields.publicComment"),
                cell: (r: Rating) => r.comment ?? t("none"),
              },
              { key: "reply", label: t("fields.reply"), cell: (r: Rating) => r.reply ?? t("none") },
            ]}
          />
        )}
      </Section>
    </TemplateCollection>
  );
}

function DisputeItem({
  page,
  d,
  canRate,
  engagementsHref,
}: {
  page: PageSetup;
  d: RatingDispute;
  canRate: boolean;
  engagementsHref: string;
}) {
  const { ctx, t } = page;
  const about = d.subject;
  return (
    <li className="flex flex-col gap-4 rounded-card border border-border-subtle p-8 text-text-13">
      {about ? (
        <>
          <p className="m-0 font-medium">
            <RowLink href={`${engagementsHref}?id=${about.engagementId}`}>
              {about.partyName ?? t("engagements.unnamed")} · {about.projectName}
            </RowLink>
          </p>
          {about.ratingScore === null ? null : (
            <p className="m-0">
              {t("ratings.disputes.yourRating", {
                score: t("engagements.stars", { score: about.ratingScore }),
                comment: about.ratingComment ?? t("none"),
              })}
            </p>
          )}
        </>
      ) : null}
      <p className="m-0 font-medium">
        {t(`ratings.disputes.grounds.${enumKey(d.ground)}`)} ·{" "}
        {t(`ratings.disputes.states.${enumKey(d.state)}`)}
      </p>
      <p className="m-0 text-text-secondary">{d.details}</p>
      {d.orgResponse ? (
        <p className="m-0">{t("ratings.disputes.answered", { response: d.orgResponse })}</p>
      ) : canRate && d.state === "Open" ? (
        <ActionForm
          action={respondToRatingDisputeAction}
          hidden={{ org: ctx.org.slug, disputeId: d.id }}
          fields={[
            {
              name: "response",
              label: t("ratings.disputes.answer"),
              kind: "textarea",
              required: true,
            },
          ]}
          submitLabel={t("ratings.disputes.sendAnswer")}
        />
      ) : null}
      {d.decisionStatement ? (
        <p className="m-0">{t("ratings.disputes.decided", { statement: d.decisionStatement })}</p>
      ) : null}
    </li>
  );
}

function RatingItem({
  page,
  r,
  e,
  canRate,
}: {
  page: PageSetup;
  r: Rating;
  e: EngagementCard | undefined;
  canRate: boolean;
}) {
  const { ctx, t } = page;
  return (
    <li className="flex flex-col gap-4 rounded-card border border-border-subtle p-8 text-text-13">
      <p className="m-0 font-medium">
        {e?.partyName ?? t("engagements.unnamed")} · {t(`ratingSides.${enumKey(r.side)}`)} ·{" "}
        {t("engagements.stars", { score: r.score })}
      </p>
      {r.comment ? <p className="m-0 text-text-secondary">{r.comment}</p> : null}
      {r.reply ? <p className="m-0">{t("engagements.replied", { reply: r.reply })}</p> : null}
      {canRate && r.side === "Party" && !r.reply ? (
        <ActionForm
          action={replyAction}
          hidden={{ org: ctx.org.slug, ratingId: r.id }}
          inline
          fields={[{ name: "body", label: t("engagements.reply"), kind: "text", required: true }]}
          submitLabel={t("engagements.sendReply")}
        />
      ) : r.side === "Party" && !r.reply ? (
        <Muted>{t("ratings.replyNeedsWrite")}</Muted>
      ) : null}
    </li>
  );
}
