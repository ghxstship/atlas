import {
  listEngagements,
  listOnboardingRequirements,
  listOnboardingStatus,
  ONBOARDING_ITEM_KINDS,
  ROLE_TYPES,
  type EngagementCard,
  type OnboardingRequirement,
  type OnboardingStatus,
} from "@xos/data/opportunities";
import {
  listBatches,
  listTemplates,
  type AgreementBatch,
  type AgreementTemplate,
} from "@xos/data/engagement-document-batches";
import { ActionForm } from "@/components/opportunities/action-form";
import { AgreementTemplateForm } from "@/components/opportunities/agreement-template-form";
import { Muted, RowLink, Section, Table, ViewSwitch } from "@/components/opportunities/parts";
import { Card, PageHeader, Tag, TemplateCollection } from "@/components/opportunities/ui";
import { ButtonLink, EmptyStateLink } from "@/components/ui";
import { enumKey } from "@/lib/opportunities/format";
import { must, setupPage, type PageSetup, type SearchParams } from "@/lib/opportunities/page";
import { nodeHref } from "@/lib/shell/sitemap";
import { createRequirementAction, verifyItemAction } from "../actions";
import * as enums from "@xos/data/enums";
import {
  countersignAgreementBatchAction,
  duplicateAgreementTemplateAction,
  removeAgreementTemplateAction,
  sendAgreementBatchAction,
} from "../agreements-actions";

/**
 * Onboarding (Section 4.4.4 stage 6): the onboarding packet requirements per role type and jurisdiction, and every open
 * item across the org's engagements to verify. An engagement becomes Active only when every blocking requirement that
 * applies passes or carries over (database-enforced, migration 0730); the reviewer is never the engaged party. Agreement
 * templates and batches (B10) sit here too: every action in them is secondary, so the header's primary stays the only one.
 */
export default async function OnboardingPage({
  params,
  searchParams,
}: PageProps<"/[org]/opportunities/onboarding">) {
  const routeParams = await params;
  const page = await setupPage(
    "opportunities.onboarding",
    routeParams,
    (await searchParams) as SearchParams,
  );
  const { ctx, t, param } = page;
  const db = ctx.viewer.db;
  const [requirements, items, engagements, templates, batches] = await Promise.all([
    listOnboardingRequirements(db, ctx.org.id),
    listOnboardingStatus(db, { orgId: ctx.org.id }),
    listEngagements(db, ctx.org.id, { states: ["Onboarding", "Blocked", "Active", "Closing"] }),
    listTemplates(db, ctx.org.id),
    listBatches(db, { orgId: ctx.org.id }),
  ]);
  const reqs = must(requirements, "requirements");
  const byEngagement = new Map(must(engagements, "engagements").map((e) => [e.id, e]));
  const open = must(items, "onboarding items").filter(
    (i) => !i.passes && !i.carriedOver && byEngagement.has(i.engagementId),
  );
  const canWrite = ctx.capabilities.has("opportunities.onboarding.write");
  const creating = param("create") === "1" && canWrite;
  const engagementsHref = nodeHref("opportunities.engagements", routeParams) ?? page.base;
  return (
    <TemplateCollection
      header={
        <PageHeader
          title={t("onboarding.title")}
          count={open.length}
          views={
            <ViewSwitch
              label={t("views.label")}
              views={page.views}
              current={page.view}
              hrefFor={(v) => page.href({ view: v })}
            />
          }
          actions={
            canWrite && !creating ? (
              <ButtonLink href={page.href({ create: "1" })} variant="primary">
                {t("onboarding.newRequirement")}
              </ButtonLink>
            ) : null
          }
        />
      }
    >
      {creating ? (
        <Card title={t("onboarding.createTitle")}>
          <ActionForm
            action={createRequirementAction}
            hidden={{ org: ctx.org.slug }}
            fields={[
              {
                name: "name",
                label: t("fields.name"),
                kind: "text",
                required: true,
                help: t("onboarding.nameHelp"),
              },
              {
                name: "kind",
                label: t("fields.kind"),
                kind: "select",
                defaultValue: "Document Upload",
                options: ONBOARDING_ITEM_KINDS.map((k) => ({
                  value: k,
                  label: t(`itemKinds.${enumKey(k)}`),
                })),
              },
              {
                name: "roleType",
                label: t("fields.roleType"),
                kind: "select",
                defaultValue: "",
                options: [
                  { value: "", label: t("onboarding.everyRole") },
                  ...ROLE_TYPES.map((r) => ({ value: r, label: t(`roleTypes.${enumKey(r)}`) })),
                ],
              },
              {
                name: "method",
                label: t("fields.method"),
                kind: "select",
                defaultValue: "Reviewer",
                options: enums.verificationMethod.map((m) => ({
                  value: m,
                  label: t(`methods.${enumKey(m)}`),
                })),
              },
              {
                name: "blocking",
                label: t("onboarding.blockingLabel"),
                kind: "checkbox",
                defaultValue: "true",
              },
              {
                name: "validForDays",
                label: t("fields.validDays"),
                kind: "number",
                min: 1,
                help: t("onboarding.validHelp"),
              },
            ]}
            submitLabel={t("onboarding.create")}
            variant="primary"
            successLabel={t("onboarding.created")}
          />
        </Card>
      ) : null}
      <AgreementSections
        page={page}
        templates={must(templates, "agreement templates")}
        batches={must(batches, "agreement batches")}
      />
      <Section id="onboarding-queue" title={t("onboarding.queue")}>
        {open.length === 0 ? (
          <EmptyStateLink
            icon="ClipboardCheck"
            sentence={t("onboarding.queueEmpty")}
            actionLabel={t("onboarding.queueEmptyAction")}
            href={engagementsHref}
          />
        ) : page.view === "board" ? (
          <QueueBoard
            page={page}
            items={open}
            engagements={byEngagement}
            engagementsHref={engagementsHref}
            canWrite={canWrite}
          />
        ) : page.view === "table" ? (
          <Table
            caption={t("onboarding.queue")}
            rowKey={(i: OnboardingStatus) => i.itemId}
            rows={open}
            columns={[
              {
                key: "party",
                label: t("fields.party"),
                cell: (i: OnboardingStatus) => (
                  <RowLink href={`${engagementsHref}?id=${i.engagementId}`}>
                    {byEngagement.get(i.engagementId)?.partyName ?? t("engagements.unnamed")}
                  </RowLink>
                ),
              },
              { key: "item", label: t("fields.item"), cell: (i: OnboardingStatus) => i.name },
              {
                key: "status",
                label: t("fields.state"),
                cell: (i: OnboardingStatus) => statusLabel(page, i),
              },
              {
                key: "blocking",
                label: t("onboarding.blocking"),
                cell: (i: OnboardingStatus) => (i.blocking ? t("yes") : t("no")),
              },
            ]}
          />
        ) : (
          <ul className="m-0 flex list-none flex-col gap-8 p-0">
            {open.map((i) => (
              <QueueItem
                key={i.itemId}
                page={page}
                item={i}
                engagement={byEngagement.get(i.engagementId)}
                engagementsHref={engagementsHref}
                canWrite={canWrite}
              />
            ))}
          </ul>
        )}
      </Section>
      <Section
        id="onboarding-requirements"
        title={t("onboarding.requirements", { count: reqs.length })}
      >
        {reqs.length === 0 ? <Muted>{t("onboarding.noRequirements")}</Muted> : null}
        <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle rounded-card border border-border-subtle p-0">
          {reqs.map((r: OnboardingRequirement) => (
            <li
              key={r.id}
              className="flex flex-wrap items-center justify-between gap-8 px-12 py-8 text-text-13"
            >
              <span className="font-medium">{r.name}</span>
              <span className="flex flex-wrap gap-4">
                <Tag tone="neutral">{t(`itemKinds.${enumKey(r.kind)}`)}</Tag>
                <Tag tone="neutral">
                  {r.roleType ? t(`roleTypes.${enumKey(r.roleType)}`) : t("onboarding.everyRole")}
                </Tag>
                {r.blocking ? <Tag tone="warning">{t("onboarding.blocking")}</Tag> : null}
                {r.validForDays ? (
                  <Tag tone="neutral">{t("onboarding.validFor", { days: r.validForDays })}</Tag>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      </Section>
    </TemplateCollection>
  );
}

function statusLabel(page: PageSetup, i: OnboardingStatus): string {
  const { t } = page;
  if (i.latestOutcome === "Failed") return t("onboarding.failed");
  return i.submittedAt ? t("onboarding.toReview") : t("onboarding.awaitingParty");
}

function QueueItem({
  page,
  item: i,
  engagement,
  engagementsHref,
  canWrite,
}: {
  page: PageSetup;
  item: OnboardingStatus;
  engagement: EngagementCard | undefined;
  engagementsHref: string;
  canWrite: boolean;
}) {
  const { ctx, t } = page;
  return (
    <li className="flex flex-col gap-8 rounded-card border border-border-subtle p-8 text-text-13">
      <div className="flex flex-wrap items-center justify-between gap-8">
        <span>
          <RowLink href={`${engagementsHref}?id=${i.engagementId}`}>
            {engagement?.partyName ?? t("engagements.unnamed")}
          </RowLink>
          <span className="text-text-secondary"> · {i.name}</span>
        </span>
        <span className="flex gap-4">
          {i.blocking ? <Tag tone="warning">{t("onboarding.blocking")}</Tag> : null}
          <Tag tone={i.latestOutcome === "Failed" ? "danger" : "neutral"}>
            {statusLabel(page, i)}
          </Tag>
        </span>
      </div>
      {canWrite && i.method === "Reviewer" ? (
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
              options: enums.verificationOutcome.map((o) => ({
                value: o,
                label: t(`outcomes.${enumKey(o)}`),
              })),
            },
            { name: "note", label: t("fields.internalNote"), kind: "text" },
          ]}
          submitLabel={t("onboarding.verify")}
        />
      ) : i.method === "Automatic" ? (
        <Muted>{t("onboarding.automatic")}</Muted>
      ) : null}
    </li>
  );
}

function AgreementSections({
  page,
  templates,
  batches,
}: {
  page: PageSetup;
  templates: readonly AgreementTemplate[];
  batches: readonly AgreementBatch[];
}) {
  const { ctx, t, param } = page;
  const canEdit = ctx.capabilities.has("opportunities.engagement.write");
  const hidden = { org: ctx.org.slug };
  const used = new Set(batches.map((b) => b.templateId));
  const editing = templates.find((x) => x.id === param("template")) ?? null;
  const editable = editing && !used.has(editing.id) ? editing : null;
  const adding = param("template") === "new";
  return (
    <>
      <Section id="agreement-templates" title={t("agreementTemplates.title")}>
        {templates.length === 0 ? <Muted>{t("agreementTemplates.empty")}</Muted> : null}
        <ul className="m-0 flex list-none flex-col gap-8 p-0">
          {templates.map((x) => (
            <li
              key={x.id}
              className="flex flex-wrap items-center justify-between gap-8 rounded-card border border-border-subtle p-8 text-text-13"
            >
              <span className="flex flex-wrap items-center gap-8">
                <span className="font-medium">{x.name}</span>
                <Tag tone="neutral">{t(`agreementTemplates.kinds.${enumKey(x.kind)}`)}</Tag>
                <Tag tone="neutral">{t(`agreementTemplates.languages.${enumKey(x.locale)}`)}</Tag>
                {x.usesRate ? <Tag tone="warning">{t("agreementTemplates.usesRate")}</Tag> : null}
              </span>
              {canEdit ? (
                <span className="flex flex-wrap items-center gap-8">
                  {used.has(x.id) ? null : (
                    <ButtonLink href={page.href({ template: x.id })}>
                      {t("agreementTemplates.edit")}
                    </ButtonLink>
                  )}
                  <ActionForm
                    action={duplicateAgreementTemplateAction}
                    hidden={{ ...hidden, id: x.id, name: x.name }}
                    fields={[]}
                    inline
                    submitLabel={t("agreementTemplates.duplicate")}
                  />
                  <ActionForm
                    action={removeAgreementTemplateAction}
                    hidden={{ ...hidden, id: x.id }}
                    fields={[]}
                    inline
                    variant="danger"
                    submitLabel={t("remove")}
                  />
                </span>
              ) : null}
            </li>
          ))}
        </ul>
        {canEdit && !adding && !editable ? (
          <div>
            <ButtonLink href={page.href({ template: "new" })}>
              {t("agreementTemplates.new")}
            </ButtonLink>
          </div>
        ) : null}
        {canEdit && adding ? <AgreementTemplateForm org={ctx.org.slug} /> : null}
        {canEdit && editable ? (
          <AgreementTemplateForm key={editable.id} org={ctx.org.slug} template={editable} />
        ) : null}
      </Section>
      <Section id="agreement-batches" title={t("agreementBatches.title")}>
        {batches.length === 0 ? <Muted>{t("agreementBatches.empty")}</Muted> : null}
        <ul className="m-0 flex list-none flex-col gap-8 p-0">
          {batches.map((b) => (
            <li
              key={b.id}
              className="flex flex-col gap-8 rounded-card border border-border-subtle p-8 text-text-13"
            >
              <div className="flex flex-wrap items-center justify-between gap-8">
                <span className="font-medium">
                  {t("agreementBatches.line", {
                    project: b.projectName ?? "",
                    template: b.templateName ?? "",
                  })}
                </span>
                <span className="flex flex-wrap gap-4">
                  {Object.entries(b.counts).map(([state, count]) => (
                    <Tag key={state} tone="neutral">
                      {t("agreementBatches.count", {
                        state: t(`agreementBatches.states.${enumKey(state)}`),
                        count,
                      })}
                    </Tag>
                  ))}
                </span>
              </div>
              {canEdit ? (
                <div className="flex flex-wrap gap-8">
                  {(b.counts.Proposed ?? 0) > 0 ? (
                    <ActionForm
                      action={sendAgreementBatchAction}
                      hidden={{ ...hidden, batchId: b.id }}
                      fields={[]}
                      inline
                      submitLabel={t("agreementBatches.send")}
                    />
                  ) : null}
                  {(b.counts.Signed ?? 0) > 0 ? (
                    <ActionForm
                      action={countersignAgreementBatchAction}
                      hidden={{ ...hidden, batchId: b.id }}
                      fields={[]}
                      inline
                      submitLabel={t("agreementBatches.countersign")}
                    />
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}

function QueueBoard({
  page,
  items,
  engagements,
  engagementsHref,
  canWrite,
}: {
  page: PageSetup;
  items: readonly OnboardingStatus[];
  engagements: ReadonlyMap<string, EngagementCard>;
  engagementsHref: string;
  canWrite: boolean;
}) {
  const { t } = page;
  const columns = [
    {
      id: "awaiting",
      label: t("onboarding.awaitingParty"),
      match: (i: OnboardingStatus) => !i.submittedAt && i.latestOutcome !== "Failed",
    },
    {
      id: "review",
      label: t("onboarding.toReview"),
      match: (i: OnboardingStatus) => Boolean(i.submittedAt) && i.latestOutcome !== "Failed",
    },
    {
      id: "failed",
      label: t("onboarding.failed"),
      match: (i: OnboardingStatus) => i.latestOutcome === "Failed",
    },
  ];
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(16rem,1fr))] gap-12">
      {columns.map((c) => {
        const cards = items.filter(c.match);
        return (
          <section
            key={c.id}
            aria-label={c.label}
            className="flex flex-col gap-8 rounded-card bg-bg-surface p-8"
          >
            <h3 className="m-0 flex items-center justify-between text-label-13 font-semibold">
              {c.label} <span className="tabular-nums text-text-secondary">{cards.length}</span>
            </h3>
            {cards.length === 0 ? <Muted>{t("board.emptyColumn")}</Muted> : null}
            <ul className="m-0 flex list-none flex-col gap-8 p-0">
              {cards.map((i) => (
                <QueueItem
                  key={i.itemId}
                  page={page}
                  item={i}
                  engagement={engagements.get(i.engagementId)}
                  engagementsHref={engagementsHref}
                  canWrite={canWrite}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
