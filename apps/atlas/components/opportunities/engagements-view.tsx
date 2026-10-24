import {
  DOCUMENT_KINDS,
  DOCUMENT_ORG_MOVES,
  ENGAGEMENT_MOVES,
  ENGAGEMENT_STATES,
  getEngagement,
  getEngagementRate,
  listDeliverables,
  listEngagementDocuments,
  listEngagements,
  listOnboardingStatus,
  listPools,
  listRatings,
  type EngagementCard,
} from "@xos/data/opportunities";
import { resolveSettings } from "@xos/data/settings";
import type { Route } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import {
  addPoolMemberAction,
  createDocumentAction,
  decideDeliverableAction,
  issueSigningLinkAction,
  rateAction,
  replyAction,
  setDeliverableFeeAction,
  transitionDocumentAction,
  transitionEngagementAction,
  verifyItemAction,
} from "@/app/[org]/opportunities/actions";
import { ActionForm } from "@/components/opportunities/action-form";
import { ratingPromptsOn } from "@/lib/shell/org-settings";
import { EngagementInsureds } from "@/components/opportunities/insured-checks";
import {
  Muted,
  Properties,
  RowLink,
  Section,
  Table,
  ViewSwitch,
} from "@/components/opportunities/parts";
import {
  EngagementTimeline,
  PageHeader,
  StateChip,
  Tag,
  TemplateCollection,
  TemplateRecord,
} from "@/components/opportunities/ui";
import { EmptyStateLink } from "@/components/ui";
import { SharedWorkDetailsSection } from "@/components/work-details/shared-work-details";
import {
  deliverableIcon,
  documentIcon,
  engagementIcon,
  engagementLine,
  engagementProperties,
  enumKey,
  formatMoney,
  type EngagementProperty,
} from "@/lib/opportunities/format";
import { must, type PageSetup } from "@/lib/opportunities/page";

/**
 * Engagements (Section 4.4.4 stages 6 to 9) for the org page and the project Engagements tab: the list in table, list or
 * board view, and the record with the stage timeline, onboarding verification, documents with signing links and
 * countersignature, deliverables, ratings and re-engagement into a pool. Active is refused by the database until every
 * blocking onboarding item passes; Complete narrows the party's access to money and documents (Section 8.7).
 */
export async function EngagementsView({
  page,
  projectId,
  emptyHref,
}: {
  page: PageSetup;
  projectId?: string;
  emptyHref: string;
}) {
  const { ctx, t, param } = page;
  const id = param("id");
  if (id) {
    const engagement = await getEngagement(ctx.viewer.db, id);
    if (!engagement.ok) {
      if (engagement.error.kind === "not-found") notFound();
      throw new Error(`Cannot read engagement: ${JSON.stringify(engagement.error)}`);
    }
    if (projectId && engagement.data.projectId !== projectId) notFound();
    return <EngagementRecord page={page} e={engagement.data} />;
  }
  const [listed, settings] = await Promise.all([
    listEngagements(ctx.viewer.db, ctx.org.id, projectId ? { projectId } : {}),
    resolveSettings(ctx.viewer.db, { orgId: ctx.org.id }),
  ]);
  const rows = must(listed, "engagements");
  // gateway.ratings_enabled: prompts only, so the Rate the party next step goes and ratings stay (ADR 0038).
  const prompts = ratingPromptsOn((key) =>
    settings.ok ? settings.data.get(key)?.value : undefined,
  );
  const open = (e: EngagementCard) => page.href({ id: e.id });
  return (
    <TemplateCollection
      header={
        <PageHeader
          title={t("engagements.title")}
          count={rows.length}
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
      {rows.length === 0 ? (
        <EmptyStateLink
          icon="Handshake"
          sentence={t("engagements.empty")}
          actionLabel={t("engagements.emptyAction")}
          href={emptyHref}
        />
      ) : page.view === "board" ? (
        <div className="grid auto-cols-[minmax(14rem,1fr)] grid-flow-col gap-12 overflow-x-auto pb-8">
          {ENGAGEMENT_STATES.map((s) => {
            const cards = rows.filter((e) => e.state === s);
            return (
              <section
                key={s}
                aria-label={t(`engagementStates.${enumKey(s)}`)}
                className="flex min-w-0 flex-col gap-8 rounded-card bg-bg-surface p-8"
              >
                <h2 className="m-0 flex items-center justify-between text-label-13 font-semibold">
                  {t(`engagementStates.${enumKey(s)}`)}{" "}
                  <span className="tabular-nums text-text-secondary">{cards.length}</span>
                </h2>
                {cards.length === 0 ? <Muted>{t("board.emptyColumn")}</Muted> : null}
                <ul className="m-0 flex list-none flex-col gap-8 p-0">
                  {cards.map((e) => (
                    <li key={e.id}>
                      <Link
                        href={open(e) as Route}
                        className="flex flex-col gap-4 rounded-card border border-border-subtle bg-bg-raised p-8 text-text-13 hover:bg-bg-hover"
                      >
                        <span className="font-medium">
                          {e.partyName ?? t("engagements.unnamed")}
                        </span>
                        <span className="text-text-12 text-text-secondary">
                          {e.projectKey} ·{" "}
                          {e.jobTitle ?? e.roleCode ?? t(`roleTypes.${enumKey(e.roleType)}`)}
                        </span>
                        {e.openBlockingCount > 0 ? (
                          <Tag tone="warning">
                            {t("engagements.blockingOpen", { count: e.openBlockingCount })}
                          </Tag>
                        ) : null}
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      ) : page.view === "list" ? (
        <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle rounded-card border border-border-subtle p-0">
          {rows.map((e) => (
            <li
              key={e.id}
              className="flex flex-wrap items-center justify-between gap-8 px-12 py-8 hover:bg-bg-hover"
            >
              <div className="flex min-w-0 flex-col gap-2">
                <RowLink href={open(e)}>{e.partyName ?? t("engagements.unnamed")}</RowLink>
                <span className="text-text-12 text-text-secondary">
                  {engagementLine(e, t(`roleTypes.${enumKey(e.roleType)}`))}
                </span>
              </div>
              <StateChip
                state={engagementIcon(e.state)}
                label={t(`engagementStates.${enumKey(e.state)}`)}
                compact
              />
            </li>
          ))}
        </ul>
      ) : (
        <Table
          caption={t("engagements.title")}
          rowKey={(e) => e.id}
          rows={rows}
          columns={[
            {
              key: "party",
              label: t("fields.party"),
              cell: (e) => (
                <RowLink href={open(e)}>{e.partyName ?? t("engagements.unnamed")}</RowLink>
              ),
            },
            {
              key: "state",
              label: t("fields.state"),
              cell: (e) => (
                <StateChip
                  state={engagementIcon(e.state)}
                  label={t(`engagementStates.${enumKey(e.state)}`)}
                  compact
                />
              ),
            },
            { key: "next", label: t("fields.next"), cell: (e) => nextStep(page, e, prompts) },
            { key: "project", label: t("fields.project"), cell: (e) => e.projectKey },
            {
              key: "role",
              label: t("fields.roleType"),
              cell: (e) => t(`roleTypes.${enumKey(e.roleType)}`),
            },
            { key: "start", label: t("fields.startsOn"), cell: (e) => e.startDate },
          ]}
        />
      )}
    </TemplateCollection>
  );
}

/** What the engagement needs next (Section 11.10 habit 4: every row answers "what now"). */
function nextStep(page: PageSetup, e: EngagementCard, ratingPrompts: boolean): string {
  const { t } = page;
  if (e.state === "Onboarding" || e.state === "Blocked") {
    return e.openBlockingCount > 0
      ? t("engagements.next.onboarding", { count: e.openBlockingCount })
      : t("engagements.next.activate");
  }
  if (e.documentsInFlight > 0)
    return t("engagements.next.documents", { count: e.documentsInFlight });
  if (e.deliverablesToReview > 0)
    return t("engagements.next.deliverables", { count: e.deliverablesToReview });
  if (e.state === "Complete" && !e.orgRated && ratingPrompts) return t("engagements.next.rate");
  if (e.state === "Complete") return t("engagements.next.reengage");
  return t("engagements.next.none");
}

/** The nine stages of Section 4.4.4 and where the engagement stands. */
function stageIndex(e: EngagementCard): number {
  switch (e.state) {
    case "Onboarding":
    case "Blocked":
      return 5;
    case "Active":
      return 6;
    case "Closing":
      return 7;
    case "Complete":
      return e.orgRated ? 8 : 7;
    case "Canceled":
      return 5;
  }
}

async function EngagementRecord({ page, e }: { page: PageSetup; e: EngagementCard }) {
  const { ctx, t } = page;
  const db = ctx.viewer.db;
  const [rate, items, documents, deliverables, ratings, pools] = await Promise.all([
    getEngagementRate(db, e.id),
    listOnboardingStatus(db, { engagementId: e.id }),
    listEngagementDocuments(db, e.id),
    listDeliverables(db, e.id),
    listRatings(db, ctx.org.id),
    listPools(db, ctx.org.id),
  ]);
  const canWrite = ctx.capabilities.has("opportunities.engagement.write");
  const canVerify = ctx.capabilities.has("opportunities.onboarding.write") || canWrite;
  const canRate = ctx.capabilities.has("opportunities.rating.write");
  const canPool = ctx.capabilities.has("opportunities.pool.write");
  const resolved = must(rate, "rate");
  // A client or sponsor engagement shows no role, classification, rate or pay basis (engagementProperties, 1624).
  const properties: Record<EngagementProperty, { label: string; value: ReactNode }> = {
    role: {
      label: t("fields.role"),
      value: (
        <span>
          {e.jobTitle ?? e.roleCode}{" "}
          <span className="font-mono text-text-12 text-text-secondary">{e.roleCode}</span>
        </span>
      ),
    },
    classification: {
      label: t("fields.classification"),
      value: e.workerClassification ? t(`classifications.${e.workerClassification}`) : t("none"),
    },
    account: { label: t("fields.account"), value: e.accountName ?? t("none") },
    dates: {
      label: t("fields.dates"),
      value: t("dateRange", { start: e.startDate, end: e.endDate ?? t("openEnded") }),
    },
    rate: {
      label: t("fields.rate"),
      value: resolved.masked
        ? t("engagements.rateMasked")
        : (formatMoney(page.locale, resolved.rateMinor, resolved.currencyCode) ??
          (resolved.payBasis ? t("unpriced") : t("engagements.unpaid"))),
    },
    payBasis: {
      label: t("fields.payBasis"),
      value: resolved.payBasis ? t(`payBases.${enumKey(resolved.payBasis)}`) : t("none"),
    },
  };
  const myRatings = must(ratings, "ratings").filter((r) => r.engagementId === e.id);
  const partyRating = myRatings.find((r) => r.side === "Party");
  const orgRating = myRatings.find((r) => r.side === "Organization");
  const poolOptions = must(pools, "pools")
    .filter((p) => (p.kind === "Talent" ? e.personId !== null : e.accountId !== null))
    .map((p) => ({ value: p.id, label: p.name }));
  const moves = ENGAGEMENT_MOVES[e.state];
  const stages = [
    "requisition",
    "opportunity",
    "application",
    "selection",
    "offer",
    "onboarding",
    "engaged",
    "closeout",
    "reengagement",
  ].map((s) => ({
    label: t(`stages.${s}`),
  }));
  return (
    <TemplateRecord
      propertiesLabel={t("record.properties")}
      header={
        <header className="flex flex-col gap-8 border-b border-border-subtle pb-12">
          <Link
            href={page.href({ id: null }) as Route}
            className="text-text-12 text-text-secondary hover:text-text-primary"
          >
            {t("engagements.back")}
          </Link>
          <div className="flex flex-wrap items-center gap-8">
            <h1 className="m-0 text-heading-20 font-semibold">
              {e.partyName ?? t("engagements.unnamed")}
            </h1>
            <StateChip
              state={engagementIcon(e.state)}
              label={t(`engagementStates.${enumKey(e.state)}`)}
            />
            <Tag tone="neutral">{t(`roleTypes.${enumKey(e.roleType)}`)}</Tag>
          </div>
          <p className="m-0 text-text-13 text-text-secondary">
            {e.projectKey} · {e.projectName}
          </p>
        </header>
      }
      properties={
        <div className="flex flex-col gap-16">
          <Properties
            label={t("record.properties")}
            items={engagementProperties(e.roleType).map((key) => properties[key])}
          />
          {canWrite && moves.length > 0 ? (
            <ActionForm
              action={transitionEngagementAction}
              hidden={{ org: ctx.org.slug, engagementId: e.id, expected: e.state }}
              title={t("transitions.title")}
              fields={[
                {
                  name: "next",
                  label: t("transitions.next"),
                  kind: "select",
                  defaultValue: moves[0] ?? "",
                  options: moves.map((m) => ({
                    value: m,
                    label: t(`engagementMoves.${enumKey(m)}`),
                  })),
                },
                { name: "reason", label: t("transitions.reason"), kind: "text", required: true },
              ]}
              submitLabel={t("transitions.submit")}
              variant="primary"
              successLabel={t("transitions.done")}
            />
          ) : null}
          <div className="flex flex-col gap-8">
            <h2 className="m-0 text-heading-14 font-semibold">{t("engagements.stages")}</h2>
            <EngagementTimeline current={stageIndex(e)} stages={stages} />
          </div>
        </div>
      }
    >
      <Section id="engagement-onboarding" title={t("engagements.onboarding")}>
        {must(items, "onboarding").length === 0 ? (
          <Muted>{t("engagements.noOnboarding")}</Muted>
        ) : null}
        <ul className="m-0 flex list-none flex-col gap-8 p-0">
          {must(items, "onboarding").map((i) => (
            <li
              key={i.itemId}
              className="flex flex-col gap-4 rounded-card border border-border-subtle p-8 text-text-13"
            >
              <div className="flex flex-wrap items-center justify-between gap-8">
                <span className="font-medium">
                  {i.name}{" "}
                  <span className="text-text-secondary">· {t(`itemKinds.${enumKey(i.kind)}`)}</span>
                </span>
                <span className="flex flex-wrap gap-4">
                  {i.blocking ? <Tag tone="warning">{t("onboarding.blocking")}</Tag> : null}
                  <Tag
                    tone={
                      i.passes || i.carriedOver
                        ? "success"
                        : i.latestOutcome === "Failed"
                          ? "danger"
                          : "neutral"
                    }
                  >
                    {i.passes
                      ? t("onboarding.passes")
                      : i.carriedOver
                        ? t("onboarding.carriedOver")
                        : i.latestOutcome === "Failed"
                          ? t("onboarding.failed")
                          : i.submittedAt
                            ? t("onboarding.toReview")
                            : t("onboarding.awaitingParty")}
                  </Tag>
                  {i.reminderDue ? <Tag tone="warning">{t("onboarding.expiring")}</Tag> : null}
                </span>
              </div>
              {canVerify && i.method === "Reviewer" && !i.passes ? (
                <ActionForm
                  action={verifyItemAction}
                  hidden={{ org: ctx.org.slug, itemId: i.itemId }}
                  inline
                  fields={[
                    {
                      name: "outcome",
                      label: t("onboarding.outcome"),
                      kind: "select",
                      defaultValue: "Passed",
                      options: (["Passed", "Failed"] as const).map((o) => ({
                        value: o,
                        label: t(`outcomes.${enumKey(o)}`),
                      })),
                    },
                    { name: "note", label: t("fields.internalNote"), kind: "text" },
                  ]}
                  submitLabel={t("onboarding.verify")}
                />
              ) : null}
            </li>
          ))}
        </ul>
        <EngagementInsureds
          db={db}
          orgSlug={ctx.org.slug}
          engagementId={e.id}
          items={must(items, "onboarding")
            .filter((i) => i.method === "Reviewer" && !i.passes)
            .map((i) => ({ itemId: i.itemId, name: i.name }))}
          canVerify={canVerify}
        />
      </Section>
      {e.personId ? (
        <SharedWorkDetailsSection ctx={ctx} engagementId={e.id} partyName={e.partyName} />
      ) : null}
      <Section id="engagement-documents" title={t("engagements.documents")}>
        {must(documents, "documents").length === 0 ? (
          <Muted>{t("engagements.noDocuments")}</Muted>
        ) : null}
        <ul className="m-0 flex list-none flex-col gap-8 p-0">
          {must(documents, "documents").map((d) => {
            const docMoves = DOCUMENT_ORG_MOVES[d.state];
            return (
              <li
                key={d.id}
                className="flex flex-col gap-8 rounded-card border border-border-subtle p-8 text-text-13"
              >
                <div className="flex flex-wrap items-center justify-between gap-8">
                  <span className="font-medium">
                    {d.title}{" "}
                    <span className="text-text-secondary">
                      · {t(`documentKinds.${enumKey(d.kind)}`)}
                    </span>
                  </span>
                  <StateChip
                    state={documentIcon(d.state)}
                    label={t(`documentStates.${enumKey(d.state)}`)}
                    compact
                  />
                </div>
                {canWrite && docMoves.length > 0 ? (
                  <ActionForm
                    action={transitionDocumentAction}
                    hidden={{ org: ctx.org.slug, documentId: d.id, expected: d.state }}
                    inline
                    fields={[
                      {
                        name: "next",
                        label: t("transitions.next"),
                        kind: "select",
                        defaultValue: docMoves[0] ?? "",
                        options: docMoves.map((m) => ({
                          value: m,
                          label: t(`documentMoves.${enumKey(m)}`),
                        })),
                      },
                      {
                        name: "reason",
                        label: t("transitions.reason"),
                        kind: "text",
                        required: true,
                      },
                    ]}
                    submitLabel={t("transitions.submit")}
                  />
                ) : null}
                {canWrite && d.state === "Sent" ? (
                  <ActionForm
                    action={issueSigningLinkAction}
                    hidden={{ org: ctx.org.slug, documentId: d.id }}
                    inline
                    fields={[
                      { name: "email", label: t("fields.email"), kind: "email", required: true },
                      {
                        name: "days",
                        label: t("fields.validDays"),
                        kind: "number",
                        min: 1,
                        max: 90,
                        defaultValue: "14",
                      },
                    ]}
                    submitLabel={t("signing.issue")}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
        {canWrite ? (
          <ActionForm
            action={createDocumentAction}
            hidden={{ org: ctx.org.slug, engagementId: e.id }}
            inline
            fields={[
              {
                name: "kind",
                label: t("fields.kind"),
                kind: "select",
                defaultValue: "Agreement",
                options: DOCUMENT_KINDS.map((k) => ({
                  value: k,
                  label: t(`documentKinds.${enumKey(k)}`),
                })),
              },
              { name: "title", label: t("fields.title"), kind: "text", required: true },
              { name: "expiresOn", label: t("fields.expiresOn"), kind: "date" },
            ]}
            submitLabel={t("engagements.addDocument")}
          />
        ) : null}
      </Section>
      <Section id="engagement-deliverables" title={t("engagements.deliverables")}>
        {must(deliverables, "deliverables").length === 0 ? (
          <Muted>{t("engagements.noDeliverables")}</Muted>
        ) : null}
        <ul className="m-0 flex list-none flex-col gap-8 p-0">
          {must(deliverables, "deliverables").map((d) => (
            <li
              key={d.id}
              className="flex flex-col gap-4 rounded-card border border-border-subtle p-8 text-text-13"
            >
              <div className="flex flex-wrap items-center justify-between gap-8">
                <span className="font-medium">{d.title ?? t("engagements.deliverable")}</span>
                <StateChip
                  state={deliverableIcon(d.state)}
                  label={t(`deliverableStates.${enumKey(d.state)}`)}
                  compact
                />
              </div>
              <p className="m-0 text-text-secondary">
                {t("engagements.milestoneFee", {
                  amount:
                    formatMoney(page.locale, d.feeMinor, resolved.currencyCode) ?? t("unpriced"),
                })}
              </p>
              {d.submissionMessage ? (
                <p className="m-0 text-text-secondary">{d.submissionMessage}</p>
              ) : null}
              {canWrite && d.state !== "Accepted" && resolved.currencyCode ? (
                <ActionForm
                  action={setDeliverableFeeAction}
                  hidden={{
                    org: ctx.org.slug,
                    deliverableId: d.id,
                    currencyCode: resolved.currencyCode,
                  }}
                  inline
                  fields={[
                    {
                      name: "fee",
                      label: t("engagements.milestoneFeeLabel", {
                        currency: resolved.currencyCode,
                      }),
                      kind: "text",
                    },
                  ]}
                  submitLabel={t("engagements.setFee")}
                />
              ) : null}
              {canWrite && d.state === "Submitted" ? (
                <ActionForm
                  action={decideDeliverableAction}
                  hidden={{ org: ctx.org.slug, deliverableId: d.id }}
                  inline
                  fields={[
                    {
                      name: "decision",
                      label: t("fields.decision"),
                      kind: "select",
                      defaultValue: "Approved",
                      options: [
                        { value: "Approved", label: t("engagements.accept") },
                        { value: "Rejected", label: t("engagements.return") },
                      ],
                    },
                    { name: "reason", label: t("engagements.returnReason"), kind: "text" },
                  ]}
                  submitLabel={t("engagements.decide")}
                />
              ) : null}
            </li>
          ))}
        </ul>
      </Section>
      <Section id="engagement-ratings" title={t("engagements.ratings")}>
        {e.state !== "Complete" ? <Muted>{t("engagements.ratingsAfterComplete")}</Muted> : null}
        {orgRating ? (
          <p className="m-0 text-text-13">
            {t("engagements.orgRated", { score: orgRating.score })}
          </p>
        ) : null}
        {partyRating ? (
          <div className="flex flex-col gap-4 text-text-13">
            <p className="m-0">{t("engagements.partyRated", { score: partyRating.score })}</p>
            {partyRating.comment ? (
              <p className="m-0 text-text-secondary">{partyRating.comment}</p>
            ) : null}
            {partyRating.reply ? (
              <p className="m-0">{t("engagements.replied", { reply: partyRating.reply })}</p>
            ) : null}
            {canRate && !partyRating.reply ? (
              <ActionForm
                action={replyAction}
                hidden={{ org: ctx.org.slug, ratingId: partyRating.id }}
                inline
                fields={[
                  { name: "body", label: t("engagements.reply"), kind: "text", required: true },
                ]}
                submitLabel={t("engagements.sendReply")}
              />
            ) : null}
          </div>
        ) : e.state === "Complete" && !e.ratingsReleased && e.partyRated ? (
          <Muted>{t("engagements.partyRatingHeld")}</Muted>
        ) : null}
        {canRate && e.state === "Complete" && !orgRating ? (
          <ActionForm
            action={rateAction}
            hidden={{ org: ctx.org.slug, engagementId: e.id }}
            title={t("engagements.rateTitle")}
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
              {
                name: "comment",
                label: t("fields.publicComment"),
                kind: "textarea",
                help: t("engagements.ratingHelp"),
              },
            ]}
            submitLabel={t("engagements.rate")}
            variant="primary"
          />
        ) : null}
      </Section>
      <Section id="engagement-reengage" title={t("engagements.reengagement")}>
        {canPool && poolOptions.length > 0 && (e.personId || e.accountId) ? (
          <ActionForm
            action={addPoolMemberAction}
            hidden={{
              org: ctx.org.slug,
              party: e.personId ? `person:${e.personId}` : `org:${e.accountId}`,
            }}
            inline
            fields={[
              {
                name: "poolId",
                label: t("fields.pool"),
                kind: "select",
                defaultValue: poolOptions[0]?.value ?? "",
                options: poolOptions,
              },
              {
                name: "standing",
                label: t("fields.standing"),
                kind: "select",
                defaultValue: "Preferred",
                options: (["Preferred", "Approved", "Do Not Engage"] as const).map((s) => ({
                  value: s,
                  label: t(`standings.${enumKey(s)}`),
                })),
              },
              { name: "reason", label: t("fields.standingReason"), kind: "text" },
              { name: "reviewOn", label: t("fields.reviewOn"), kind: "date" },
            ]}
            submitLabel={t("engagements.addToPool")}
          />
        ) : (
          <Muted>{canPool ? t("engagements.noPools") : t("engagements.poolNeedsWrite")}</Muted>
        )}
      </Section>
    </TemplateRecord>
  );
}
