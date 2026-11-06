import { draftedListIsEmpty } from "@xos/data/ai";
import { listAttachments } from "@xos/data/attachments";
import { listCueFieldAudiences } from "@xos/data/cue-field-audiences";
import { listCustomFieldDefinitions, listCustomFieldValues } from "@xos/data/custom-fields";
import { listThreads } from "@xos/data/comments";
import {
  cueCallKindOf,
  cueProgress,
  getRunOfShow,
  listCallSheets,
  listCalls,
  listCueCalls,
  listCueEngagements,
  listCues,
  listDaySheets,
  listRunsOfShow,
  listSegmentColors,
  type Cue,
} from "@xos/data/show";
import { listScopeNodeRefs, type ProjectRef, type ScopeNodeRef } from "@xos/data/work";
import { todayIn } from "@xos/data/calendar";
import { ButtonLink } from "@/components/ui";
import { getNode } from "@xos/ia";
import { listMembers } from "@xos/data/identity";
import { listProjectLocalContacts } from "@xos/data/local-contacts";
import { getFormatter, getLocale } from "next-intl/server";
import dynamic from "next/dynamic";
import type { ReactNode } from "react";
import { shownContacts } from "@/components/local-contacts/shown";
import { collectionPeek } from "@/components/shell/collection-peek";
import { CollabPanels } from "@/components/work/collab";
import { RecordHistory } from "@/components/history/record-history";
import {
  capabilitySet,
  loadRecordMeta,
  must,
  nodeViews,
  param,
  type RecordMeta,
  type SearchParams,
} from "@/components/work/load";
import { people } from "@/lib/custom-fields/server";
import { engagementOptions } from "@/lib/people/project-people";
import { cueFieldChips, type CueFieldChip } from "@/lib/show/cue-field-chips";
import type { OrgContext } from "@/lib/shell/context";
import { importLinkHref } from "@/lib/imports/import-link";
import { sitemap } from "@/lib/shell/sitemap";
import { orgToday } from "@/lib/shell/time-zone";
import { getTranslate } from "@/lib/shell/translate";
import { CreateRunDialog, RunBody, RunCollection, RunPeek } from "./runs";
import { CallSheetPeek, DaySheetPeek, SheetCollection } from "./sheets";
import { DocumentActions } from "@/components/documents/document-actions";
import { DisplayScreensAction } from "./display-screens-action";
import { DayTypeTags } from "@/components/schedule/day-type-tags";
import { dayTypeSlug, listProjectDays } from "@xos/data/schedule-days";
import { DaySheetAudienceDownload } from "./day-sheet-audience-download";
import { documentHref } from "@/lib/documents/links";
import { CUE_CALL_KINDS, CUE_CALL_SLUGS } from "@xos/data/cue-calls";
import { departmentsInUse, getDepartmentsInUse } from "@xos/data/org-setup";
import { listDepartments } from "@xos/data/projects";
import { listTeams } from "@xos/data/views";
import { ShowcallerLinksAction } from "./showcaller-links-action";

type Subject = { table: "app.run_of_show" | "app.day_sheets" | "app.call_sheets"; id: string };

/** A sheet day's types (B4, G-38) as tags, for the day sheet peek; nothing when the day has none. */
async function daySheetTypes(ctx: OrgContext, projectId: string, day: string): Promise<ReactNode> {
  const t = await getTranslate();
  const days = await listProjectDays(ctx.viewer.db, {
    orgId: ctx.org.id,
    projectIds: [projectId],
    from: day,
    to: day,
  });
  if (!days.ok || days.data.length === 0) return null;
  return (
    <DayTypeTags
      label={t("schedule.days.label")}
      tags={days.data.map((d) => ({
        dayType: d.dayType,
        label: d.label ?? t(`schedule.days.types.${dayTypeSlug(d.dayType)}`),
      }))}
    />
  );
}

async function collab(ctx: OrgContext, meta: RecordMeta, subject: Subject): Promise<ReactNode> {
  const t = await getTranslate();
  const db = ctx.viewer.db;
  const [threads, attachments] = await Promise.all([
    listThreads(db, subject),
    listAttachments(db, subject),
  ]);
  return (
    <>
      <RecordHistory db={db} table={subject.table} id={subject.id} />
      <CollabPanels
        org={ctx.org.slug}
        subject={subject}
        threads={must(threads, "comments")}
        attachments={must(attachments, "attachments")}
        names={Object.fromEntries(
          meta.people.map((p) => [p.personId, p.name ?? t("work.values.unnamed")]),
        )}
        me={ctx.viewer.person?.id ?? null}
        canPost
      />
    </>
  );
}

function viewFor(node: string, search: SearchParams) {
  const { views, defaultView } = nodeViews(node);
  const requested = param(search, "view");
  return { views, view: requested && views.includes(requested) ? requested : defaultView };
}

/** The month a calendar shows: `month=YYYY-MM-01`, else the month of today on the org's calendar (A71). */
async function monthFor(ctx: OrgContext, search: SearchParams) {
  const today = await orgToday(ctx);
  const m = param(search, "month");
  return { today, month: m && /^\d{4}-\d{2}-01$/.test(m) ? m : `${today.slice(0, 7)}-01` };
}

const UUID = /^[0-9a-f-]{36}$/;

/**
 * The Crew-audience custom values of a running order's cues, as chips (B3, ADR 0142). Crew is presentation only:
 * the values are the ones the viewer's own access reads; a choice keeps its color and a person shows by name. Also says
 * whether the org has any live cue field, in any audience: a Client-only field must still be fillable in the editor.
 */
async function crewChips(
  ctx: OrgContext,
  cues: readonly Cue[],
  timeZone: string,
): Promise<{ chips: Record<string, CueFieldChip[]>; hasCueFields: boolean }> {
  const db = ctx.viewer.db;
  const [definitions, audiences] = await Promise.all([
    listCustomFieldDefinitions(db, ctx.org.id, "app.cues"),
    listCueFieldAudiences(db, ctx.org.id),
  ]);
  const hasCueFields = definitions.ok && definitions.data.length > 0;
  if (!definitions.ok || !audiences.ok) return { chips: {}, hasCueFields };
  const crew = definitions.data.filter((f) => audiences.data.get(f.id)?.includes("Crew"));
  if (crew.length === 0 || cues.length === 0) return { chips: {}, hasCueFields };
  const [values, members] = await Promise.all([
    listCustomFieldValues(
      db,
      crew,
      cues.map((c) => c.id),
    ),
    crew.some((f) => f.dataType === "Person") ? people(ctx) : Promise.resolve([]),
  ]);
  if (!values.ok) return { chips: {}, hasCueFields };
  const t = await getTranslate();
  const format = await getFormatter();
  const chips = cueFieldChips(crew, values.data, {
    format,
    yes: t("platform.customFields.yes"),
    no: t("platform.customFields.no"),
    someone: t("platform.customFields.someone"),
    people: Object.fromEntries(members.map((p) => [p.id, p.name])),
    timeZone,
  });
  return { chips, hasCueFields };
}

/** Show > Run of show, and the project Show tab. */
export async function RunsPage({
  ctx,
  node,
  search,
  project,
}: {
  ctx: OrgContext;
  node: string;
  search: SearchParams;
  project?: ProjectRef;
}) {
  const t = await getTranslate();
  const db = ctx.viewer.db;
  const { views, view } = viewFor(node, search);
  const q = param(search, "q") ?? "";
  const scope = project ? { projectId: project.id } : {};
  const [meta, caps, all, filtered] = await Promise.all([
    loadRecordMeta(ctx),
    capabilitySet(ctx),
    listRunsOfShow(db, { orgId: ctx.org.id, ...scope }),
    listRunsOfShow(db, { orgId: ctx.org.id, ...scope, ...(q ? { search: q } : {}) }),
  ]);
  const projects = project ? [project] : meta.projects;
  const scopeNodes: ScopeNodeRef[] = (
    await Promise.all(
      projects.map(async (p) => must(await listScopeNodeRefs(db, p.id), "scope nodes")),
    )
  ).flat();

  let peek: ReactNode = null;
  const peekId = param(search, "peek");
  if (peekId && UUID.test(peekId)) {
    const [run, cues, setTimes, cueCalls, colors] = await Promise.all([
      getRunOfShow(db, peekId),
      listCues(db, peekId),
      listCueEngagements(db, peekId),
      listCueCalls(db, peekId),
      listSegmentColors(db, peekId),
    ]);
    if (run.ok) {
      const cueList = must(cues, "cues");
      const { chips, hasCueFields } = await crewChips(ctx, cueList, run.data.timeZone);
      const live = param(search, "live") === "1";
      const canEdit = caps.has("show.run_of_show.write");
      // Aurora drafts only into an empty running order the viewer may write to (P6); the database
      // answers both, counting cues the viewer cannot see.
      const draftable =
        canEdit && cueList.length === 0
          ? await draftedListIsEmpty(db, "run_of_show", run.data.id).then((r) => r.ok && r.data)
          : false;
      // Set for: the run's project's Artist engagements (R1), only where the viewer edits cues.
      const artists = canEdit
        ? (await engagementOptions(ctx, run.data.projectId))
            .filter((e) => e.roleType === "Artist")
            .map((e) => ({ value: e.engagementId, label: e.personName ?? e.accountName ?? "" }))
        : [];
      peek = (
        <RunPeek title={`${run.data.projectKey} · ${run.data.name}`} wide={live}>
          <RunBody
            org={ctx.org.slug}
            run={run.data}
            cues={cueList}
            progress={cueProgress(cueList)}
            live={param(search, "live") === "1"}
            canEdit={canEdit}
            canCall={caps.has("show.cue.call")}
            draftable={draftable}
            setTimes={setTimes.ok ? setTimes.data : []}
            artists={artists}
            importHref={importLinkHref(ctx.org.slug, ctx.nav, canEdit, {
              target: "cues",
              runOfShowId: run.data.id,
            })}
            calls={must(cueCalls, "cue calls")}
            department={cueCallKindOf(param(search, "dept"))}
            segmentColors={colors.ok ? Object.fromEntries(colors.data) : {}}
            fieldChips={chips}
            hasCueFields={hasCueFields}
            // The show channel sits beside the running cue for every member following live mode.
            channelProjectId={live ? run.data.projectId : null}
          >
            {param(search, "live") === "1" ? null : (
              <>
                <span className="inline-flex flex-wrap items-center gap-8">
                  <DocumentActions org={ctx.org.slug} kind="run-of-show" id={run.data.id} />
                  {canEdit ? (
                    <DisplayScreensAction
                      org={ctx.org.slug}
                      run={{ id: run.data.id, name: run.data.name }}
                    />
                  ) : null}
                  {canEdit && caps.has("show.cue.call") ? (
                    <ShowcallerLinksAction
                      org={ctx.org.slug}
                      run={{
                        id: run.data.id,
                        name: run.data.name,
                        showDate: run.data.showDate,
                        timeZone: run.data.timeZone,
                      }}
                    />
                  ) : null}
                </span>
                {await collab(ctx, meta, { table: "app.run_of_show", id: run.data.id })}
              </>
            )}
          </RunBody>
        </RunPeek>
      );
    } else if (run.error.kind !== "not-found") {
      throw new Error(`Cannot load running order: ${JSON.stringify(run.error)}`);
    }
  }

  return (
    <RunCollection
      org={ctx.org.slug}
      today={await orgToday(ctx)}
      title={t(getNode(sitemap, node).node.label)}
      runs={must(filtered, "running orders")}
      total={must(all, "running orders").length}
      views={views}
      view={view}
      q={q}
      canCreate={caps.has("show.run_of_show.write")}
      create={
        <CreateRunDialog
          org={ctx.org.slug}
          projects={projects}
          scopeNodes={scopeNodes}
          {...(project ? { fixedProjectId: project.id } : {})}
          open={param(search, "create") === "1"}
        />
      }
      peek={collectionPeek(peekId, peek)}
      {...(project
        ? {
            showDay: (
              <ButtonLink
                href={`/${ctx.org.slug}/show/show-day?project=${encodeURIComponent(project.key)}&day=${todayIn(project.timeZone)}`}
                size="sm"
              >
                {t("show.showDay.open")}
              </ButtonLink>
            ),
          }
        : {})}
    />
  );
}

/** The local contacts panel loads with an open day sheet only (B5, G-56). */
const LocalContactsPanel = dynamic(() =>
  import("@/components/local-contacts/panel").then((m) => m.LocalContactsPanel),
);

/**
 * The day sheet's Local contacts (B5, G-56): the venue's, the project's every-day contacts and that day's, read
 * through app.project_local_contacts; members show their current name and directory work phone.
 */
async function daySheetContacts(
  ctx: OrgContext,
  projectId: string,
  day: string,
  canWrite: boolean,
): Promise<ReactNode> {
  const [contacts, members, locale] = await Promise.all([
    listProjectLocalContacts(ctx.viewer.db, projectId, day),
    canWrite ? listMembers(ctx.viewer.db, ctx.org.id) : null,
    getLocale(),
  ]);
  if (!contacts.ok) return null;
  return (
    <LocalContactsPanel
      org={ctx.org.slug}
      namespace="show"
      home={{ projectId }}
      day={day}
      contacts={shownContacts(contacts.data, locale)}
      members={
        members?.ok
          ? members.data.map((m) => ({ membershipId: m.membershipId, name: m.fullName ?? "" }))
          : []
      }
      canWrite={canWrite}
    />
  );
}

/** Show > Day sheets. */
export async function DaySheetsPage({
  ctx,
  node,
  search,
}: {
  ctx: OrgContext;
  node: string;
  search: SearchParams;
}) {
  const t = await getTranslate();
  const { views, view } = viewFor(node, search);
  const { today, month } = await monthFor(ctx, search);
  const [meta, caps, sheets] = await Promise.all([
    loadRecordMeta(ctx),
    capabilitySet(ctx),
    listDaySheets(ctx.viewer.db, { orgId: ctx.org.id }),
  ]);
  const list = must(sheets, "day sheets");
  const peekId = param(search, "peek");
  const open = peekId ? list.find((s) => s.id === peekId) : undefined;
  return (
    <SheetCollection
      org={ctx.org.slug}
      kind="daySheets"
      title={t(getNode(sitemap, node).node.label)}
      sheets={list}
      views={views}
      view={view}
      month={month}
      today={today}
      projects={meta.projects}
      canWrite={caps.has("show.day_sheet.write")}
      open={param(search, "create") === "1"}
      {...(open ? { openId: open.id } : {})}
      peek={collectionPeek(
        peekId,
        open ? (
          <DaySheetPeek
            org={ctx.org.slug}
            sheet={open}
            canWrite={caps.has("show.day_sheet.write")}
            canPublish={caps.has("show.call_sheet.publish")}
            dayTypes={await daySheetTypes(ctx, open.projectId, open.day)}
          >
            <DocumentActions org={ctx.org.slug} kind="day-sheet" id={open.id} />
            {await daySheetContacts(
              ctx,
              open.projectId,
              open.day,
              caps.has("show.day_sheet.write"),
            )}
            {await audienceDownload(ctx, open.id)}
            {await collab(ctx, meta, { table: "app.day_sheets", id: open.id })}
          </DaySheetPeek>
        ) : null,
      )}
    />
  );
}

/**
 * The day sheet peek's "Download for…" (B7): the org's teams and the departments in use, read only while a sheet is
 * open, with the copy passed to the on-demand client control.
 */
async function audienceDownload(ctx: OrgContext, id: string) {
  const [t, teams, departments, inUse] = await Promise.all([
    getTranslate(),
    listTeams(ctx.viewer.db, ctx.org.id),
    listDepartments(ctx.viewer.db),
    getDepartmentsInUse(ctx.viewer.db, ctx.org.id),
  ]);
  return (
    <DaySheetAudienceDownload
      href={documentHref(ctx.org.slug, "day-sheet", id)}
      teams={(teams.ok ? teams.data : []).map((team) => ({ value: team.id, label: team.name }))}
      departments={(departments.ok
        ? departmentsInUse(departments.data, inUse.ok ? inUse.data.departments : [])
        : []
      ).map((d) => ({ value: d.code, label: `${d.label} · ${d.code}` }))}
      callKinds={CUE_CALL_KINDS.map((k) => ({
        value: CUE_CALL_SLUGS[k],
        label: t(`show.cues.departments.${CUE_CALL_SLUGS[k]}`),
      }))}
      labels={{
        downloadFor: t("show.daySheets.downloadFor"),
        audienceKind: t("show.daySheets.audienceKind"),
        forTeam: t("show.daySheets.forTeam"),
        forDepartment: t("show.daySheets.forDepartment"),
        team: t("show.daySheets.team"),
        department: t("show.daySheets.department"),
        showDepartment: t("show.daySheets.showDepartment"),
        anyDepartment: t("show.daySheets.anyDepartment"),
        paper: t("show.daySheets.paper"),
        letter: t("documents.paper.letter"),
        a4: t("documents.paper.a4"),
        download: t("documents.actions.download"),
      }}
    />
  );
}

/** Show > Call sheets. */
export async function CallSheetsPage({
  ctx,
  node,
  search,
}: {
  ctx: OrgContext;
  node: string;
  search: SearchParams;
}) {
  const t = await getTranslate();
  const { views, view } = viewFor(node, search);
  const { today, month } = await monthFor(ctx, search);
  const [meta, caps, sheets] = await Promise.all([
    loadRecordMeta(ctx),
    capabilitySet(ctx),
    listCallSheets(ctx.viewer.db, { orgId: ctx.org.id }),
  ]);
  const list = must(sheets, "call sheets");
  const peekId = param(search, "peek");
  const open = peekId ? list.find((s) => s.id === peekId) : undefined;
  let peek: ReactNode = null;
  if (open) {
    const timeZone = meta.projects.find((p) => p.id === open.projectId)?.timeZone ?? "UTC";
    const calls = must(
      await listCalls(ctx.viewer.db, { projectId: open.projectId, day: open.day, timeZone }),
      "calls",
    );
    peek = (
      <CallSheetPeek
        org={ctx.org.slug}
        sheet={open}
        calls={calls}
        timeZone={timeZone}
        canPublish={caps.has("show.call_sheet.publish")}
      >
        <DocumentActions org={ctx.org.slug} kind="call-sheet" id={open.id} />
        {await collab(ctx, meta, { table: "app.call_sheets", id: open.id })}
      </CallSheetPeek>
    );
  }
  return (
    <SheetCollection
      org={ctx.org.slug}
      kind="callSheets"
      title={t(getNode(sitemap, node).node.label)}
      sheets={list}
      views={views}
      view={view}
      month={month}
      today={today}
      projects={meta.projects}
      canWrite={caps.has("show.call_sheet.publish")}
      open={param(search, "create") === "1"}
      {...(open ? { openId: open.id } : {})}
      peek={collectionPeek(peekId, peek)}
    />
  );
}
