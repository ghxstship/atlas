import {
  listPoolMembers,
  listPools,
  type PoolMember,
  type TalentPool,
} from "@xos/data/opportunities";
import type { Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm, type FieldSpec } from "@/components/opportunities/action-form";
import { Muted, RowLink, Section, Table, ViewSwitch } from "@/components/opportunities/parts";
import {
  Card,
  InlineAlert,
  PageHeader,
  Tag,
  TemplateCollection,
} from "@/components/opportunities/ui";
import { ButtonLink, EmptyStateLink } from "@/components/ui";
import { enumKey } from "@/lib/opportunities/format";
import {
  knownParties,
  must,
  setupPage,
  type PageSetup,
  type SearchParams,
} from "@/lib/opportunities/page";
import {
  addPoolMemberAction,
  createPoolAction,
  removePoolMemberAction,
  setStandingAction,
} from "../actions";
import * as enums from "@xos/data/enums";

/**
 * Pools (Section 4.4.3, Section 4.4.4 stage 9 re-engagement): the org's talent and vendor pools with Preferred and
 * Approved members, who may see Pool opportunities early, and the internal Do Not Engage flag, which needs a reason and
 * a review date and never reaches any external surface.
 */
export default async function PoolsPage({
  params,
  searchParams,
}: PageProps<"/[org]/opportunities/pools">) {
  const routeParams = await params;
  const page = await setupPage(
    "opportunities.pools",
    routeParams,
    (await searchParams) as SearchParams,
  );
  const { ctx, t, param } = page;
  const canWrite = ctx.capabilities.has("opportunities.pool.write");
  const pools = must(await listPools(ctx.viewer.db, ctx.org.id), "pools");
  const poolId = param("pool");
  if (poolId) {
    const pool = pools.find((p) => p.id === poolId);
    if (!pool) notFound();
    return <PoolRecord page={page} pool={pool} canWrite={canWrite} />;
  }
  const creating = param("create") === "1" && canWrite;
  return (
    <TemplateCollection
      header={
        <PageHeader
          title={t("pools.title")}
          count={pools.length}
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
                {t("pools.new")}
              </ButtonLink>
            ) : null
          }
        />
      }
    >
      {creating ? (
        <Card title={t("pools.createTitle")}>
          <ActionForm
            action={createPoolAction}
            hidden={{ org: ctx.org.slug }}
            fields={[
              { name: "name", label: t("fields.name"), kind: "text", required: true },
              {
                name: "kind",
                label: t("fields.kind"),
                kind: "select",
                defaultValue: "Talent",
                options: enums.poolKind.map((k) => ({
                  value: k,
                  label: t(`poolKinds.${enumKey(k)}`),
                })),
              },
            ]}
            submitLabel={t("pools.create")}
            variant="primary"
            successLabel={t("pools.created")}
          />
        </Card>
      ) : null}
      {pools.length === 0 && !creating ? (
        <EmptyStateLink
          icon="Users"
          sentence={t("pools.empty")}
          actionLabel={canWrite ? t("pools.emptyAction") : t("pools.emptyRead")}
          href={page.href({ create: "1" })}
        />
      ) : page.view === "table" ? (
        <Table
          caption={t("pools.title")}
          rowKey={(p) => p.id}
          rows={pools}
          columns={[
            {
              key: "name",
              label: t("fields.name"),
              cell: (p: TalentPool) => <RowLink href={page.href({ pool: p.id })}>{p.name}</RowLink>,
            },
            {
              key: "kind",
              label: t("fields.kind"),
              cell: (p: TalentPool) => t(`poolKinds.${enumKey(p.kind)}`),
            },
            {
              key: "members",
              label: t("fields.members"),
              numeric: true,
              cell: (p: TalentPool) => p.memberCount,
            },
          ]}
        />
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle rounded-card border border-border-subtle p-0">
          {pools.map((p) => (
            <li
              key={p.id}
              className="flex items-center justify-between gap-8 px-12 py-8 hover:bg-bg-hover"
            >
              <RowLink href={page.href({ pool: p.id })}>{p.name}</RowLink>
              <span className="text-text-12 text-text-secondary">
                {t(`poolKinds.${enumKey(p.kind)}`)} ·{" "}
                {t("pools.memberCount", { count: p.memberCount })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </TemplateCollection>
  );
}

function standingFields(page: PageSetup, member?: PoolMember): FieldSpec[] {
  const { t } = page;
  return [
    {
      name: "standing",
      label: t("fields.standing"),
      kind: "select",
      defaultValue: member?.standing ?? "Approved",
      options: enums.poolStanding.map((s) => ({
        value: s,
        label: t(`standings.${enumKey(s)}`),
      })),
    },
    {
      name: "reason",
      label: t("fields.standingReason"),
      kind: "text",
      defaultValue: member?.reason ?? "",
      help: t("pools.dneHelp"),
    },
    {
      name: "reviewOn",
      label: t("fields.reviewOn"),
      kind: "date",
      defaultValue: member?.reviewOn ?? "",
    },
  ];
}

async function PoolRecord({
  page,
  pool,
  canWrite,
}: {
  page: PageSetup;
  pool: TalentPool;
  canWrite: boolean;
}) {
  const { ctx, t } = page;
  const [members, parties] = await Promise.all([
    listPoolMembers(ctx.viewer.db, pool.id),
    canWrite ? knownParties(ctx) : Promise.resolve([]),
  ]);
  const rows = must(members, "pool members");
  const wanted = pool.kind === "Talent" ? "person" : "org";
  const candidates = parties.filter(
    (p) =>
      p.kind === wanted &&
      !rows.some((m) => `${wanted}:${m.personId ?? m.organizationId}` === p.value),
  );
  return (
    <div className="flex flex-col gap-16">
      <header className="flex flex-col gap-8 border-b border-border-subtle pb-12">
        <Link
          href={page.href({ pool: null }) as Route}
          className="text-text-12 text-text-secondary hover:text-text-primary"
        >
          {t("pools.back")}
        </Link>
        <div className="flex flex-wrap items-center gap-8">
          <h1 className="m-0 text-heading-20 font-semibold">{pool.name}</h1>
          <Tag tone="neutral">{t(`poolKinds.${enumKey(pool.kind)}`)}</Tag>
        </div>
      </header>
      <InlineAlert tone="info">{t("pools.internal")}</InlineAlert>
      <Section id="pool-members" title={t("pools.members", { count: rows.length })}>
        {rows.length === 0 ? <Muted>{t("pools.noMembers")}</Muted> : null}
        <ul className="m-0 flex list-none flex-col gap-8 p-0">
          {rows.map((m) => (
            <li
              key={m.id}
              className="flex flex-col gap-8 rounded-card border border-border-subtle p-8 text-text-13"
            >
              <div className="flex flex-wrap items-center justify-between gap-8">
                <span className="font-medium">{m.name ?? t("pools.unnamed")}</span>
                <Tag
                  tone={
                    m.standing === "Do Not Engage"
                      ? "danger"
                      : m.standing === "Preferred"
                        ? "success"
                        : "neutral"
                  }
                >
                  {t(`standings.${enumKey(m.standing)}`)}
                </Tag>
              </div>
              {m.standing === "Do Not Engage" ? (
                <p className="m-0 text-text-secondary">
                  {t("pools.dneDetail", { reason: m.reason ?? "", date: m.reviewOn ?? "" })}
                </p>
              ) : null}
              {canWrite ? (
                <div className="flex flex-wrap items-end gap-12">
                  <ActionForm
                    action={setStandingAction}
                    hidden={{ org: ctx.org.slug, memberId: m.id }}
                    inline
                    fields={standingFields(page, m)}
                    submitLabel={t("pools.setStanding")}
                  />
                  <ActionForm
                    action={removePoolMemberAction}
                    hidden={{ org: ctx.org.slug, memberId: m.id }}
                    fields={[]}
                    inline
                    submitLabel={t("remove")}
                    variant="danger"
                  />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </Section>
      {canWrite ? (
        <Section id="pool-add" title={t("pools.add")}>
          {candidates.length === 0 ? (
            <Muted>{t("pools.noCandidates")}</Muted>
          ) : (
            <ActionForm
              action={addPoolMemberAction}
              hidden={{ org: ctx.org.slug, poolId: pool.id }}
              fields={[
                {
                  name: "party",
                  label: t("fields.party"),
                  kind: "select",
                  defaultValue: candidates[0]?.value ?? "",
                  options: candidates,
                },
                ...standingFields(page),
              ]}
              submitLabel={t("pools.addMember")}
              variant="primary"
            />
          )}
        </Section>
      ) : null}
    </div>
  );
}
