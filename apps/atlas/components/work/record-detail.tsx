import { listAttachments, type Attachment } from "@xos/data/attachments";
import { listThreads, type Thread } from "@xos/data/comments";
import { getActual, listDependencies, type Actual, type Dependency } from "@xos/data/schedule";
import { getPunchItemForRecord } from "@xos/data/work-orders";
import {
  getRecordByKey,
  getRecordExtension,
  getWatch,
  listAssignments,
  listChecklist,
  listCurrencyOptions,
  listRecords,
  listRecurrences,
  listReplans,
  listScopeNodeRefs,
  listStateHistory,
  nextStates,
  replanShift,
  type Assignment,
  type ChecklistItem,
  type ExtensionValues,
  type RecordSummary,
  type Recurrence,
  type ReplanEntry,
  type ScopeNodeRef,
  type StateEntry,
} from "@xos/data/work";
import { InlineAlert, PropertyList } from "./ui";
import { getFormatter, getLocale } from "next-intl/server";
import { ActualsForm, DependencyEditor } from "@/components/schedule/schedule-panels";
import type { OrgContext } from "@/lib/shell/context";
import { getTranslate } from "@/lib/shell/translate";
import { CollabPanels } from "./collab";
import { formatScheduleTime, scheduleViewOf, slipAmount, type ScheduleView } from "./format";
import { getShellSettings } from "@/lib/shell/org-settings";
import { kindFields } from "./kind-fields";
import { capabilitySet, loadRecordMeta, must, type RecordMeta } from "./load";
import {
  AssignmentsEditor,
  ChecklistEditor,
  DuplicateButton,
  EditRecordForm,
  ExtensionForm,
  RecurrenceForm,
  TransitionControls,
  TrashControls,
  WatchButton,
  type KindField,
} from "./record-panels";

/**
 * Everything the record peek and the record full page show (Record template, Section 11.6), read
 * once per request: the record, its kind's attributes, state ledger, replan log, checklist,
 * assignees, dependencies, actuals, recurrence, comments and attachments.
 */
export interface RecordDetail {
  readonly record: RecordSummary;
  readonly meta: RecordMeta;
  readonly next: readonly string[];
  readonly scopeNodes: readonly ScopeNodeRef[];
  readonly fields: readonly KindField[];
  readonly extension: ExtensionValues;
  readonly currencies: readonly { code: string; exponent: number }[];
  readonly checklist: readonly ChecklistItem[];
  readonly assignments: readonly Assignment[];
  readonly watchId: string | null;
  readonly recurrence: Recurrence | null;
  readonly history: readonly StateEntry[];
  readonly replans: readonly ReplanEntry[];
  readonly dependencies: readonly Dependency[];
  readonly siblings: readonly RecordSummary[];
  readonly actual: Actual | null;
  readonly punch: {
    readonly sourceRecordId: string | null;
    readonly locationText: string | null;
  } | null;
  readonly threads: readonly Thread[];
  readonly attachments: readonly Attachment[];
  readonly canWrite: boolean;
  readonly canSchedule: boolean;
  readonly canRecur: boolean;
  /** How the viewer reads schedule times (me.time_zone_display and their own zone). */
  readonly scheduleView: ScheduleView;
}

/** The record a display key names, with all it shows, or null when it is not visible. */
export async function loadRecordDetail(ctx: OrgContext, key: string): Promise<RecordDetail | null> {
  const db = ctx.viewer.db;
  const found = await getRecordByKey(db, ctx.org.id, key);
  if (!found.ok) {
    if (found.error.kind === "not-found") return null;
    throw new Error(`Cannot load record ${key}: ${JSON.stringify(found.error)}`);
  }
  const record = found.data;
  const subject = { table: "app.records", id: record.id } as const;
  const [
    meta,
    caps,
    scope,
    fields,
    extension,
    currencies,
    checklist,
    assignments,
    watch,
    recurrences,
    history,
    replans,
    deps,
    siblings,
    actual,
    punch,
    threads,
    attachments,
    shell,
  ] = await Promise.all([
    loadRecordMeta(ctx),
    capabilitySet(ctx),
    listScopeNodeRefs(db, record.projectId),
    kindFields(ctx, record.kind),
    getRecordExtension(db, record.kind, record.id),
    listCurrencyOptions(db),
    listChecklist(db, record.id),
    listAssignments(db, record.id),
    ctx.viewer.person
      ? getWatch(db, record.id, ctx.viewer.person.id)
      : Promise.resolve({ ok: true as const, data: null }),
    listRecurrences(db, [record.id]),
    listStateHistory(db, record.id),
    listReplans(db, record.id),
    listDependencies(db, [record.id]),
    listRecords(db, { orgId: ctx.org.id, projectId: record.projectId, limit: 500 }),
    getActual(db, record.id),
    getPunchItemForRecord(db, record.id),
    listThreads(db, subject),
    listAttachments(db, subject),
    getShellSettings(db, ctx.org.id, null),
  ]);
  return {
    record,
    meta,
    next: record.deletedAt ? [] : nextStates(meta.rules, meta.states, record.state),
    scopeNodes: must(scope, "scope nodes"),
    fields,
    extension: must(extension, "record attributes"),
    currencies: must(currencies, "currencies"),
    checklist: must(checklist, "checklist"),
    assignments: must(assignments, "assignees"),
    watchId: must(watch, "watch")?.id ?? null,
    recurrence: must(recurrences, "recurrence").get(record.id) ?? null,
    history: must(history, "state history"),
    replans: must(replans, "replan log"),
    dependencies: must(deps, "dependencies"),
    siblings: must(siblings, "project records").filter((r) => r.id !== record.id),
    actual: must(actual, "actuals"),
    punch: must(punch, "punch item"),
    threads: must(threads, "comments"),
    attachments: must(attachments, "attachments"),
    canWrite: caps.has("work.record.write") && !record.deletedAt,
    canSchedule: caps.has("schedule.timeline.write") && !record.deletedAt,
    canRecur: caps.has("work.recurring.write") && !record.deletedAt,
    scheduleView: scheduleViewOf(shell.preferences, shell.viewerTimeZone),
  };
}

/** The property column: who, what, where and when, every canon code beside its plain name. */
export async function RecordProperties({ detail }: { detail: RecordDetail }) {
  const items = await recordPropertyItems(detail);
  return <PropertyList items={items} />;
}

export async function recordPropertyItems(detail: RecordDetail) {
  const t = await getTranslate();
  const locale = await getLocale();
  const { record, meta } = detail;
  const tz = record.timeZone ?? record.projectTimeZone;
  // Schedule times follow me.time_zone_display and carry their zone abbreviation (Section 15).
  const when = (v: string | null) =>
    formatScheduleTime(v, locale, tz, detail.scheduleView) ?? t("work.values.notSet");
  const person = (id: string | null) =>
    id
      ? (meta.people.find((p) => p.personId === id)?.name ?? t("work.values.unnamed"))
      : t("work.values.unassigned");
  const phase = meta.phases.find((p) => p.value === record.phaseCode);
  const kindClass = meta.kinds.find((k) => k.kind === record.kind)?.recordClass;
  return [
    {
      label: t("work.fields.kind"),
      value: `${t(`work.kinds.${record.kind}`)}${record.subtype ? ` · ${t(`work.subtypes.${record.kind}.${record.subtype}`)}` : ""}`,
    },
    {
      label: t("work.fields.class"),
      value: kindClass ? t(`work.classes.${kindClass}`) : t("work.values.notSet"),
    },
    { label: t("work.fields.project"), value: `${record.projectKey} · ${record.projectName}` },
    {
      label: t("work.fields.scope"),
      value:
        detail.scopeNodes.find((n) => n.id === record.scopeNodeId)?.name ?? t("work.values.none"),
    },
    {
      label: t("work.fields.phase"),
      value: phase
        ? t("work.values.gate", { gate: phase.gate, name: phase.label })
        : t("work.values.none"),
    },
    { label: t("work.fields.urid"), value: record.urid ?? t("work.values.none") },
    { label: t("work.fields.xyz"), value: t(`work.xyz.${record.xyz}`) },
    { label: t("work.fields.owner"), value: person(record.ownerId) },
    { label: t("work.fields.accountable"), value: person(record.accountableId) },
    { label: t("work.fields.starts"), value: when(record.startsAt) },
    { label: t("work.fields.ends"), value: when(record.endsAt) },
    { label: t("work.fields.due"), value: when(record.dueAt) },
    { label: t("work.fields.timeZone"), value: tz },
  ];
}

/** The content column: state moves, editing, the kind's attributes, work, schedule and history. */
export async function RecordBody({
  org,
  detail,
  me,
}: {
  org: string;
  detail: RecordDetail;
  /** The viewer's person id, to offer deleting their own comments and files. */
  me: string | null;
}) {
  const t = await getTranslate();
  const format = await getFormatter();
  const locale = await getLocale();
  const { record, meta } = detail;
  const tz = record.timeZone ?? record.projectTimeZone;
  const ordinal = (state: string) => meta.states.find((s) => s.state === state)?.ordinal ?? 0;
  const logsReplans = ordinal(record.state) >= ordinal("Scheduled");
  const subtypes = meta.kinds.find((k) => k.kind === record.kind)?.subtypes ?? [];
  const names = Object.fromEntries(
    meta.people.map((p) => [p.personId, p.name ?? t("work.values.unnamed")]),
  );
  const when = (v: string | null) =>
    formatScheduleTime(v, locale, tz, detail.scheduleView) ?? t("work.values.notSet");
  const dated = record.startsAt || record.endsAt || record.dueAt || detail.dependencies.length > 0;

  return (
    <div className="flex flex-col gap-24">
      {record.state === "Blocked" && record.blockerText ? (
        <InlineAlert tone="warning" title={t("work.record.blockedBy")}>
          {record.blockerText}
        </InlineAlert>
      ) : null}
      {record.state === "Deferred" && record.replanReason ? (
        <InlineAlert tone="info" title={t("work.record.deferredBecause")}>
          {record.replanReason}
        </InlineAlert>
      ) : null}
      {detail.punch ? (
        <InlineAlert tone="info" title={t("work.punch.thisIs")}>
          {detail.punch.locationText ?? t("work.punch.noLocation")}
        </InlineAlert>
      ) : null}
      {detail.canWrite ? <TransitionControls org={org} record={record} next={detail.next} /> : null}
      {detail.canWrite ? (
        <EditRecordForm
          org={org}
          record={record}
          subtypes={subtypes}
          people={meta.people}
          scopeNodes={detail.scopeNodes}
          phases={meta.phases}
          logsReplans={logsReplans}
        />
      ) : null}
      <ExtensionForm
        org={org}
        record={record}
        fields={detail.fields}
        values={detail.extension}
        people={meta.people}
        currencies={detail.currencies}
        canEdit={detail.canWrite}
      />
      <ChecklistEditor
        org={org}
        recordId={record.id}
        items={detail.checklist}
        canEdit={detail.canWrite}
      />
      <AssignmentsEditor
        org={org}
        recordId={record.id}
        assignments={detail.assignments}
        people={meta.people}
        canEdit={detail.canWrite}
      />
      {record.deletedAt ? null : (
        <WatchButton org={org} recordId={record.id} watchId={detail.watchId} />
      )}
      {dated || detail.canSchedule ? (
        <DependencyEditor
          org={org}
          record={record}
          dependencies={detail.dependencies}
          candidates={detail.siblings}
          canEdit={detail.canSchedule}
        />
      ) : null}
      {dated ? (
        <ActualsForm
          org={org}
          record={record}
          actual={detail.actual}
          canEdit={detail.canSchedule}
        />
      ) : null}
      <RecurrenceForm
        org={org}
        record={record}
        recurrence={detail.recurrence}
        canEdit={detail.canRecur}
      />
      <section aria-labelledby={`history-${record.id}`} className="flex flex-col gap-8">
        <h3 id={`history-${record.id}`} className="m-0 text-label-13 font-semibold">
          {t("work.history.title")}
        </h3>
        <ol className="m-0 flex list-none flex-col gap-6 p-0">
          {detail.history.map((h) => (
            <li key={h.id} className="text-text-13">
              <span className="font-medium">
                {h.from
                  ? t("work.history.moved", {
                      from: t(`work.states.${h.from}`),
                      to: t(`work.states.${h.to}`),
                    })
                  : t("work.history.created", { state: t(`work.states.${h.to}`) })}
              </span>{" "}
              <span className="text-text-secondary">
                {format.dateTime(new Date(h.at), { dateStyle: "medium", timeStyle: "short" })}
                {h.byName ? ` · ${h.byName}` : ""}
              </span>
              {h.from ? <p className="m-0 text-text-secondary">{h.reason}</p> : null}
            </li>
          ))}
        </ol>
      </section>
      <section aria-labelledby={`replans-${record.id}`} className="flex flex-col gap-8">
        <h3 id={`replans-${record.id}`} className="m-0 text-label-13 font-semibold">
          {t("work.replans.title")}
        </h3>
        {detail.replans.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">
            {logsReplans ? t("work.replans.none") : t("work.replans.notYet")}
          </p>
        ) : (
          <ol className="m-0 flex list-none flex-col gap-8 p-0">
            {detail.replans.map((r) => {
              const shift = replanShift(r);
              const slip = slipAmount(shift.endShiftMs);
              return (
                <li key={r.id} className="flex flex-col gap-2 text-text-13">
                  <span className="font-medium">
                    {shift.moved
                      ? slip
                        ? t(
                            `work.replans.${slip.late ? "slipped" : "pulledIn"}${slip.unit === "hours" ? "Hours" : ""}`,
                            {
                              n: slip.n,
                            },
                          )
                        : t("work.replans.datesChanged")
                      : t("work.replans.stateChanged", {
                          from: t(`work.states.${r.fromState}`),
                          to: t(`work.states.${r.toState}`),
                        })}
                  </span>
                  {shift.moved ? (
                    <span className="text-text-secondary">
                      {t("work.replans.window", {
                        before: when(r.oldEndsAt ?? r.oldDueAt ?? r.oldStartsAt),
                        after: when(r.newEndsAt ?? r.newDueAt ?? r.newStartsAt),
                      })}
                    </span>
                  ) : null}
                  {r.reason ? <span className="text-text-secondary">{r.reason}</span> : null}
                  <span className="text-text-12 text-text-tertiary">
                    {format.dateTime(new Date(r.at), { dateStyle: "medium", timeStyle: "short" })}
                    {r.byName ? ` · ${r.byName}` : ""}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </section>
      <CollabPanels
        org={org}
        subject={{ table: "app.records", id: record.id }}
        threads={detail.threads}
        attachments={detail.attachments}
        names={names}
        me={me}
        canPost={!record.deletedAt}
      />
      {detail.canWrite ? <DuplicateButton org={org} recordId={record.id} /> : null}
      {detail.canWrite || record.deletedAt ? <TrashControls org={org} record={record} /> : null}
    </div>
  );
}
