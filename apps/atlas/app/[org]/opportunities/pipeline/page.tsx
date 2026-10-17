import {
  APPLICATION_ORG_MOVES,
  APPLICATION_STATES,
  getApplication,
  listApplicationAnswers,
  listApplications,
  listInterviews,
  listOfferVersions,
  type ApplicationCard,
} from "@xos/data/opportunities";
import type { Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm, type FieldSpec } from "@/components/opportunities/action-form";
import { SharedProfile } from "@/components/opportunities/shared-profile";
import {
  Muted,
  Properties,
  RowLink,
  Section,
  Table,
  ViewSwitch,
} from "@/components/opportunities/parts";
import {
  PageHeader,
  StateChip,
  Tag,
  TemplateCollection,
  TemplateRecord,
} from "@/components/opportunities/ui";
import { EmptyStateLink } from "@/components/ui";
import { applicationIcon, enumKey, formatMoney, offerIcon } from "@/lib/opportunities/format";
import { must, setupPage, type PageSetup, type SearchParams } from "@/lib/opportunities/page";
import { nodeHref } from "@/lib/shell/sitemap";
import {
  acceptCounterAction,
  createEngagementAction,
  reviseOfferAction,
  scheduleInterviewAction,
  sendOfferAction,
  shortlistAction,
  transitionApplicationAction,
  withdrawOfferAction,
} from "../actions";

/**
 * Pipeline (Section 4.5.5: board by application state; Section 4.4.4 stages 3 to 5). Applications, bids and agency
 * slates arrive from Gateway; the org reviews, shortlists, interviews or auditions, levels bids once they are unsealed,
 * and sends offers. Counters come back as new terms the org revises or accepts; an accepted application becomes an
 * engagement here. Bid totals stay hidden until the deadline unless the viewer may unseal (Section 8.7).
 */
export default async function PipelinePage({
  params,
  searchParams,
}: PageProps<"/[org]/opportunities/pipeline">) {
  const routeParams = await params;
  const page = await setupPage(
    "opportunities.pipeline",
    routeParams,
    (await searchParams) as SearchParams,
  );
  const { ctx, t, param } = page;
  const id = param("id");
  if (id) {
    const application = await getApplication(ctx.viewer.db, id);
    if (!application.ok) {
      if (application.error.kind === "not-found") notFound();
      throw new Error(`Cannot read application: ${JSON.stringify(application.error)}`);
    }
    return <ApplicationRecord page={page} a={application.data} params={routeParams} />;
  }
  const opportunityId = param("opportunity");
  const rows = must(
    await listApplications(ctx.viewer.db, ctx.org.id, opportunityId ? { opportunityId } : {}),
    "applications",
  );
  const postings = nodeHref("opportunities.postings", routeParams) ?? page.base;
  return (
    <TemplateCollection
      header={
        <PageHeader
          title={t("pipeline.title")}
          count={rows.length}
          views={
            <ViewSwitch
              label={t("views.label")}
              views={page.views}
              current={page.view}
              hrefFor={(v) => page.href({ view: v })}
            />
          }
          actions={
            opportunityId ? (
              <RowLink href={page.href({ opportunity: null })}>{t("pipeline.allPostings")}</RowLink>
            ) : null
          }
        />
      }
    >
      {rows.length === 0 ? (
        <EmptyStateLink
          icon="Inbox"
          sentence={t("pipeline.empty")}
          actionLabel={t("pipeline.emptyAction")}
          href={postings}
        />
      ) : page.view === "table" ? (
        <Table
          caption={t("pipeline.title")}
          rowKey={(a) => a.id}
          rows={rows}
          columns={[
            {
              key: "applicant",
              label: t("fields.applicant"),
              cell: (a) => (
                <RowLink href={page.href({ id: a.id })}>{applicantLabel(page, a)}</RowLink>
              ),
            },
            {
              key: "state",
              label: t("fields.state"),
              cell: (a) => (
                <StateChip
                  state={applicationIcon(a.state)}
                  label={t(`applicationStates.${enumKey(a.state)}`)}
                  compact
                />
              ),
            },
            { key: "posting", label: t("fields.posting"), cell: (a) => a.opportunityTitle },
            {
              key: "rank",
              label: t("fields.rank"),
              numeric: true,
              cell: (a) => a.shortlistRank ?? t("none"),
            },
            { key: "bid", label: t("fields.bid"), cell: (a) => bidLabel(page, a) },
            {
              key: "offer",
              label: t("fields.offer"),
              cell: (a) => (a.offerState ? t(`offerStates.${enumKey(a.offerState)}`) : t("none")),
            },
          ]}
        />
      ) : page.view === "list" ? (
        <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle rounded-card border border-border-subtle p-0">
          {rows.map((a) => (
            <li
              key={a.id}
              className="flex flex-wrap items-center justify-between gap-8 px-12 py-8 hover:bg-bg-hover"
            >
              <div className="flex min-w-0 flex-col gap-2">
                <RowLink href={page.href({ id: a.id })}>{applicantLabel(page, a)}</RowLink>
                <span className="text-text-12 text-text-secondary">{a.opportunityTitle}</span>
              </div>
              <StateChip
                state={applicationIcon(a.state)}
                label={t(`applicationStates.${enumKey(a.state)}`)}
                compact
              />
            </li>
          ))}
        </ul>
      ) : (
        <div className="grid auto-cols-[minmax(15rem,1fr)] grid-flow-col gap-12 overflow-x-auto pb-8">
          {APPLICATION_STATES.map((s) => {
            const cards = rows.filter((a) => a.state === s);
            return (
              <section
                key={s}
                aria-label={t(`applicationStates.${enumKey(s)}`)}
                className="flex min-w-0 flex-col gap-8 rounded-card bg-bg-surface p-8"
              >
                <h2 className="m-0 flex items-center justify-between text-label-13 font-semibold">
                  {t(`applicationStates.${enumKey(s)}`)}{" "}
                  <span className="tabular-nums text-text-secondary">{cards.length}</span>
                </h2>
                {cards.length === 0 ? <Muted>{t("board.emptyColumn")}</Muted> : null}
                <ul className="m-0 flex list-none flex-col gap-8 p-0">
                  {cards.map((a) => (
                    <li key={a.id}>
                      <Link
                        href={page.href({ id: a.id }) as Route}
                        className="flex flex-col gap-4 rounded-card border border-border-subtle bg-bg-raised p-8 text-text-13 hover:bg-bg-hover"
                      >
                        <span className="font-medium">{applicantLabel(page, a)}</span>
                        <span className="text-text-12 text-text-secondary">
                          {a.opportunityTitle}
                        </span>
                        <span className="flex flex-wrap gap-4">
                          {a.shortlistRank ? (
                            <Tag tone="accent">{t("pipeline.rank", { rank: a.shortlistRank })}</Tag>
                          ) : null}
                          {a.hasBid ? <Tag tone="neutral">{bidLabel(page, a)}</Tag> : null}
                          {a.offerState ? (
                            <Tag tone={a.offerState === "Countered" ? "warning" : "neutral"}>
                              {t(`offerStates.${enumKey(a.offerState)}`)}
                            </Tag>
                          ) : null}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </TemplateCollection>
  );
}

function applicantLabel(page: PageSetup, a: ApplicationCard): string {
  return (
    a.applicantName ??
    page.t(a.applicantKind === "Account" ? "pipeline.unnamedAccount" : "pipeline.unnamedPerson")
  );
}

function bidLabel(page: PageSetup, a: ApplicationCard): string {
  if (!a.hasBid) return page.t("none");
  if (a.bidSealed) return page.t("pipeline.sealed");
  return (
    formatMoney(page.locale, a.bidTotalMinor, a.bidCurrencyCode) ?? page.t("pipeline.bidUnpriced")
  );
}

function termsFields(
  page: PageSetup,
  defaults: { amount?: string; currency?: string },
): FieldSpec[] {
  const { t } = page;
  return [
    {
      name: "rateType",
      label: t("fields.rateType"),
      kind: "select",
      defaultValue: "Day",
      options: [
        { value: "", label: t("pipeline.amountOpen") },
        ...(["Hourly", "Day", "Flat", "Milestone"] as const).map((r) => ({
          value: r,
          label: t(`rateTypes.${enumKey(r)}`),
        })),
      ],
    },
    {
      name: "amount",
      label: t("fields.amount"),
      kind: "text",
      defaultValue: defaults.amount ?? "",
      help: t("pipeline.amountHelp"),
    },
    {
      name: "currencyCode",
      label: t("fields.currency"),
      kind: "text",
      defaultValue: defaults.currency ?? "USD",
    },
    { name: "startsOn", label: t("fields.startsOn"), kind: "date" },
    { name: "endsOn", label: t("fields.endsOn"), kind: "date" },
    { name: "expiresAt", label: t("fields.expiresAt"), kind: "datetime-local" },
    { name: "message", label: t("fields.message"), kind: "textarea" },
  ];
}

async function ApplicationRecord({
  page,
  a,
  params,
}: {
  page: PageSetup;
  a: ApplicationCard;
  params: Readonly<Record<string, string>>;
}) {
  const { ctx, t } = page;
  const db = ctx.viewer.db;
  const [answers, interviews, versions] = await Promise.all([
    listApplicationAnswers(db, a.id),
    listInterviews(db, a.id),
    a.offerId ? listOfferVersions(db, a.offerId) : Promise.resolve({ ok: true as const, data: [] }),
  ]);
  const canReview = ctx.capabilities.has("opportunities.application.review");
  const canOffer = ctx.capabilities.has("opportunities.offer.send");
  const canEngage = ctx.capabilities.has("opportunities.engagement.write");
  const hidden = { org: ctx.org.slug, applicationId: a.id };
  const moves = APPLICATION_ORG_MOVES[a.state].filter(
    (m) => m !== "Not Selected" || ctx.capabilities.has("opportunities.selection.decide"),
  );
  const engagements = nodeHref("opportunities.engagements", params);
  const orgTurn = a.offerTurnSide === "Party";
  const offerOpen = a.offerState === "Sent" || a.offerState === "Countered";
  return (
    <TemplateRecord
      propertiesLabel={t("record.properties")}
      header={
        <header className="flex flex-col gap-8 border-b border-border-subtle pb-12">
          <Link
            href={page.href({ id: null }) as Route}
            className="text-text-12 text-text-secondary hover:text-text-primary"
          >
            {t("pipeline.back")}
          </Link>
          <div className="flex flex-wrap items-center gap-8">
            <h1 className="m-0 text-heading-20 font-semibold">{applicantLabel(page, a)}</h1>
            <StateChip
              state={applicationIcon(a.state)}
              label={t(`applicationStates.${enumKey(a.state)}`)}
            />
            <Tag tone="neutral">{t(`applicantKinds.${a.applicantKind.toLowerCase()}`)}</Tag>
          </div>
          <p className="m-0 text-text-13 text-text-secondary">{a.opportunityTitle}</p>
        </header>
      }
      properties={
        <div className="flex flex-col gap-16">
          <Properties
            label={t("record.properties")}
            items={[
              { label: t("fields.project"), value: a.projectKey },
              {
                label: t("fields.submitted"),
                value: new Date(a.submittedAt).toLocaleString(page.locale),
              },
              {
                label: t("fields.availability"),
                value: a.availabilityConfirmed ? t("yes") : t("no"),
              },
              {
                label: t("fields.proposedFee"),
                value: formatMoney(page.locale, a.proposedFeeMinor, a.currencyCode) ?? t("none"),
              },
              { label: t("fields.rank"), value: a.shortlistRank ?? t("none") },
              { label: t("fields.bid"), value: bidLabel(page, a) },
              {
                label: t("fields.nextInterview"),
                value: a.nextInterviewAt
                  ? new Date(a.nextInterviewAt).toLocaleString(page.locale)
                  : t("none"),
              },
            ]}
          />
          {canReview && moves.length > 0 ? (
            <ActionForm
              action={transitionApplicationAction}
              hidden={{ ...hidden, expected: a.state }}
              title={t("transitions.title")}
              fields={[
                {
                  name: "next",
                  label: t("transitions.next"),
                  kind: "select",
                  defaultValue: moves[0] ?? "",
                  options: moves.map((m) => ({
                    value: m,
                    label: t(`applicationMoves.${enumKey(m)}`),
                  })),
                },
                { name: "reason", label: t("transitions.reason"), kind: "text", required: true },
              ]}
              submitLabel={t("transitions.submit")}
              variant="primary"
              successLabel={t("transitions.done")}
            />
          ) : null}
          {canReview && (a.state === "In Review" || a.state === "Shortlisted") ? (
            <ActionForm
              action={shortlistAction}
              hidden={{ org: ctx.org.slug, applicationId: a.id, opportunityId: a.opportunityId }}
              title={t("pipeline.shortlist")}
              fields={[
                {
                  name: "rank",
                  label: t("fields.rank"),
                  kind: "number",
                  min: 1,
                  defaultValue: String(a.shortlistRank ?? 1),
                },
                {
                  name: "note",
                  label: t("fields.internalNote"),
                  kind: "textarea",
                  help: t("pipeline.internalHelp"),
                },
              ]}
              submitLabel={t("pipeline.setRank")}
            />
          ) : null}
        </div>
      }
    >
      <Section id="application-note" title={t("pipeline.coverNote")}>
        {a.coverNote ? (
          <p className="m-0 whitespace-pre-wrap text-text-14">{a.coverNote}</p>
        ) : (
          <Muted>{t("pipeline.noCoverNote")}</Muted>
        )}
      </Section>
      <SharedProfile db={db} applicationId={a.id} />
      <Section id="application-answers" title={t("pipeline.answers")}>
        {must(answers, "answers").length === 0 ? <Muted>{t("pipeline.noAnswers")}</Muted> : null}
        <dl className="m-0 flex flex-col gap-8 text-text-13">
          {must(answers, "answers").map((x) => (
            <div key={x.id}>
              <dt className="font-medium">{x.prompt}</dt>
              <dd className="m-0 whitespace-pre-wrap text-text-secondary">{x.answer}</dd>
            </div>
          ))}
        </dl>
      </Section>
      <Section id="application-interviews" title={t("pipeline.interviews")}>
        {must(interviews, "interviews").length === 0 ? (
          <Muted>{t("pipeline.noInterviews")}</Muted>
        ) : null}
        <ul className="m-0 flex list-none flex-col gap-4 p-0 text-text-13">
          {must(interviews, "interviews").map((i) => (
            <li key={i.id}>
              {t(`interviewKinds.${enumKey(i.kind)}`)} ·{" "}
              {new Date(i.scheduledAt).toLocaleString(page.locale)} ·{" "}
              {t("pipeline.minutes", { minutes: i.durationMinutes })}
              {i.location ? ` · ${i.location}` : ""}
            </li>
          ))}
        </ul>
        {canReview && (a.state === "In Review" || a.state === "Shortlisted") ? (
          <ActionForm
            action={scheduleInterviewAction}
            hidden={hidden}
            inline
            fields={[
              {
                name: "kind",
                label: t("fields.kind"),
                kind: "select",
                defaultValue: a.roleType === "Artist" ? "Audition" : "Interview",
                options: (["Interview", "Audition"] as const).map((k) => ({
                  value: k,
                  label: t(`interviewKinds.${enumKey(k)}`),
                })),
              },
              {
                name: "scheduledAt",
                label: t("fields.when"),
                kind: "datetime-local",
                required: true,
              },
              {
                name: "durationMinutes",
                label: t("fields.minutes"),
                kind: "number",
                min: 5,
                max: 480,
                defaultValue: "30",
              },
              { name: "location", label: t("fields.location"), kind: "text" },
            ]}
            submitLabel={t("pipeline.schedule")}
          />
        ) : null}
      </Section>
      <Section id="application-offer" title={t("pipeline.offer")}>
        {a.offerState ? (
          <p className="m-0 flex flex-wrap items-center gap-8 text-text-13">
            <StateChip
              state={offerIcon(a.offerState)}
              label={t(`offerStates.${enumKey(a.offerState)}`)}
              compact
            />
            {offerOpen ? (orgTurn ? t("pipeline.yourTurn") : t("pipeline.theirTurn")) : null}
          </p>
        ) : (
          <Muted>
            {a.state === "In Review" || a.state === "Shortlisted"
              ? t("pipeline.noOffer")
              : t("pipeline.offerNotYet")}
          </Muted>
        )}
        <ol className="m-0 flex list-none flex-col gap-8 p-0">
          {must(versions, "offer terms").map((v) => (
            <li key={v.id} className="rounded-card border border-border-subtle p-8 text-text-13">
              <p className="m-0 font-medium">
                {t("pipeline.version", { version: v.version })} ·{" "}
                {t(`offerSides.${enumKey(v.side)}`)}
              </p>
              <p className="m-0">
                {formatMoney(page.locale, v.amountMinor, v.currencyCode) ??
                  t("pipeline.amountOpen")}
                {v.rateType ? ` · ${t(`rateTypes.${enumKey(v.rateType)}`)}` : ""}
              </p>
              {v.message ? (
                <p className="m-0 whitespace-pre-wrap text-text-secondary">{v.message}</p>
              ) : null}
            </li>
          ))}
        </ol>
        {canOffer && !a.offerId && (a.state === "In Review" || a.state === "Shortlisted") ? (
          <ActionForm
            action={sendOfferAction}
            hidden={hidden}
            title={t("pipeline.sendOffer")}
            fields={termsFields(page, {})}
            submitLabel={t("pipeline.send")}
            variant="primary"
          />
        ) : null}
        {canOffer && a.offerId && offerOpen && orgTurn ? (
          <div className="flex flex-col gap-12">
            <ActionForm
              action={acceptCounterAction}
              hidden={{ org: ctx.org.slug, offerId: a.offerId }}
              fields={[]}
              submitLabel={t("pipeline.acceptCounter")}
              variant="primary"
            />
            <ActionForm
              action={reviseOfferAction}
              hidden={{ org: ctx.org.slug, offerId: a.offerId }}
              title={t("pipeline.revise")}
              fields={termsFields(page, {})}
              submitLabel={t("pipeline.sendRevision")}
            />
          </div>
        ) : null}
        {canOffer && a.offerId && offerOpen ? (
          <ActionForm
            action={withdrawOfferAction}
            hidden={{ org: ctx.org.slug, offerId: a.offerId }}
            inline
            fields={[
              { name: "reason", label: t("transitions.reason"), kind: "text", required: true },
            ]}
            submitLabel={t("pipeline.withdraw")}
            variant="danger"
          />
        ) : null}
      </Section>
      {a.state === "Accepted" ? (
        <Section id="application-engage" title={t("pipeline.engage")}>
          {a.engagementId && engagements ? (
            <RowLink href={`${engagements}?id=${a.engagementId}`}>
              {t("pipeline.openEngagement")}
            </RowLink>
          ) : canEngage ? (
            <ActionForm
              action={createEngagementAction}
              hidden={hidden}
              fields={[
                {
                  name: "workerClassification",
                  label: t("fields.classification"),
                  kind: "select",
                  defaultValue:
                    a.applicantKind === "Account" ? "VENDOR_SUPPLIED" : "INDEPENDENT_CONTRACTOR",
                  help: t("pipeline.classificationHelp"),
                  options: (
                    [
                      "INDEPENDENT_CONTRACTOR",
                      "EMPLOYEE",
                      "VENDOR_SUPPLIED",
                      "UNPAID_INTERN",
                      "VOLUNTEER",
                    ] as const
                  ).map((c) => ({ value: c, label: t(`classifications.${c}`) })),
                },
                {
                  name: "payBasis",
                  label: t("fields.payBasis"),
                  kind: "select",
                  defaultValue: "Day Rate",
                  options: [
                    { value: "", label: t("pipeline.unpaid") },
                    ...["Day Rate", "Hourly", "Flat Fee", "Salary"].map((p) => ({
                      value: p,
                      label: t(`payBases.${enumKey(p)}`),
                    })),
                  ],
                },
                {
                  name: "arrangement",
                  label: t("fields.arrangement"),
                  kind: "select",
                  defaultValue: "Per Engagement",
                  options: [
                    { value: "", label: t("pipeline.unpaid") },
                    ...["Per Engagement", "Retainer"].map((p) => ({
                      value: p,
                      label: t(`arrangements.${enumKey(p)}`),
                    })),
                  ],
                },
                { name: "startDate", label: t("fields.startsOn"), kind: "date" },
                { name: "endDate", label: t("fields.endsOn"), kind: "date" },
              ]}
              submitLabel={t("pipeline.createEngagement")}
              variant="primary"
              successLabel={t("pipeline.engaged")}
            />
          ) : (
            <Muted>{t("pipeline.engageNeedsWrite")}</Muted>
          )}
        </Section>
      ) : null}
    </TemplateRecord>
  );
}
