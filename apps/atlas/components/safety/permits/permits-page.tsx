import type { ProjectOption } from "@xos/data/places";
import type { Route } from "next";
import Link from "next/link";
import { getFormatter } from "next-intl/server";
import { trackPermitAction } from "@/app/[org]/safety/actions";
import { heldCapabilities } from "@/components/places/kit/access";
import { ActionButton } from "@/components/places/kit/buttons";
import { PeekTable, QueryDrawer } from "@/components/places/kit/client";
import { Collaboration } from "@/components/places/kit/collaboration";
import {
  BackLink,
  Collection,
  EntityList,
  LinkFilter,
  RecordSection,
  SearchBox,
  type Search,
} from "@/components/places/kit/parts";
import {
  InlineAlert,
  PropertyList,
  RefusalNotice,
  StateChip,
  Tag,
  TemplateRecord,
} from "@/components/places/kit/ui";
import {
  chooseView,
  matchesSearch,
  param,
  recordStateToken,
  withQuery,
} from "@/components/places/kit/views";
import { requireNode } from "@/lib/shell/require-node";
import type { OrgContext } from "@/lib/shell/context";
import { nodeHref } from "@/lib/shell/sitemap";
import { getTranslate, type Translate } from "@/lib/shell/translate";
import { GenerateButton } from "./generate-button";
import { loadPermits, type PermitData, type PermitRow } from "./load";
import { PermitBoard } from "./permit-board";
import { PermitDetailsForm, PermitTransitionForm } from "./permit-forms";

const NODE = "safety.permits";

/** Safety > Permits at org level (Section 4.5.5): every project's requirements, with a project filter. */
export async function PermitsPage({
  params,
  search,
}: {
  params: Readonly<Record<string, string>>;
  search: Search;
}) {
  const ctx = await requireNode(NODE, params);
  return (
    <PermitsView
      ctx={ctx}
      path={nodeHref(NODE, params) ?? "/"}
      search={search}
      projectId={param(search, "project")}
      showProjectFilter
    />
  );
}

/**
 * The permit engine's requirements (Section 3.7, journey 1). Requirements come only from canon rules
 * of the project's jurisdiction chain; an unresolved or unpopulated jurisdiction answers NO_ANSWER and
 * never passes. Each requirement shows its permit, authority and canon lead time, and can be tracked
 * by a Permit record that follows the record lifecycle.
 */
export async function PermitsView({
  ctx,
  path,
  search,
  projectId,
  showProjectFilter,
  projectSettingsHref,
}: {
  ctx: OrgContext;
  path: string;
  search: Search;
  projectId: string | undefined;
  showProjectFilter: boolean;
  projectSettingsHref?: string;
}) {
  const db = ctx.viewer.db;
  const [data, t, held] = await Promise.all([
    loadPermits(db, ctx.org.id, projectId),
    getTranslate(),
    heldCapabilities(ctx),
  ]);
  const canWrite = held.has("safety.permit.write");
  const canTrack = canWrite && held.has("work.record.write");
  const q = param(search, "q");
  const rows = data.rows.filter((r) =>
    matchesSearch(
      q,
      r.rule,
      r.canon?.permit ?? null,
      r.canon?.authority ?? null,
      r.project?.key ?? null,
    ),
  );
  const focus = projectId ? data.projects.find((p) => p.id === projectId) : undefined;
  const peekId = param(search, "peek");
  const selected = peekId ? data.rows.find((r) => r.id === peekId) : undefined;
  const me = ctx.viewer.person?.id ?? null;

  if (peekId && param(search, "full") === "1") {
    return (
      <div className="flex flex-col gap-12">
        <BackLink
          href={withQuery(path, search, { peek: undefined, full: undefined })}
          label={t("permits.permits.back")}
        />
        {selected ? (
          <TemplateRecord
            propertiesLabel={t("places.kit.properties")}
            header={<PermitHeader row={selected} t={t} level={1} />}
            properties={<PermitProperties row={selected} t={t} />}
          >
            <PermitBody
              row={selected}
              data={data}
              t={t}
              org={ctx.org.slug}
              canTrack={canTrack}
              canWrite={canWrite}
              me={me}
              ctx={ctx}
            />
          </TemplateRecord>
        ) : (
          <InlineAlert tone="warning" title={t("places.kit.peekMissingTitle")}>
            {t("places.kit.peekMissing")}
          </InlineAlert>
        )}
      </div>
    );
  }

  const tracked = rows.filter((r) => r.record !== null);
  const views = chooseView(NODE, param(search, "view"), { board: tracked.length > 0 });
  const overlay = peekId ? (
    <QueryDrawer title={t("permits.permits.peekTitle")} closeKeys={["peek"]}>
      {selected ? (
        <div className="flex flex-col gap-16">
          <div className="flex flex-wrap items-center justify-between gap-8">
            <PermitHeader row={selected} t={t} level={3} />
            <Link
              href={withQuery(path, search, { full: "1" }) as Route}
              className="text-text-13 text-accent-text underline"
            >
              {t("places.kit.openFull")}
            </Link>
          </div>
          <PermitProperties row={selected} t={t} />
          <PermitBody
            row={selected}
            data={data}
            t={t}
            org={ctx.org.slug}
            canTrack={canTrack}
            canWrite={canWrite}
            me={me}
            ctx={ctx}
          />
        </div>
      ) : (
        <InlineAlert tone="warning" title={t("places.kit.peekMissingTitle")}>
          {t("places.kit.peekMissing")}
        </InlineAlert>
      )}
    </QueryDrawer>
  ) : null;

  const engine = focus ? (
    <EnginePanel
      focus={focus}
      data={data}
      t={t}
      org={ctx.org.slug}
      canWrite={canWrite}
      {...(projectSettingsHref ? { projectSettingsHref } : {})}
    />
  ) : null;

  let body;
  if (data.projects.length === 0) {
    body = <InlineAlert tone="info">{t("permits.permits.noProjects")}</InlineAlert>;
  } else if (data.rows.length === 0) {
    body = focus ? null : (
      <InlineAlert tone="info" title={t("permits.permits.emptyTitle")}>
        {t("permits.permits.empty")}
      </InlineAlert>
    );
  } else if (rows.length === 0) {
    body = <InlineAlert tone="info">{t("places.kit.noMatches")}</InlineAlert>;
  } else if (views.current === "table") {
    body = (
      <PeekTable
        label={t("permits.permits.title")}
        pinStart={["permit"]}
        columns={[
          { key: "permit", label: t("permits.permits.fields.permit"), wrap: true },
          { key: "project", label: t("permits.permits.fields.project"), type: "code" },
          { key: "authority", label: t("permits.permits.fields.authority"), wrap: true },
          { key: "leadTime", label: t("permits.permits.fields.leadTime") },
          { key: "trigger", label: t("permits.permits.fields.trigger") },
          { key: "jurisdiction", label: t("permits.permits.fields.jurisdiction"), type: "code" },
          { key: "state", label: t("permits.permits.fields.state"), type: "state" },
          { key: "key", label: t("permits.permits.fields.record"), type: "code" },
        ]}
        rows={rows.map((r) => ({
          id: r.id,
          permit: r.canon?.permit ?? r.rule,
          project: r.project?.key ?? null,
          authority: r.canon?.authority ?? null,
          leadTime: r.canon?.leadTime ?? null,
          trigger: r.canon ? t(`permits.triggers.${r.canon.triggerType}`) : null,
          jurisdiction: r.canon?.jurisdictionId ?? null,
          state: r.record
            ? {
                state: recordStateToken(r.record.state),
                label: t(`permits.states.${r.record.state}`),
              }
            : null,
          key: r.record?.displayKey ?? null,
        }))}
      />
    );
  } else if (views.current === "board") {
    const columns = data.states.map((s) => ({
      state: recordStateToken(s),
      label: t(`permits.states.${s}`),
      cards: tracked
        .filter((r) => r.record?.state === s)
        .map((r) => ({
          key: r.id,
          title: r.canon?.permit ?? r.rule,
          meta: [r.project?.key, r.canon?.leadTime].filter(Boolean).join(" · "),
          kind: "Permit" as const,
        })),
    }));
    const untracked = rows.length - tracked.length;
    body = (
      <div className="flex flex-col gap-8">
        {untracked > 0 ? (
          <InlineAlert tone="info">
            {t("permits.permits.untrackedOnBoard", { count: untracked })}
          </InlineAlert>
        ) : null}
        <PermitBoard
          org={ctx.org.slug}
          columns={columns}
          recordOf={Object.fromEntries(tracked.map((r) => [r.id, r.record?.id ?? ""]))}
          stateOf={Object.fromEntries(data.states.map((s) => [recordStateToken(s), s]))}
        />
      </div>
    );
  } else {
    body = (
      <EntityList
        label={t("permits.permits.title")}
        path={path}
        search={search}
        rows={rows.map((r) => ({
          id: r.id,
          title: r.canon?.permit ?? r.rule,
          meta: [
            r.project?.key,
            r.canon?.authority,
            t("permits.permits.leadTimeChip", { leadTime: r.canon?.leadTime ?? "" }),
          ]
            .filter(Boolean)
            .join(" · "),
          chips: r.record ? (
            <>
              <StateChip
                state={recordStateToken(r.record.state)}
                label={t(`permits.states.${r.record.state}`)}
                compact
              />
              <Tag>{r.record.displayKey}</Tag>
            </>
          ) : (
            <Tag tone="warning">{t("permits.permits.untracked")}</Tag>
          ),
        }))}
      />
    );
  }

  return (
    <Collection
      title={t("permits.permits.title")}
      count={rows.length}
      views={views}
      filters={
        <>
          <SearchBox path={path} search={search} label={t("permits.permits.search")} />
          {showProjectFilter ? (
            <LinkFilter
              path={path}
              search={search}
              label={t("permits.permits.fields.project")}
              queryKey="project"
              allLabel={t("permits.permits.allProjects")}
              options={data.projects.map((p) => ({ value: p.id, label: `${p.key} ${p.name}` }))}
            />
          ) : null}
        </>
      }
      overlay={overlay}
    >
      <div className="flex flex-col gap-16">
        {engine}
        {!focus && data.projects.length > 0 ? (
          <InlineAlert tone="info">{t("permits.permits.chooseProject")}</InlineAlert>
        ) : null}
        {body}
      </div>
    </Collection>
  );
}

/** The permit engine for the project in focus: NO_ANSWER for an unanswerable jurisdiction, or generate. */
function EnginePanel({
  focus,
  data,
  t,
  org,
  canWrite,
  projectSettingsHref,
}: {
  focus: ProjectOption;
  data: PermitData;
  t: Translate;
  org: string;
  canWrite: boolean;
  projectSettingsHref?: string;
}) {
  const readiness = data.readiness;
  if (readiness === null || readiness.kind !== "ready") {
    return (
      <div className="flex flex-col gap-8">
        <RefusalNotice
          outcome="NO_ANSWER"
          title={t("permits.permits.noAnswerTitle", { project: focus.key })}
          reason={
            readiness?.kind === "unpopulated"
              ? t("permits.permits.noAnswerUnpopulated", { jurisdiction: readiness.jurisdictionId })
              : t("permits.permits.noAnswerUnresolved")
          }
        />
        {projectSettingsHref ? (
          <Link
            href={projectSettingsHref as Route}
            className="text-text-13 text-accent-text underline"
          >
            {t("permits.permits.setJurisdiction")}
          </Link>
        ) : null}
      </div>
    );
  }
  const count = data.rows.filter((r) => r.projectId === focus.id).length;
  return (
    <section
      aria-labelledby="engine-heading"
      className="flex flex-col gap-8 rounded-card border border-border-subtle p-16"
    >
      <h2 id="engine-heading" className="m-0 text-text-14 font-semibold">
        {t("permits.permits.engineTitle", { project: focus.key })}
      </h2>
      <p className="m-0 text-text-13 text-text-secondary">
        {t("permits.permits.engineBody", { chain: readiness.chain.join(", "), count })}
      </p>
      {canWrite ? <GenerateButton org={org} projectId={focus.id} /> : null}
      {projectSettingsHref ? (
        <Link
          href={projectSettingsHref as Route}
          className="text-text-13 text-accent-text underline"
        >
          {t("permits.permits.setJurisdiction")}
        </Link>
      ) : null}
    </section>
  );
}

function PermitHeader({ row, t, level }: { row: PermitRow; t: Translate; level: 1 | 3 }) {
  const title = row.canon?.permit ?? row.rule;
  return (
    <header className="flex flex-wrap items-center gap-8">
      {level === 1 ? (
        <h1 className="m-0 text-heading-24 font-semibold">{title}</h1>
      ) : (
        <h3 className="m-0 text-heading-20 font-semibold">{title}</h3>
      )}
      {row.record ? (
        <StateChip
          state={recordStateToken(row.record.state)}
          label={t(`permits.states.${row.record.state}`)}
        />
      ) : (
        <Tag tone="warning">{t("permits.permits.untracked")}</Tag>
      )}
    </header>
  );
}

function PermitProperties({ row, t }: { row: PermitRow; t: Translate }) {
  const none = t("places.kit.notRecorded");
  return (
    <PropertyList
      items={[
        {
          label: t("permits.permits.fields.project"),
          value: row.project ? `${row.project.key} ${row.project.name}` : none,
        },
        { label: t("permits.permits.fields.rule"), value: row.rule },
        { label: t("permits.permits.fields.condition"), value: row.canon?.condition ?? none },
        {
          label: t("permits.permits.fields.trigger"),
          value: row.canon ? t(`permits.triggers.${row.canon.triggerType}`) : none,
        },
        { label: t("permits.permits.fields.authority"), value: row.canon?.authority ?? none },
        { label: t("permits.permits.fields.leadTime"), value: row.canon?.leadTime ?? none },
        {
          label: t("permits.permits.fields.jurisdiction"),
          value: row.canon?.jurisdictionId ?? none,
        },
        {
          label: t("permits.permits.fields.record"),
          value: row.record?.displayKey ?? t("permits.permits.untracked"),
        },
        ...(row.factGroups.length > 0
          ? [{ label: t("places.specs.venueFacts"), value: venueFacts(row, t) }]
          : []),
      ]}
    />
  );
}

/**
 * The venue facts a reviewer reads beside a rule (B1, ADR 0140 D9), or "Not recorded". Display only: which rules apply
 * is decided by the permit engine alone, and an unknown fact never passes.
 */
function venueFacts(row: PermitRow, t: Translate): string {
  const none = t("places.specs.notRecorded");
  const f = row.facts;
  const n = (v: number | null, unit = "") => (v === null ? none : `${v}${unit}`);
  return row.factGroups
    .map((group) => {
      if (!f) return none;
      switch (group) {
        case "occupancy":
          return t("places.specs.facts.occupancy", {
            occupancy: n(f.occupantLoad),
            spaces:
              f.spaceCapacityTotal !== null
                ? t("places.specs.facts.spacesOf", {
                    known: f.spacesCapacityKnown,
                    count: f.spacesCount,
                    total: f.spaceCapacityTotal,
                  })
                : t("places.specs.facts.spacesPartial", {
                    known: f.spacesCapacityKnown,
                    count: f.spacesCount,
                  }),
          });
        case "power":
          return t("places.specs.facts.power", {
            power:
              f.housePowerAmps === null && f.housePowerVoltage === null
                ? none
                : [
                    n(f.housePowerAmps, " A"),
                    n(f.housePowerVoltage, " V"),
                    f.housePowerPhase ? `${f.housePowerPhase}Φ` : null,
                  ]
                    .filter(Boolean)
                    .join(" · "),
          });
        case "rigging":
          return t("places.specs.facts.rigging", {
            rigging:
              f.riggingPointCount === null && f.riggingTotalLoadLb === null
                ? none
                : [
                    f.riggingPointCount !== null
                      ? `${f.riggingPointCount} × ${n(f.riggingPointLoadLb, " lb")}`
                      : null,
                    f.riggingTotalLoadLb !== null ? `(${f.riggingTotalLoadLb} lb)` : null,
                  ]
                    .filter(Boolean)
                    .join(" "),
          });
        default:
          return t("places.specs.facts.dimensions", { height: n(f.clearHeightFt, " ft") });
      }
    })
    .join("; ");
}

async function PermitBody({
  row,
  data,
  t,
  org,
  canTrack,
  canWrite,
  me,
  ctx,
}: {
  row: PermitRow;
  data: PermitData;
  t: Translate;
  org: string;
  canTrack: boolean;
  canWrite: boolean;
  me: string | null;
  ctx: OrgContext;
}) {
  const format = await getFormatter();
  const day = (iso: string | null) =>
    iso === null
      ? t("places.kit.notRecorded")
      : format.dateTime(new Date(iso), { dateStyle: "medium", timeZone: "UTC" });
  return (
    <div className="flex flex-col gap-16">
      <p className="m-0 text-text-13 text-text-secondary">{t("permits.permits.canonNote")}</p>
      {row.record === null ? (
        canTrack ? (
          <RecordSection id="permit-track" title={t("permits.permits.trackTitle")}>
            <p className="m-0 text-text-13 text-text-secondary">{t("permits.permits.trackBody")}</p>
            <ActionButton
              action={trackPermitAction}
              org={org}
              fields={{ id: row.id }}
              label={t("permits.permits.track")}
              variant="primary"
            />
          </RecordSection>
        ) : (
          <InlineAlert tone="info">{t("permits.permits.untrackedReadOnly")}</InlineAlert>
        )
      ) : (
        <>
          {row.record.state === "Blocked" && row.record.blocker ? (
            <InlineAlert tone="warning" title={t("permits.permits.blockedBy")}>
              {row.record.blocker}
            </InlineAlert>
          ) : null}
          <RecordSection id="permit-instrument" title={t("permits.permits.instrument")}>
            <PropertyList
              items={[
                {
                  label: t("permits.permits.fields.number"),
                  value: row.record.permitIdentifier ?? t("places.kit.notRecorded"),
                },
                { label: t("permits.permits.fields.issued"), value: day(row.record.issuedAt) },
                { label: t("permits.permits.fields.expires"), value: day(row.record.expiresAt) },
              ]}
            />
            {canWrite ? <PermitDetailsForm org={org} record={row.record} /> : null}
          </RecordSection>
          {canWrite ? (
            <RecordSection id="permit-state" title={t("permits.permits.stateTitle")}>
              <PermitTransitionForm
                org={org}
                record={row.record}
                nextStates={data.transitions.get(row.record.state) ?? []}
              />
            </RecordSection>
          ) : null}
        </>
      )}
      <Collaboration
        db={ctx.viewer.db}
        org={org}
        subject={{ table: "app.permit_requirements", id: row.id }}
        me={me}
        canPost
      />
    </div>
  );
}
