import { getFieldHistory, type HistoryEvent } from "@xos/data/field-history";
import { FieldHistoryList } from "@/components/history/field-history-list";
import { getActual, type Actual, type Dependency } from "@xos/data/schedule";
import { getRecordAnchorPinned } from "@xos/data/anchor";
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
  listEligibleReviewers,
  listRecordReviews,
  listStateHistory,
  nextStates,
  replanShift,
  type Assignment,
  type ChecklistItem,
  type ExtensionValues,
  type RecordReview as Review,
  type RecordSummary,
  type Recurrence,
  type ReplanEntry,
  type ScopeNodeRef,
  type StateEntry,
} from "@xos/data/work";
import { InlineAlert, PropertyList } from "./ui";
import { getFormatter, getLocale } from "next-intl/server";
import { SummaryEntryRow } from "@/components/aurora/entry/summary-entry";
import { ActualsForm, DependencyEditor } from "@/components/schedule/schedule-panels";
import { RecordRetimeOpen } from "@/components/schedule/record-retime-open";
import type { OrgContext } from "@/lib/shell/context";
import { rememberView } from "@/lib/shell/recents";
import { getTranslate } from "@/lib/shell/translate";
import { CollabPanels } from "./collab";
import { Region } from "@/components/shell/region";
import { RegionContent } from "@/components/shell/region-content";
import { regionOf, regionRead, type RegionData } from "@/lib/shell/region-data";
import { CustomFieldsPanel } from "@/components/custom-fields/custom-fields-panel";
import {
  formatScheduleTime,
  formatStartTime,
  scheduleViewOf,
  slipAmount,
  type ScheduleView,
} from "./format";
import { getShellSettings } from "@/lib/shell/org-settings";
import { PresenceFor } from "@/components/presence/presence-for";
import { DraftEntry } from "@/components/aurora/entry/draft-entry";
import { kindFields } from "./kind-fields";
import { capabilitySet, loadRecordMeta, must, type RecordMeta } from "./load";
import { loadConversation, loadRelations, type Conversation } from "./record-sections";
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
import { recordHistoryItems } from "./record-history-items";
import { RelatedRecords, type RecordRelations } from "./related-records";
import { ArchiveControls } from "@/components/archive/archive-controls";
import { AnchorPin } from "@/components/schedule/anchor-pin";
import { RecordReview } from "./record-review";
import { FileReviewControls } from "@/components/files/file-review";
import { listVersionReviews, type VersionReview } from "@xos/data/attachments";

/**
 * Everything the record peek and the record full page show (Record template, Section 11.6), read
 * once per request: the record, its kind's attributes, state ledger, replan log, checklist,
 * assignees, related records with its dependencies, actuals, recurrence, comments and attachments.
 * Each panel's data is a RegionData (ADR 0118): a read that fails takes down only its panel, which
 * shows Retry; the record, its properties and its state moves read for the whole page.
 */
export interface RecordDetail {
  readonly record: RecordSummary;
  readonly meta: RecordMeta;
  readonly next: readonly string[];
  readonly scopeNodes: readonly ScopeNodeRef[];
  readonly fields: readonly KindField[];
  /** The kind's attribute values and the currencies a money attribute may be in. */
  readonly attributes: RegionData<{
    readonly values: ExtensionValues;
    readonly currencies: readonly { code: string; exponent: number }[];
  }>;
  readonly checklist: RegionData<readonly ChecklistItem[]>;
  readonly assignments: RegionData<readonly Assignment[]>;
  readonly watchId: RegionData<string | null>;
  readonly recurrence: RegionData<Recurrence | null>;
  readonly history: RegionData<readonly StateEntry[]>;
  /** Who changed which field and when, from the audit ledger (Section 4.10); null when unreadable. */
  readonly fieldHistory: readonly HistoryEvent[] | null;
  readonly replans: RegionData<readonly ReplanEntry[]>;
  /** Parent, sub-records, linked custom object records (record-sections.ts), dependencies and the
   * project's other records a dependency may point at. */
  readonly related: RegionData<{
    readonly relations: RecordRelations;
    readonly dependencies: readonly Dependency[];
    readonly siblings: readonly RecordSummary[];
  }>;
  readonly actual: RegionData<Actual | null>;
  readonly punch: RegionData<{
    readonly sourceRecordId: string | null;
    readonly locationText: string | null;
  } | null>;
  /** Comments and files (record-sections.ts), the same the shell's peek shows. */
  readonly conversation: RegionData<Conversation>;
  readonly canWrite: boolean;
  /** Archive and Unarchive: records write, or for a punch item's record punch list write too (A124). */
  readonly canArchive: boolean;
  readonly canSchedule: boolean;
  /** The record stays on its dates when the project's anchor moves (B4, G-44). */
  readonly anchorPinned: boolean;
  readonly canRecur: boolean;
  /** How the viewer reads schedule times (me.time_zone_display and their own zone). */
  readonly scheduleView: ScheduleView;
  /** B14 (6264): the record's reviews, latest first, and whether the viewer may turn Requires review off. */
  readonly reviews: readonly Review[];
  /** Who may be asked for a review: filled only for a writer on an Active record (app.eligible_record_reviewers). */
  readonly reviewers: readonly { readonly personId: string; readonly name: string | null }[];
  readonly canClearReviewFlag: boolean;
  /** B14 (6265): reviews of the versions of the record's files, newest first. */
  readonly fileReviews: readonly VersionReview[];
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
    related,
    siblings,
    actual,
    punch,
    conversation,
    fieldHistory,
    shell,
    pinned,
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
    regionRead("record.related", () => loadRelations(ctx, record.id)),
    // Names the ends of existing dependencies too, so archived records stay in; the picker drops them.
    listRecords(db, {
      orgId: ctx.org.id,
      projectId: record.projectId,
      archived: "include",
      limit: 500,
    }),
    getActual(db, record.id),
    getPunchItemForRecord(db, record.id),
    regionRead("record.conversation", () => loadConversation(ctx, subject)),
    getFieldHistory(db, "app.records", record.id),
    getShellSettings(db, ctx.org.id, null),
    getRecordAnchorPinned(db, record.id),
    // The command menu's recent items (Section 11.7); beside the reads, so it adds no wait.
    rememberView(ctx, "records", record.id),
  ]);
  const versionIds = conversation.ok
    ? conversation.data.attachments.flatMap((a) => a.versions.map((v) => v.id))
    : [];
  const canWrite = caps.has("work.record.write") && !record.deletedAt;
  const [reviews, fileReviews, reviewers] = await Promise.all([
    record.kind === "Approval"
      ? Promise.resolve(null)
      : listRecordReviews(db, record.id, record.projectId),
    versionIds.length > 0 ? listVersionReviews(db, versionIds) : Promise.resolve(null),
    // Only someone who may ask, about a record that can be asked about, needs the list (42501 otherwise).
    canWrite && record.state === "Active" && record.kind !== "Approval"
      ? listEligibleReviewers(db, record.id)
      : Promise.resolve(null),
  ]);
  return {
    record,
    meta,
    next: record.deletedAt ? [] : nextStates(meta.rules, meta.states, record.state),
    scopeNodes: must(scope, "scope nodes"),
    fields,
    attributes: regionOf("record.attributes", () => ({
      values: must(extension, "record attributes"),
      currencies: must(currencies, "currencies"),
    })),
    checklist: regionOf("record.checklist", () => must(checklist, "checklist")),
    assignments: regionOf("record.assignments", () => must(assignments, "assignees")),
    watchId: regionOf("record.watch", () => must(watch, "watch")?.id ?? null),
    recurrence: regionOf(
      "record.recurrence",
      () => must(recurrences, "recurrence").get(record.id) ?? null,
    ),
    history: regionOf("record.history", () => must(history, "state history")),
    fieldHistory: fieldHistory.ok ? fieldHistory.data : null,
    replans: regionOf("record.replans", () => must(replans, "replan log")),
    related: related.ok
      ? regionOf("record.related", () => ({
          ...related.data,
          siblings: must(siblings, "project records").filter((r) => r.id !== record.id),
        }))
      : related,
    actual: regionOf("record.actuals", () => must(actual, "actuals")),
    punch: regionOf("record.punch", () => must(punch, "punch item")),
    conversation,
    canWrite,
    canArchive:
      !record.deletedAt &&
      (caps.has("work.record.write") ||
        (must(punch, "punch item") !== null && caps.has("work.punch_list.write"))),
    canSchedule: caps.has("schedule.timeline.write") && !record.deletedAt,
    anchorPinned: pinned.ok ? pinned.data : false,
    canRecur: caps.has("work.recurring.write") && !record.deletedAt,
    scheduleView: scheduleViewOf(shell.preferences, shell.viewerTimeZone),
    reviews: reviews?.ok ? reviews.data : [],
    reviewers: reviewers?.ok ? reviewers.data : [],
    canClearReviewFlag: caps.has("projects.settings.write"),
    fileReviews: fileReviews?.ok ? fileReviews.data : [],
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
    {
      label: t("work.fields.starts"),
      value:
        formatStartTime(
          record.startsAt,
          record.startTbc,
          locale,
          tz,
          detail.scheduleView,
          "dateTime",
          (time) => t("work.values.tbcEstimate", { time }),
        ) ?? t("work.values.notSet"),
    },
    { label: t("work.fields.ends"), value: when(record.endsAt) },
    { label: t("work.fields.due"), value: when(record.dueAt) },
    { label: t("work.fields.timeZone"), value: tz },
  ];
}

/**
 * The content column: state moves, editing, the kind's attributes, work, schedule and history. Each
 * panel below the record's own fields fails alone, with Retry in its place (Region, A143).
 */
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
  const dated =
    record.startsAt ||
    record.endsAt ||
    record.dueAt ||
    (detail.related.ok && detail.related.data.dependencies.length > 0);
  // What Summarize reads (A95): the record, its state ledger and its comments, newest last.
  const recordLabel = `${record.key} ${record.title}`;
  const activity = [
    { collection: "records", id: record.id, label: recordLabel },
    ...(detail.history.ok ? detail.history.data : []).map((h) => ({
      collection: "record-state-transitions",
      id: h.id,
      label:
        h.from === null
          ? t("aurora.entry.summary.itemCreated", { to: t(`work.states.${h.to}`) })
          : t("aurora.entry.summary.itemMoved", {
              from: t(`work.states.${h.from}`),
              to: t(`work.states.${h.to}`),
            }),
    })),
    ...(detail.conversation.ok ? detail.conversation.data.threads : [])
      .flatMap((th) => th.comments)
      .filter((c) => c.deletedAt === null)
      .map((c) => ({
        collection: "comments",
        id: c.id,
        label: t("aurora.entry.summary.itemComment", {
          name: names[c.authorPersonId] ?? t("work.values.unnamed"),
        }),
      })),
  ].slice(0, 100);

  // Worded on the server, so a change it cannot word fails the panel, not the page.
  const { fieldHistory } = detail;
  const fieldItems = fieldHistory
    ? regionOf("record.field-history", () =>
        recordHistoryItems(fieldHistory, {
          t,
          locale,
          when,
          at: (iso) => format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" }),
          number: (n) => format.number(n),
          day: (d) =>
            format.dateTime(new Date(`${d}T00:00:00Z`), { dateStyle: "medium", timeZone: "UTC" }),
          names,
          phases: meta.phases,
          fields: detail.fields,
          // The kind's attributes word their own changes; when they did not load, their changes show raw.
          extension: detail.attributes.ok ? detail.attributes.data.values : {},
          currencies: detail.attributes.ok ? detail.attributes.data.currencies : [],
        }),
      )
    : null;

  return (
    <div className="flex flex-col gap-24">
      {/* Who else has the record open, here or in a peek (Section 11.7). */}
      <PresenceFor table="records" id={record.id} />
      <Region>
        <SummaryEntryRow
          subject={{ collection: "records", id: record.id, label: recordLabel }}
          kinds={["record_activity"]}
          items={{ record_activity: activity }}
        />
      </Region>
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
      <RegionContent data={detail.punch}>
        {(punch) =>
          punch ? (
            <InlineAlert tone="info" title={t("work.punch.thisIs")}>
              {punch.locationText ?? t("work.punch.noLocation")}
            </InlineAlert>
          ) : null
        }
      </RegionContent>
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
      {record.kind === "Approval" || record.deletedAt ? null : (
        <RecordReview
          org={org}
          recordId={record.id}
          state={record.state}
          requiresReview={record.requiresReview ?? false}
          reviews={detail.reviews}
          reviewers={detail.reviewers}
          me={me}
          ownerId={record.ownerId}
          canWrite={detail.canWrite}
          canClearFlag={detail.canClearReviewFlag}
        />
      )}
      <RegionContent data={detail.attributes}>
        {(attributes) => (
          <ExtensionForm
            org={org}
            record={record}
            fields={detail.fields}
            values={attributes.values}
            people={meta.people}
            currencies={attributes.currencies}
            canEdit={detail.canWrite}
            draftEntry={
              detail.canWrite && record.kind === "Document" && record.subtype ? (
                <GovernanceDraft record={record} />
              ) : null
            }
          />
        )}
      </RegionContent>
      <Region>
        <CustomFieldsPanel
          org={org}
          table="app.records"
          id={record.id}
          editable={detail.canWrite}
        />
      </Region>
      <RegionContent data={detail.checklist}>
        {(items) => (
          <ChecklistEditor org={org} recordId={record.id} items={items} canEdit={detail.canWrite} />
        )}
      </RegionContent>
      <RegionContent data={detail.assignments}>
        {(assignments) => (
          <AssignmentsEditor
            org={org}
            recordId={record.id}
            assignments={assignments}
            people={meta.people}
            canEdit={detail.canWrite}
          />
        )}
      </RegionContent>
      {record.deletedAt ? null : (
        <RegionContent data={detail.watchId}>
          {(watchId) => <WatchButton org={org} recordId={record.id} watchId={watchId} />}
        </RegionContent>
      )}
      <RegionContent data={detail.related}>
        {(related) => (
          <RelatedRecords
            org={org}
            recordId={record.id}
            relations={related.relations}
            dependencies={
              detail.canSchedule ? (
                <DependencyEditor
                  org={org}
                  record={record}
                  dependencies={related.dependencies}
                  candidates={related.siblings}
                  canEdit
                />
              ) : undefined
            }
          />
        )}
      </RegionContent>
      {detail.canSchedule && (record.startsAt || record.endsAt || record.dueAt) ? (
        <RecordRetimeOpen org={org} recordId={record.id} />
      ) : null}
      {/* The pin saves on the record itself, so it needs record write as well as the timeline. */}
      {detail.canSchedule && detail.canWrite ? (
        <AnchorPin org={org} recordId={record.id} pinned={detail.anchorPinned} />
      ) : null}
      {dated ? (
        <RegionContent data={detail.actual}>
          {(actual) => (
            <ActualsForm org={org} record={record} actual={actual} canEdit={detail.canSchedule} />
          )}
        </RegionContent>
      ) : null}
      <RegionContent data={detail.recurrence}>
        {(recurrence) => (
          <RecurrenceForm
            // A rule changed by an undo or by someone else fills the form afresh.
            key={recurrence?.id ?? "none"}
            org={org}
            record={record}
            recurrence={recurrence}
            canEdit={detail.canRecur}
          />
        )}
      </RegionContent>
      <RegionContent data={detail.history}>
        {(history) => (
          <section aria-labelledby={`history-${record.id}`} className="flex flex-col gap-8">
            <h3 id={`history-${record.id}`} className="m-0 text-label-13 font-semibold">
              {t("work.history.title")}
            </h3>
            <ol className="m-0 flex list-none flex-col gap-6 p-0">
              {history.map((h) => (
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
        )}
      </RegionContent>
      {fieldItems ? (
        <RegionContent data={fieldItems}>
          {(items) => (
            <FieldHistoryList
              id={record.id}
              title={t("collab.history.title")}
              empty={t("collab.history.empty")}
              items={items}
            />
          )}
        </RegionContent>
      ) : null}
      <RegionContent data={detail.replans}>
        {(replans) => (
          <section aria-labelledby={`replans-${record.id}`} className="flex flex-col gap-8">
            <h3 id={`replans-${record.id}`} className="m-0 text-label-13 font-semibold">
              {t("work.replans.title")}
            </h3>
            {replans.length === 0 ? (
              <p className="m-0 text-text-13 text-text-secondary">
                {logsReplans ? t("work.replans.none") : t("work.replans.notYet")}
              </p>
            ) : (
              <ol className="m-0 flex list-none flex-col gap-8 p-0">
                {replans.map((r) => {
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
                        {format.dateTime(new Date(r.at), {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })}
                        {r.byName ? ` · ${r.byName}` : ""}
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>
        )}
      </RegionContent>
      <RegionContent data={detail.conversation}>
        {(conversation) => (
          <CollabPanels
            org={org}
            subject={{ table: "app.records", id: record.id }}
            threads={conversation.threads}
            attachments={conversation.attachments}
            names={{ ...names, ...conversation.names }}
            me={me}
            canPost={!record.deletedAt}
          />
        )}
      </RegionContent>
      <RegionContent data={detail.conversation}>
        {(conversation) => (
          <FileReviewControls
            org={org}
            attachments={conversation.attachments}
            reviews={detail.fileReviews}
            me={me}
            canReview={detail.canWrite}
          />
        )}
      </RegionContent>
      {detail.canWrite ? <DuplicateButton org={org} recordId={record.id} /> : null}
      {record.deletedAt ? null : (
        <ArchiveControls
          org={org}
          entity="records"
          id={record.id}
          archivedAt={record.archivedAt}
          canWrite={detail.canArchive}
        />
      )}
      {detail.canWrite || record.deletedAt ? <TrashControls org={org} record={record} /> : null}
    </div>
  );
}

/** The governance kinds each Document subtype takes (B15); other subtypes show no entry. */
const GOVERNANCE_KINDS: Readonly<
  Record<string, readonly ("event_plan" | "waste_plan" | "event_brief" | "approval_pack")[]>
> = {
  Plan: ["event_plan", "waste_plan"],
  Brief: ["event_brief"],
  Package: ["approval_pack"],
};

function GovernanceDraft({ record }: { record: RecordSummary }) {
  const kinds = GOVERNANCE_KINDS[record.subtype ?? ""];
  const first = kinds?.[0];
  if (!kinds || !first) return null;
  return (
    <DraftEntry
      kind={first}
      kinds={kinds}
      target={{ collection: "records", id: record.id }}
      fields={{ body: "body" }}
      context={[]}
      maxBody={100000}
    />
  );
}
