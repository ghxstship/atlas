import {
  getRider,
  listAdvanceParties,
  listRiders,
  type RiderDetail,
  type RiderSummary,
} from "@xos/data/advancing";
import type { RecordState } from "@xos/ui";
import Link from "next/link";
import type { Route } from "next";
import { notFound } from "next/navigation";
import { getFormatter } from "next-intl/server";
import { RiderExtraction } from "@/components/aurora/rider-extraction";
import { collectionPeek } from "@/components/shell/collection-peek";
import { EmptyStateLink } from "@/components/ui";
import { peekRowMissing } from "@/lib/shell/peek-handoff";
import { getTranslate, type Translate } from "@/lib/shell/translate";
import type { AdvancingContext } from "./context";
import { RecordCollab } from "./record-collab";
import {
  AddRiderLineForm,
  ArchiveRiderButton,
  CreateRiderDialog,
  Panel,
  RiderDetailsForm,
  RiderLineRow,
} from "./forms";
import { isRowId, pickView, Property, withQuery, type Search } from "./shared";
import { PageHeader, ProgressBar, StateChip, Tag, TemplateRecord } from "./ui";
import { PeekPanel, PeekTable, SelectFilter, ViewSwitcher } from "./views";
import { CollectionPage } from "@/components/platform/collection-page";

const VIEWS = ["list", "table"] as const;

/** A rider is open while any ask is unfulfilled; with no asks yet it is still being entered. */
function riderState(r: RiderSummary): {
  state: RecordState;
  key: "Entering" | "Open" | "Fulfilled";
} {
  if (r.lineCount === 0) return { state: "proposed", key: "Entering" };
  return r.fulfilledCount >= r.lineCount
    ? { state: "complete", key: "Fulfilled" }
    : { state: "active", key: "Open" };
}

function partyName(r: RiderSummary, t: Translate): string {
  return r.counterpartyId
    ? (r.counterpartyName ?? t("advancing.common.counterparty"))
    : t("advancing.riders.noParty");
}

/**
 * Riders (Section 4.5.5): technical and hospitality riders with their asks and fulfillment. The
 * Collection template with list and table views, a side peek and the Record template full page.
 */
export async function RidersCollection({
  actx,
  path,
  search,
  title,
}: {
  actx: AdvancingContext;
  path: string;
  search: Search;
  title: string;
}) {
  const { ctx, can, projects, project } = actx;
  const t = await getTranslate();
  const peekId = search["peek"];
  const parties = can.rider ? await listAdvanceParties(ctx.viewer.db, ctx.org.id) : null;
  if (parties && !parties.ok)
    throw new Error(`Cannot list parties: ${JSON.stringify(parties.error)}`);
  const counterpartyOptions = (parties?.ok ? parties.data : [])
    .filter((p) => p.kind === "counterparty")
    .map((p) => ({ value: p.id, label: p.name ?? t("advancing.common.counterparty") }));

  if (peekId && search["full"] === "1") {
    return (
      <RiderPage
        actx={actx}
        riderId={peekId}
        backHref={withQuery(path, search, { peek: null, full: null })}
        parties={counterpartyOptions}
      />
    );
  }

  const result = await listRiders(ctx.viewer.db, {
    orgId: ctx.org.id,
    ...(project ? { projectId: project.id } : {}),
  });
  if (!result.ok) throw new Error(`Cannot list riders: ${JSON.stringify(result.error)}`);
  const riders = result.data;
  const view = pickView(search, VIEWS, "list");
  const projectKey = (id: string) => projects.find((p) => p.id === id)?.key ?? "";
  const fixedProject = actx.project !== null && search["project"] === undefined;
  const lines = (r: RiderSummary) =>
    t("advancing.riders.fulfilled", { fulfilled: r.fulfilledCount, total: r.lineCount });
  // A key that is no rider id (a record key from elsewhere) goes to the shell's peek; an id outside
  // the list answers 404.
  const peekRider = peekId ? riders.find((r) => r.id === peekId) : undefined;
  if (peekId && isRowId(peekId) && !peekRider) notFound();

  return (
    <CollectionPage
      gap={12}
      header={
        <PageHeader
          title={title}
          count={riders.length}
          views={<ViewSwitcher views={VIEWS} current={view} />}
          {...(can.rider && projects.length > 0
            ? {
                actions: (
                  <CreateRiderDialog
                    org={ctx.org.slug}
                    projects={projects.map((p) => ({ value: p.id, label: `${p.key} · ${p.name}` }))}
                    parties={counterpartyOptions}
                    defaultProjectId={project?.id ?? null}
                    defaultOpen={search["create"] === "1"}
                  />
                ),
              }
            : {})}
        />
      }
    >
      {fixedProject ? null : (
        <div className="flex flex-wrap items-end gap-8">
          <SelectFilter
            id="riders-project"
            label={t("advancing.common.project")}
            param="project"
            value={project?.key ?? ""}
            options={[
              { value: "", label: t("advancing.common.allProjects") },
              ...projects.map((p) => ({ value: p.key, label: `${p.key} · ${p.name}` })),
            ]}
          />
        </div>
      )}
      {riders.length === 0 ? (
        <EmptyStateLink
          icon="FileText"
          sentence={
            projects.length === 0
              ? t("advancing.riders.emptyNoProjects")
              : can.rider
                ? t("advancing.riders.empty")
                : t("advancing.riders.emptyReadOnly")
          }
          actionLabel={
            projects.length === 0
              ? t("advancing.common.viewProjects")
              : t("advancing.riders.create.open")
          }
          href={
            projects.length === 0
              ? `/${ctx.org.slug}/projects/all`
              : withQuery(path, search, { create: "1" })
          }
        />
      ) : view === "table" ? (
        <PeekTable
          caption={title}
          columns={[
            { key: "title", label: t("advancing.riders.columns.title"), wrap: true },
            { key: "project", label: t("advancing.common.project"), type: "code" },
            { key: "party", label: t("advancing.riders.columns.party") },
            { key: "state", label: t("advancing.common.state") },
            { key: "lines", label: t("advancing.riders.columns.lines") },
          ]}
          rows={riders.map((r) => ({
            id: r.id,
            label: r.title,
            title: r.title,
            project: projectKey(r.projectId),
            party: partyName(r, t),
            state: t(`advancing.riders.states.${riderState(r).key}`),
            lines: lines(r),
          }))}
        />
      ) : (
        <ul
          aria-label={title}
          className="m-0 flex list-none flex-col divide-y divide-border-subtle rounded-card border border-border-subtle p-0"
        >
          {riders.map((r) => {
            const s = riderState(r);
            return (
              <li key={r.id}>
                <Link
                  href={withQuery(path, search, { peek: r.id, full: null }) as Route}
                  className="flex min-h-row-comfortable flex-wrap items-center gap-12 px-16 py-8 hover:bg-bg-hover focus-visible:bg-bg-hover"
                >
                  <StateChip
                    state={s.state}
                    label={t(`advancing.riders.states.${s.key}`)}
                    compact
                  />
                  <span className="font-mono text-text-12 text-text-secondary">
                    {projectKey(r.projectId)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-text-14 text-text-primary">
                    {r.title}
                  </span>
                  <span className="text-text-12 text-text-secondary">{partyName(r, t)}</span>
                  <span className="text-text-12 text-text-secondary">{lines(r)}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {collectionPeek(
        peekId,
        peekRider ? (
          <PeekPanel
            title={peekRider.title}
            state={riderState(peekRider).state}
            stateLabel={t(`advancing.riders.states.${riderState(peekRider).key}`)}
            properties={[
              { label: t("advancing.common.project"), value: projectKey(peekRider.projectId) },
              { label: t("advancing.riders.columns.party"), value: partyName(peekRider, t) },
              { label: t("advancing.riders.columns.lines"), value: lines(peekRider) },
            ]}
          />
        ) : null,
      )}
    </CollectionPage>
  );
}

async function loadRider(actx: AdvancingContext, riderId: string): Promise<RiderDetail> {
  const result = await getRider(actx.ctx.viewer.db, riderId);
  if (!result.ok) {
    if (peekRowMissing(result.error)) notFound();
    throw new Error(`Cannot read rider: ${JSON.stringify(result.error)}`);
  }
  if (actx.project && result.data.projectId !== actx.project.id) notFound();
  return result.data;
}

async function RiderPage({
  actx,
  riderId,
  backHref,
  parties,
}: {
  actx: AdvancingContext;
  riderId: string;
  backHref: string;
  parties: readonly { value: string; label: string }[];
}) {
  const { ctx, can } = actx;
  const rider = await loadRider(actx, riderId);
  const t = await getTranslate();
  const format = await getFormatter();
  const org = ctx.org.slug;
  const project = actx.projects.find((p) => p.id === rider.projectId);
  const s = riderState(rider);
  const when = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" });
  return (
    <TemplateRecord
      propertiesLabel={t("advancing.common.properties")}
      header={
        <div className="flex flex-col gap-8">
          <Link
            href={backHref as Route}
            className="text-text-13 text-text-secondary hover:text-text-primary"
          >
            {t("advancing.riders.back")}
          </Link>
          <div className="flex flex-wrap items-center justify-between gap-12">
            <div className="flex flex-wrap items-center gap-8">
              {project ? <Tag>{project.key}</Tag> : null}
              <h1 className="m-0 text-heading-20 font-semibold">{rider.title}</h1>
              <StateChip state={s.state} label={t(`advancing.riders.states.${s.key}`)} />
            </div>
            {can.rider ? (
              <ArchiveRiderButton
                org={org}
                riderId={rider.id}
                title={rider.title}
                backHref={backHref}
              />
            ) : null}
          </div>
        </div>
      }
      properties={
        <dl className="m-0 flex flex-col">
          <Property label={t("advancing.common.project")}>
            {project ? `${project.key} · ${project.name}` : ""}
          </Property>
          <Property label={t("advancing.riders.columns.party")}>{partyName(rider, t)}</Property>
          <Property label={t("advancing.common.created")}>{when(rider.createdAt)}</Property>
          <Property label={t("advancing.riders.columns.lines")}>
            <ProgressBar
              label={t("advancing.riders.fulfilled", {
                fulfilled: rider.fulfilledCount,
                total: rider.lineCount,
              })}
              value={
                rider.lineCount === 0
                  ? 0
                  : Math.round((rider.fulfilledCount / rider.lineCount) * 100)
              }
            />
          </Property>
        </dl>
      }
    >
      <Panel id="rider-details" title={t("advancing.riders.details.title")}>
        <RiderDetailsForm
          org={org}
          riderId={rider.id}
          title={rider.title}
          counterpartyId={rider.counterpartyId}
          parties={parties}
          disabled={!can.rider}
        />
      </Panel>
      <Panel id="rider-lines" title={t("advancing.lines.title")}>
        {rider.lines.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">
            {can.rider ? t("advancing.lines.emptyEditable") : t("advancing.lines.empty")}
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle rounded-card border border-border-subtle p-0">
            {rider.lines.map((l) => (
              <li key={l.id} className="p-12">
                <RiderLineRow
                  org={org}
                  line={l}
                  canEdit={can.rider}
                  fulfilledLabel={
                    l.fulfilledAt
                      ? t("advancing.lines.fulfilledOn", { date: when(l.fulfilledAt) })
                      : null
                  }
                />
              </li>
            ))}
          </ul>
        )}
        {can.rider ? <AddRiderLineForm org={org} riderId={rider.id} /> : null}
        {can.rider ? <RiderExtraction org={org} riderId={rider.id} /> : null}
        <p className="m-0 text-text-12 text-text-tertiary">{t("advancing.extraction.hint")}</p>
      </Panel>
      <RecordCollab actx={actx} table="app.riders" id={rider.id} canUpload={can.rider} />
    </TemplateRecord>
  );
}
