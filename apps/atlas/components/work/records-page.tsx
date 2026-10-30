import {
  buildTimeline,
  latestBaselinePlan,
  listDependencies,
  lockedRecordIds,
} from "@xos/data/schedule";
import { listRecords, sortRecords, type ProjectRef, type RecordSort } from "@xos/data/work";
import { todayIn } from "@xos/data/calendar";
import { getNode } from "@xos/ia";
import type { ReactNode } from "react";
import type { OrgContext } from "@/lib/shell/context";
import { sitemap } from "@/lib/shell/sitemap";
import { getOrgTimeZone } from "@/lib/shell/time-zone";
import { getTranslate } from "@/lib/shell/translate";
import type { BulkConfig } from "@/components/bulk/types";
import { LiveRefresh } from "@/components/live/live-refresh";
import { collectionPeek } from "@/components/shell/collection-peek";
import { CustomFieldList } from "@/components/custom-fields/list";
import { customFieldList } from "@/lib/custom-fields/server";
import { CreateRecordDialog } from "./create-record";
import {
  capabilitySet,
  listParam,
  loadRecordMeta,
  must,
  nodeViews,
  param,
  recordBulkConfig,
  type SearchParams,
} from "./load";
import { RecordCollection } from "./record-collection";
import { loadRecordDetail, RecordBody, recordPropertyItems } from "./record-detail";
import { RecordPeek } from "./record-peek";

const SORTS: readonly RecordSort[] = ["key", "next", "title", "state", "updated"];

/**
 * The server half of every record collection page: Work > All records and By kind, Schedule >
 * Timeline, Calendar and Milestones, and the project Work and Schedule tabs. It reads the records
 * the viewer may see with the filters in the query string, lays out the timeline when that view is
 * shown, and renders the side peek for `?peek=KEY`.
 */
export async function RecordsPage({
  ctx,
  node,
  search,
  emptyKey,
  fixedKinds,
  project,
  boardBy,
  datedOnly = false,
  createLabel,
  title,
}: {
  ctx: OrgContext;
  node: string;
  search: SearchParams;
  emptyKey: string;
  /** Kinds the page shows (Milestones shows Milestone records only). */
  fixedKinds?: readonly string[];
  /** The project a project tab is about. */
  project?: ProjectRef;
  boardBy?: "state" | "kind";
  datedOnly?: boolean;
  createLabel?: string;
  title?: string;
}) {
  const t = await getTranslate();
  const db = ctx.viewer.db;
  const [meta, caps, custom] = await Promise.all([
    loadRecordMeta(ctx),
    capabilitySet(ctx),
    customFieldList(ctx, "app.records", search),
  ]);
  const { views, defaultView } = nodeViews(node);
  const requested = param(search, "view");
  const view = requested && views.includes(requested) ? requested : defaultView;
  const projectFilter = project?.key ?? param(search, "project") ?? "";
  const projectId = project?.id ?? meta.projects.find((p) => p.key === projectFilter)?.id;
  const kinds = fixedKinds ?? listParam(search, "kind");
  const states = listParam(search, "state");
  const q = param(search, "q") ?? "";
  const sortParam = param(search, "sort") as RecordSort | undefined;
  const sort =
    sortParam && SORTS.includes(sortParam) ? sortParam : view === "timeline" ? "next" : "key";
  // On a project tab the project's calendar, else the org's (A71); never the UTC date.
  const today = todayIn(project ? project.timeZone : await getOrgTimeZone(ctx));
  const monthParam = param(search, "month");
  const month =
    monthParam && /^\d{4}-\d{2}-01$/.test(monthParam) ? monthParam : `${today.slice(0, 7)}-01`;

  const base = {
    orgId: ctx.org.id,
    ...(projectId ? { projectId } : {}),
    ...(fixedKinds ? { kinds: fixedKinds } : {}),
    ...(datedOnly ? { datedOnly: true } : {}),
  };
  const [all, filtered] = await Promise.all([
    listRecords(db, { ...base, limit: 1 }),
    listRecords(db, {
      ...base,
      ...(kinds.length > 0 ? { kinds } : {}),
      ...(states.length > 0 ? { states } : {}),
      ...(q ? { search: q } : {}),
    }),
  ]);
  const records = sortRecords(
    must(filtered, "records").filter((r) => custom.keep(r.id)),
    sort,
    meta.states,
  );
  const total = must(all, "records").length;

  const timeZone =
    project?.timeZone ?? records[0]?.projectTimeZone ?? meta.projects[0]?.timeZone ?? "UTC";
  // People who may change the timeline drag its bars to reschedule (A133).
  const canReschedule = view === "timeline" && caps.has("schedule.timeline.write");
  let timeline = null;
  if (view === "timeline" && records.length > 0) {
    const ids = records.map((r) => r.id);
    const [deps, plan, locked] = await Promise.all([
      listDependencies(db, ids),
      projectId
        ? latestBaselinePlan(db, projectId)
        : Promise.resolve({ ok: true as const, data: new Map() }),
      canReschedule
        ? lockedRecordIds(db, records)
        : Promise.resolve({ ok: true as const, data: new Set<string>() }),
    ]);
    timeline = buildTimeline({
      records,
      dependencies: must(deps, "dependencies"),
      baseline: must(plan, "baseline"),
      locked: must(locked, "locked records"),
      timeZone,
      // A week of room on each side to drag bars into.
      ...(canReschedule ? { pad: 7 } : {}),
    });
  }

  const peekKey = param(search, "peek");
  let peek: ReactNode = null;
  if (peekKey) {
    const detail = await loadRecordDetail(ctx, peekKey);
    if (detail) {
      peek = (
        <RecordPeek
          org={ctx.org.slug}
          recordKey={detail.record.key}
          kind={detail.record.kind}
          title={detail.record.title}
          state={detail.record.state}
          properties={await recordPropertyItems(detail)}
        >
          <RecordBody org={ctx.org.slug} detail={detail} me={ctx.viewer.person?.id ?? null} />
        </RecordPeek>
      );
    }
  }

  const canCreate = caps.has("work.record.write");
  // Bulk edit (Section 11.7) for people who may change records.
  const bulk: BulkConfig | null = canCreate ? recordBulkConfig(ctx.org.slug, meta, t) : null;
  const label = title ?? t(getNode(sitemap, node).node.label);
  const visibleKinds = fixedKinds ?? meta.kinds.map((k) => k.kind);
  // Quick add (Section 11.7): a line lands in the page's project (its tab or its filter), as the New
  // record sheet does, is read on that project's calendar or the org's, and creates the page's kind.
  const landing = meta.projects.find((p) => p.id === projectId);
  const quickAdd =
    canCreate && meta.projects.length > 0
      ? {
          org: ctx.org.slug,
          timeZone: landing ? landing.timeZone : await getOrgTimeZone(ctx),
          projectId: projectId ?? null,
          kinds: fixedKinds ?? null,
          defaultKind: fixedKinds?.[0] ?? (kinds.length === 1 ? kinds[0] : undefined) ?? "Task",
        }
      : null;

  // Records update live (Section 11.7, ADR 0044): the project's when on a project tab, else the org's.
  const live = [
    {
      table: "records",
      filter: projectId ? `project_id=eq.${projectId}` : `org_id=eq.${ctx.org.id}`,
    },
  ];

  return (
    <CustomFieldList value={await custom.view(records.map((r) => r.id))}>
      <LiveRefresh topics={live} />
      <RecordCollection
        org={ctx.org.slug}
        title={label}
        label={t("work.collection.label", { title: label })}
        emptyKey={emptyKey}
        records={records}
        total={total}
        views={views}
        view={view}
        filters={{
          q,
          kinds: fixedKinds ? [] : kinds,
          states,
          project: project ? "" : projectFilter,
          sort,
        }}
        kinds={visibleKinds}
        states={meta.states}
        projects={project ? [] : meta.projects}
        boardBy={boardBy ?? "state"}
        month={month}
        today={today}
        timeZone={timeZone}
        timeline={timeline}
        canReschedule={canReschedule}
        canCreate={canCreate}
        bulk={bulk}
        quickAdd={quickAdd}
        hideKindFilter={fixedKinds !== undefined && fixedKinds.length <= 1}
        create={
          <CreateRecordDialog
            org={ctx.org.slug}
            kinds={fixedKinds ? meta.kinds.filter((k) => fixedKinds.includes(k.kind)) : meta.kinds}
            projects={meta.projects}
            people={meta.people}
            phases={meta.phases}
            xyzTags={meta.xyzTags}
            open={param(search, "create") === "1"}
            {...(fixedKinds?.length === 1 && fixedKinds[0] ? { fixedKind: fixedKinds[0] } : {})}
            {...(project ? { fixedProjectId: project.id } : {})}
            {...(createLabel ? { label: createLabel } : {})}
          />
        }
        peek={collectionPeek(peekKey, peek)}
      />
    </CustomFieldList>
  );
}
