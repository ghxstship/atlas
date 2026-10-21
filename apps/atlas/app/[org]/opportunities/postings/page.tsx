import { listProjects } from "@xos/data/projects";
import { resolveSettings } from "@xos/data/settings";
import { allowedVisibilities } from "@/lib/shell/org-settings";
import {
  getOpportunity,
  listOpportunities,
  listRequisitions,
  OPPORTUNITY_MOVES,
  RATE_TYPES,
  REQUISITION_ROLE_TYPES,
  ROLE_TYPES,
  VISIBILITIES,
  type OpportunityDetail,
  type OpportunitySummary,
} from "@xos/data/opportunities";
import type { Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm, type FieldSpec } from "@/components/opportunities/action-form";
import {
  Muted,
  Properties,
  RowLink,
  Section,
  Table,
  ViewSwitch,
} from "@/components/opportunities/parts";
import {
  Card,
  PageHeader,
  StateChip,
  Tag,
  TemplateCollection,
  TemplateRecord,
} from "@/components/opportunities/ui";
import { ButtonLink, EmptyStateLink } from "@/components/ui";
import { enumKey, formatPayRange, opportunityIcon } from "@/lib/opportunities/format";
import {
  knownParties,
  must,
  setupPage,
  type PageSetup,
  type SearchParams,
} from "@/lib/opportunities/page";
import { nodeHref } from "@/lib/shell/sitemap";
import {
  addInvitationAction,
  addPositionAction,
  addQuestionAction,
  addRequirementAction,
  createOpportunityAction,
  removeOpportunityChildAction,
  transitionOpportunityAction,
  updateOpportunityAction,
} from "../actions";

/**
 * Postings (Section 4.5.5 Opportunities, Section 4.4.3): every opportunity of the org in list, table or gallery view,
 * the record panel with positions, requirements, questions and invitations, and the lifecycle from Draft through
 * approval to Published, Paused, Filled, Closed or Canceled. Publishing is checked by the database: an Approved
 * requisition for Contractor, Crew and Staff, a pay range where the jurisdiction requires one, and the plan for Public.
 */
export default async function PostingsPage({
  params,
  searchParams,
}: PageProps<"/[org]/opportunities/postings">) {
  const routeParams = await params;
  const page = await setupPage(
    "opportunities.postings",
    routeParams,
    (await searchParams) as SearchParams,
  );
  const { ctx, t, param } = page;
  const canWrite = ctx.capabilities.has("opportunities.posting.write");
  const id = param("id");

  if (id) {
    const opportunity = await getOpportunity(ctx.viewer.db, id);
    if (!opportunity.ok) {
      if (opportunity.error.kind === "not-found") notFound();
      throw new Error(`Cannot read opportunity: ${JSON.stringify(opportunity.error)}`);
    }
    return (
      <PostingRecord
        page={page}
        opportunity={opportunity.data}
        canWrite={canWrite}
        params={routeParams}
      />
    );
  }

  const opportunities = must(await listOpportunities(ctx.viewer.db, ctx.org.id), "opportunities");
  const creating = param("create") === "1" && canWrite;

  return (
    <TemplateCollection
      header={
        <PageHeader
          title={t("postings.title")}
          count={opportunities.length}
          views={
            <ViewSwitch
              label={t("views.label")}
              views={page.views}
              current={page.view}
              hrefFor={(v) => page.href({ view: v, create: null })}
            />
          }
          actions={
            canWrite && !creating ? (
              <ButtonLink href={page.href({ create: "1" })} variant="primary">
                {t("postings.new")}
              </ButtonLink>
            ) : null
          }
        />
      }
    >
      {creating ? <CreatePosting page={page} /> : null}
      {opportunities.length === 0 && !creating ? (
        <EmptyStateLink
          icon="Megaphone"
          sentence={t("postings.empty")}
          actionLabel={canWrite ? t("postings.emptyAction") : t("postings.emptyRead")}
          href={
            canWrite
              ? page.href({ create: "1" })
              : (nodeHref("opportunities.requisitions", routeParams) ?? page.base)
          }
        />
      ) : (
        <PostingList page={page} rows={opportunities} />
      )}
    </TemplateCollection>
  );
}

function payLabel(page: PageSetup, o: OpportunitySummary): string {
  return (
    formatPayRange(page.locale, o.payMinMinor, o.payMaxMinor, o.currencyCode, (low, high) =>
      page.t("range", { low, high }),
    ) ?? page.t("rateOnRequest")
  );
}

function PostingList({ page, rows }: { page: PageSetup; rows: readonly OpportunitySummary[] }) {
  const { t } = page;
  const open = (o: OpportunitySummary) => page.href({ id: o.id, create: null });
  if (page.view === "table") {
    return (
      <Table
        caption={t("postings.title")}
        rowKey={(o) => o.id}
        rows={rows}
        columns={[
          {
            key: "title",
            label: t("fields.title"),
            cell: (o) => <RowLink href={open(o)}>{o.title}</RowLink>,
          },
          {
            key: "state",
            label: t("fields.state"),
            cell: (o) => (
              <StateChip
                state={opportunityIcon(o.state)}
                label={t(`opportunityStates.${enumKey(o.state)}`)}
                compact
              />
            ),
          },
          { key: "project", label: t("fields.project"), cell: (o) => o.projectKey },
          {
            key: "role",
            label: t("fields.roleType"),
            cell: (o) => t(`roleTypes.${enumKey(o.roleType)}`),
          },
          {
            key: "visibility",
            label: t("fields.visibility"),
            cell: (o) => t(`visibilities.${enumKey(o.visibility)}`),
          },
          { key: "pay", label: t("fields.pay"), cell: (o) => payLabel(page, o) },
          {
            key: "applications",
            label: t("fields.applications"),
            numeric: true,
            cell: (o) => o.applicationCount,
          },
        ]}
      />
    );
  }
  if (page.view === "gallery") {
    return (
      <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-12 p-0">
        {rows.map((o) => (
          <li key={o.id}>
            <Link href={open(o) as Route} className="block rounded-card focus-visible:outline-2">
              <Card
                title={o.title}
                interactive
                meta={
                  <StateChip
                    state={opportunityIcon(o.state)}
                    label={t(`opportunityStates.${enumKey(o.state)}`)}
                    compact
                  />
                }
              >
                <p className="m-0 text-text-13 text-text-secondary">
                  {o.projectKey} · {t(`roleTypes.${enumKey(o.roleType)}`)} ·{" "}
                  {t(`visibilities.${enumKey(o.visibility)}`)}
                </p>
                <p className="m-0 text-text-13">{payLabel(page, o)}</p>
                <p className="m-0 text-text-12 text-text-secondary">
                  {t("postings.counts", {
                    positions: o.positionCount,
                    applications: o.applicationCount,
                  })}
                </p>
              </Card>
            </Link>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle rounded-card border border-border-subtle p-0">
      {rows.map((o) => (
        <li
          key={o.id}
          className="flex flex-wrap items-center justify-between gap-8 px-12 py-8 hover:bg-bg-hover"
        >
          <div className="flex min-w-0 flex-col gap-2">
            <RowLink href={open(o)}>{o.title}</RowLink>
            <span className="text-text-12 text-text-secondary">
              {o.projectKey} · {t(`roleTypes.${enumKey(o.roleType)}`)} · {payLabel(page, o)}
            </span>
          </div>
          <div className="flex items-center gap-8">
            <span className="text-text-12 text-text-secondary">
              {t("postings.applicationsCount", { count: o.applicationCount })}
            </span>
            <StateChip
              state={opportunityIcon(o.state)}
              label={t(`opportunityStates.${enumKey(o.state)}`)}
              compact
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

async function CreatePosting({ page }: { page: PageSetup }) {
  const { ctx, t, param } = page;
  const [projects, requisitions] = await Promise.all([
    listProjects(ctx.viewer.db, ctx.org.id),
    listRequisitions(ctx.viewer.db, ctx.org.id),
  ]);
  const approved = must(requisitions, "requisitions").filter((r) => r.state === "Approved");
  const fromRequisition = approved.find((r) => r.id === param("requisition"));
  // gateway.marketplace_visibility caps how widely a posting reaches (1327).
  const marketplace = await resolveSettings(ctx.viewer.db, { orgId: ctx.org.id });
  const visibilities = allowedVisibilities(
    (key) => (marketplace.ok ? marketplace.data.get(key)?.value : undefined),
    VISIBILITIES,
  );
  const fields: FieldSpec[] = [
    {
      name: "projectId",
      label: t("fields.project"),
      kind: "select",
      defaultValue: fromRequisition?.projectId ?? "",
      options: must(projects, "projects").map((p) => ({
        value: p.id,
        label: `${p.key} · ${p.name}`,
      })),
    },
    {
      name: "requisitionId",
      label: t("fields.requisition"),
      kind: "select",
      defaultValue: fromRequisition?.id ?? "",
      help: t("postings.requisitionHelp", {
        types: REQUISITION_ROLE_TYPES.map((r) => t(`roleTypes.${enumKey(r)}`)).join(", "),
      }),
      options: [
        { value: "", label: t("postings.noRequisition") },
        ...approved.map((r) => ({
          value: r.id,
          label: `${r.projectKey} · ${r.jobTitle ?? r.roleCode} (${r.roleCode}) · ${r.headcount}`,
        })),
      ],
    },
    {
      name: "title",
      label: t("fields.title"),
      kind: "text",
      required: true,
      defaultValue: fromRequisition?.jobTitle ?? "",
      help: t("postings.titleHelp"),
    },
    {
      name: "roleType",
      label: t("fields.roleType"),
      kind: "select",
      defaultValue: fromRequisition?.roleType ?? "Crew",
      options: ROLE_TYPES.map((r) => ({ value: r, label: t(`roleTypes.${enumKey(r)}`) })),
    },
    {
      name: "roleCode",
      label: t("fields.roleCode"),
      kind: "text",
      defaultValue: fromRequisition?.roleCode ?? "",
      help: t("postings.roleCodeHelp"),
    },
    {
      name: "visibility",
      label: t("fields.visibility"),
      kind: "select",
      defaultValue: "Invited",
      help: t("postings.visibilityHelp"),
      options: visibilities.map((v) => ({ value: v, label: t(`visibilities.${enumKey(v)}`) })),
    },
    {
      name: "rateType",
      label: t("fields.rateType"),
      kind: "select",
      defaultValue: "",
      options: [
        { value: "", label: t("rateOnRequest") },
        ...RATE_TYPES.map((r) => ({ value: r, label: t(`rateTypes.${enumKey(r)}`) })),
      ],
    },
    { name: "payMin", label: t("fields.payMin"), kind: "text", help: t("postings.payHelp") },
    { name: "payMax", label: t("fields.payMax"), kind: "text" },
    { name: "isRemote", label: t("fields.isRemote"), kind: "checkbox" },
    {
      name: "currencyCode",
      label: t("fields.currency"),
      kind: "text",
      defaultValue: fromRequisition?.currencyCode ?? "USD",
    },
    {
      name: "startsOn",
      label: t("fields.startsOn"),
      kind: "date",
      defaultValue: fromRequisition?.startsOn ?? "",
    },
    {
      name: "endsOn",
      label: t("fields.endsOn"),
      kind: "date",
      defaultValue: fromRequisition?.endsOn ?? "",
    },
    { name: "deadlineAt", label: t("fields.deadline"), kind: "datetime-local" },
    { name: "description", label: t("fields.description"), kind: "textarea" },
  ];
  return (
    <Card title={t("postings.createTitle")}>
      <ActionForm
        action={createOpportunityAction}
        hidden={{ org: ctx.org.slug }}
        fields={fields}
        submitLabel={t("postings.create")}
        variant="primary"
        successLabel={t("postings.created")}
      />
    </Card>
  );
}

async function PostingRecord({
  page,
  opportunity: o,
  canWrite,
  params,
}: {
  page: PageSetup;
  opportunity: OpportunityDetail;
  canWrite: boolean;
  params: Readonly<Record<string, string>>;
}) {
  const { ctx, t } = page;
  const hidden = { org: ctx.org.slug, opportunityId: o.id };
  const draft = o.state === "Draft" || o.state === "Pending Approval";
  const parties = canWrite ? await knownParties(ctx) : [];
  const moves = OPPORTUNITY_MOVES[o.state].filter(
    (m) => m !== "Published" || ctx.capabilities.has("opportunities.posting.publish"),
  );
  const pipeline = nodeHref("opportunities.pipeline", params);
  return (
    <TemplateRecord
      propertiesLabel={t("record.properties")}
      header={
        <header className="flex flex-col gap-8 border-b border-border-subtle pb-12">
          <Link
            href={page.href({ id: null }) as Route}
            className="text-text-12 text-text-secondary hover:text-text-primary"
          >
            {t("postings.back")}
          </Link>
          <div className="flex flex-wrap items-center gap-8">
            <h1 className="m-0 text-heading-20 font-semibold">{o.title}</h1>
            <StateChip
              state={opportunityIcon(o.state)}
              label={t(`opportunityStates.${enumKey(o.state)}`)}
            />
            <Tag tone="neutral">{t(`visibilities.${enumKey(o.visibility)}`)}</Tag>
          </div>
        </header>
      }
      properties={
        <div className="flex flex-col gap-16">
          <Properties
            label={t("record.properties")}
            items={[
              { label: t("fields.project"), value: `${o.projectKey} · ${o.projectName}` },
              { label: t("fields.roleType"), value: t(`roleTypes.${enumKey(o.roleType)}`) },
              {
                label: t("fields.roleCode"),
                value: o.roleCode ? (
                  <span className="font-mono text-text-12">{o.roleCode}</span>
                ) : (
                  t("none")
                ),
              },
              { label: t("fields.pay"), value: payLabel(page, o) },
              {
                label: t("fields.rateType"),
                value: o.rateType ? t(`rateTypes.${enumKey(o.rateType)}`) : t("rateOnRequest"),
              },
              {
                label: t("fields.dates"),
                value: o.startsOn
                  ? t("dateRange", { start: o.startsOn, end: o.endsOn ?? o.startsOn })
                  : t("none"),
              },
              {
                label: t("fields.deadline"),
                value: o.deadlineAt
                  ? new Date(o.deadlineAt).toLocaleString(page.locale)
                  : t("none"),
              },
              {
                label: t("fields.requisition"),
                value: o.requisitionId
                  ? t("postings.fromRequisition")
                  : t("postings.noRequisition"),
              },
              {
                label: t("fields.applications"),
                value: pipeline ? (
                  <RowLink href={`${pipeline}?opportunity=${o.id}`}>
                    {t("postings.applicationsCount", { count: o.applicationCount })}
                  </RowLink>
                ) : (
                  o.applicationCount
                ),
              },
            ]}
          />
          {canWrite && moves.length > 0 ? (
            <ActionForm
              action={transitionOpportunityAction}
              hidden={{ ...hidden, expected: o.state }}
              title={t("transitions.title")}
              fields={[
                {
                  name: "next",
                  label: t("transitions.next"),
                  kind: "select",
                  defaultValue: moves[0] ?? "",
                  options: moves.map((m) => ({
                    value: m,
                    label: t(`opportunityMoves.${enumKey(m)}`),
                  })),
                },
                { name: "reason", label: t("transitions.reason"), kind: "text", required: true },
              ]}
              submitLabel={t("transitions.submit")}
              variant="primary"
              successLabel={t("transitions.done")}
            />
          ) : null}
        </div>
      }
    >
      <Section id="posting-description" title={t("fields.description")}>
        {o.description ? (
          <p className="m-0 whitespace-pre-wrap text-text-14">{o.description}</p>
        ) : (
          <Muted>{t("postings.noDescription")}</Muted>
        )}
        {canWrite && draft ? (
          <ActionForm
            action={updateOpportunityAction}
            hidden={hidden}
            title={t("postings.edit")}
            fields={[
              {
                name: "title",
                label: t("fields.title"),
                kind: "text",
                required: true,
                defaultValue: o.title,
              },
              {
                name: "startsOn",
                label: t("fields.startsOn"),
                kind: "date",
                defaultValue: o.startsOn ?? "",
              },
              {
                name: "endsOn",
                label: t("fields.endsOn"),
                kind: "date",
                defaultValue: o.endsOn ?? "",
              },
              {
                name: "deadlineAt",
                label: t("fields.deadline"),
                kind: "datetime-local",
                defaultValue: o.deadlineAt ? o.deadlineAt.slice(0, 16) : "",
              },
              {
                name: "description",
                label: t("fields.description"),
                kind: "textarea",
                defaultValue: o.description ?? "",
              },
            ]}
            submitLabel={t("save")}
          />
        ) : null}
      </Section>
      <Section
        id="posting-positions"
        title={t("postings.positions", { count: o.positions.length })}
      >
        {o.positions.length === 0 ? <Muted>{t("postings.noPositions")}</Muted> : null}
        <ul className="m-0 flex list-none flex-col gap-4 p-0">
          {o.positions.map((p) => (
            <li
              key={p.id}
              className="flex flex-wrap items-center justify-between gap-8 text-text-13"
            >
              <span>
                {p.label}
                {p.callAt
                  ? ` · ${t("postings.callAt", { time: new Date(p.callAt).toLocaleString(page.locale) })}`
                  : ""}
              </span>
              {canWrite ? (
                <ActionForm
                  action={removeOpportunityChildAction}
                  hidden={{ org: ctx.org.slug, table: "opportunity_positions", id: p.id }}
                  fields={[]}
                  submitLabel={t("remove")}
                  inline
                />
              ) : null}
            </li>
          ))}
        </ul>
        {canWrite ? (
          <ActionForm
            action={addPositionAction}
            hidden={hidden}
            inline
            fields={[
              { name: "label", label: t("fields.positionLabel"), kind: "text", required: true },
              { name: "callAt", label: t("fields.callAt"), kind: "datetime-local" },
            ]}
            submitLabel={t("postings.addPosition")}
          />
        ) : null}
      </Section>
      <Section id="posting-requirements" title={t("postings.requirements")}>
        {o.requirements.length === 0 ? <Muted>{t("postings.noRequirements")}</Muted> : null}
        <ul className="m-0 flex list-none flex-col gap-4 p-0">
          {o.requirements.map((r) => (
            <li
              key={r.id}
              className="flex flex-wrap items-center justify-between gap-8 text-text-13"
            >
              <span>
                <Tag tone="neutral">{t(`requirementKinds.${enumKey(r.kind)}`)}</Tag> {r.description}
              </span>
              {canWrite && draft ? (
                <ActionForm
                  action={removeOpportunityChildAction}
                  hidden={{ org: ctx.org.slug, table: "opportunity_requirements", id: r.id }}
                  fields={[]}
                  submitLabel={t("remove")}
                  inline
                />
              ) : null}
            </li>
          ))}
        </ul>
        {canWrite && draft ? (
          <ActionForm
            action={addRequirementAction}
            hidden={hidden}
            inline
            fields={[
              {
                name: "kind",
                label: t("fields.requirementKind"),
                kind: "select",
                defaultValue: "Equipment",
                options: (["Equipment", "Insurance"] as const).map((k) => ({
                  value: k,
                  label: t(`requirementKinds.${enumKey(k)}`),
                })),
              },
              { name: "description", label: t("fields.requirement"), kind: "text", required: true },
              { name: "minimum", label: t("fields.insuranceMinimum"), kind: "text" },
              {
                name: "currencyCode",
                label: t("fields.currency"),
                kind: "text",
                defaultValue: "USD",
              },
            ]}
            submitLabel={t("postings.addRequirement")}
          />
        ) : null}
      </Section>
      <Section id="posting-questions" title={t("postings.questions")}>
        {o.questions.length === 0 ? <Muted>{t("postings.noQuestions")}</Muted> : null}
        <ol className="m-0 flex flex-col gap-4 ps-20 text-text-13">
          {o.questions.map((q) => (
            <li key={q.id}>
              {q.prompt} {q.required ? <Tag tone="accent">{t("postings.required")}</Tag> : null}
            </li>
          ))}
        </ol>
        {canWrite && draft ? (
          <ActionForm
            action={addQuestionAction}
            hidden={hidden}
            inline
            fields={[
              {
                name: "prompt",
                label: t("fields.question"),
                kind: "text",
                required: true,
                help: t("postings.questionHelp"),
              },
              {
                name: "sortOrder",
                label: t("fields.order"),
                kind: "number",
                defaultValue: String(o.questions.length + 1),
                min: 1,
              },
              { name: "required", label: t("postings.required"), kind: "checkbox" },
            ]}
            submitLabel={t("postings.addQuestion")}
          />
        ) : null}
      </Section>
      <Section
        id="posting-invitations"
        title={t("postings.invitations", { count: o.invitations.length })}
      >
        {o.invitations.length === 0 ? (
          <Muted>
            {o.visibility === "Invited"
              ? t("postings.noInvitationsInvited")
              : t("postings.noInvitations")}
          </Muted>
        ) : null}
        <ul className="m-0 flex list-none flex-col gap-4 p-0">
          {o.invitations.map((i) => {
            const key = i.personId ? `person:${i.personId}` : `org:${i.organizationId}`;
            return (
              <li
                key={i.id}
                className="flex flex-wrap items-center justify-between gap-8 text-text-13"
              >
                <span>
                  {parties.find((p) => p.value === key)?.label ?? t("postings.invitedParty")}
                </span>
                {canWrite ? (
                  <ActionForm
                    action={removeOpportunityChildAction}
                    hidden={{ org: ctx.org.slug, table: "opportunity_invitations", id: i.id }}
                    fields={[]}
                    submitLabel={t("remove")}
                    inline
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
        {canWrite && parties.length > 0 ? (
          <ActionForm
            action={addInvitationAction}
            hidden={hidden}
            inline
            fields={[
              {
                name: "party",
                label: t("fields.party"),
                kind: "select",
                defaultValue: parties[0]?.value ?? "",
                options: parties,
              },
            ]}
            submitLabel={t("postings.invite")}
          />
        ) : canWrite ? (
          <Muted>{t("postings.noKnownParties")}</Muted>
        ) : null}
      </Section>
    </TemplateRecord>
  );
}
