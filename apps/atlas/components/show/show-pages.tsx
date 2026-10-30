import { listAttachments } from "@xos/data/attachments";
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
} from "@xos/data/show";
import { listScopeNodeRefs, type ProjectRef, type ScopeNodeRef } from "@xos/data/work";
import { getNode } from "@xos/ia";
import type { ReactNode } from "react";
import { collectionPeek } from "@/components/shell/collection-peek";
import { CollabPanels } from "@/components/work/collab";
import {
  capabilitySet,
  loadRecordMeta,
  must,
  nodeViews,
  param,
  type RecordMeta,
  type SearchParams,
} from "@/components/work/load";
import { engagementOptions } from "@/lib/people/project-people";
import type { OrgContext } from "@/lib/shell/context";
import { sitemap } from "@/lib/shell/sitemap";
import { orgToday } from "@/lib/shell/time-zone";
import { getTranslate } from "@/lib/shell/translate";
import { CreateRunDialog, RunBody, RunCollection, RunPeek } from "./runs";
import { CallSheetPeek, DaySheetPeek, SheetCollection } from "./sheets";
import { DocumentActions } from "@/components/documents/document-actions";
import { DayTypeTags } from "@/components/schedule/day-type-tags";
import { dayTypeSlug, listProjectDays } from "@xos/data/schedule-days";

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
    const [run, cues, setTimes, cueCalls] = await Promise.all([
      getRunOfShow(db, peekId),
      listCues(db, peekId),
      listCueEngagements(db, peekId),
      listCueCalls(db, peekId),
    ]);
    if (run.ok) {
      const cueList = must(cues, "cues");
      const canEdit = caps.has("show.run_of_show.write");
      // Set for: the run's project's Artist engagements (R1), only where the viewer edits cues.
      const artists = canEdit
        ? (await engagementOptions(ctx, run.data.projectId))
            .filter((e) => e.roleType === "Artist")
            .map((e) => ({ value: e.engagementId, label: e.personName ?? e.accountName ?? "" }))
        : [];
      peek = (
        <RunPeek title={`${run.data.projectKey} · ${run.data.name}`}>
          <RunBody
            org={ctx.org.slug}
            run={run.data}
            cues={cueList}
            progress={cueProgress(cueList)}
            live={param(search, "live") === "1"}
            canEdit={canEdit}
            canCall={caps.has("show.cue.call")}
            setTimes={setTimes.ok ? setTimes.data : []}
            artists={artists}
            calls={must(cueCalls, "cue calls")}
            department={cueCallKindOf(param(search, "dept"))}
          >
            {param(search, "live") === "1" ? null : (
              <>
                <DocumentActions org={ctx.org.slug} kind="run-of-show" id={run.data.id} />
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
            {await collab(ctx, meta, { table: "app.day_sheets", id: open.id })}
          </DaySheetPeek>
        ) : null,
      )}
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
