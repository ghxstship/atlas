import { startOfDayIn, todayIn } from "@xos/data/calendar";
import { getTimeEntry, listTimeEntries, workedMinutes, type TimeEntry } from "@xos/data/crew";
import Link from "next/link";
import type { Route } from "next";
import { getFormatter } from "next-intl/server";
import {
  createTimeEntryAction,
  decideCorrectionAction,
  requestCorrectionAction,
  updateTimeEntryAction,
  voidTimeEntryAction,
} from "@/app/[org]/crew/actions";
import { ConfirmButton } from "@/components/crew/forms-confirm-button";
import { DrawerForm } from "@/components/crew/forms-drawer-form";
import { type FieldSpec } from "@/components/crew/forms.types";
import { CrewFrame, resolveView } from "@/components/crew/frame";
import { CrewRecord } from "@/components/crew/record";
import { FilterSelect } from "@/components/crew/views-filter-select";
import { PeekTable } from "@/components/crew/views-peek-table";
import { collectionPeek } from "@/components/shell/collection-peek";
import { ButtonLink, EmptyStateLink } from "@/components/ui";
import {
  flatParams,
  getCrewContext,
  getMembers,
  getProjects,
  withParams,
} from "@/lib/crew/context";
import { stateIcon } from "@/lib/crew/states";
import { addDays, hoursFromMinutes, isIsoDate, isoToZoned, weekStartOf } from "@/lib/crew/time";
import { getShellSettings } from "@/lib/shell/org-settings";
import { peekRowMissing } from "@/lib/shell/peek-handoff";
import { nodeHref } from "@/lib/shell/sitemap";
import { getOrgTimeZone } from "@/lib/shell/time-zone";
import { getTranslate } from "@/lib/shell/translate";

/**
 * Crew > Time Entries (Section 4.5.5): punches by week in table and list views. Supervisors record
 * and edit entries (every change audited, approvals of the timesheet voided, invariant 19); anyone
 * may request a correction, which a time approver other than the requester decides.
 */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/crew/time-entries">) {
  const routeParams = await params;
  const search = flatParams(await searchParams);
  const node = "crew.time-entries";
  const crew = await getCrewContext(node, routeParams);
  const t = await getTranslate();
  const format = await getFormatter();
  const db = crew.ctx.viewer.db;
  const view = resolveView(node, search["view"]);
  const base = nodeHref(node, routeParams) ?? "/";
  const { preferences } = await getShellSettings(db, crew.orgId, null);
  const projects = await getProjects(crew.ctx);
  const projectFilter = projects.find((p) => p.key === search["project"]) ?? null;
  const zoneOf = (projectId: string) => projects.find((p) => p.id === projectId)?.timeZone ?? "UTC";
  // This week on the project's calendar, or the org's across projects (A71), never UTC's. A list to read,
  // so it starts on the viewer's first day (payroll.week_start as resolved for them: their own, else the
  // org's); timesheets and the schedule's weekly hours use the org's payroll week (getOrgWeekStart).
  const weekZone = projectFilter?.timeZone ?? (await getOrgTimeZone(crew.ctx));
  const week = weekStartOf(
    isIsoDate(search["week"]) ? search["week"] : todayIn(weekZone),
    preferences.weekStart,
  );
  const result = await listTimeEntries(db, {
    orgId: crew.orgId,
    from: startOfDayIn(week, weekZone),
    to: startOfDayIn(addDays(week, 7), weekZone),
    ...(projectFilter ? { projectId: projectFilter.id } : {}),
    ...(search["open"] === "1" ? { openOnly: true } : {}),
  });
  if (!result.ok) throw new Error(`Cannot list time entries: ${result.error.kind}`);
  const entries = result.data;
  const canWrite = crew.canAll("crew.time_entry.write");
  const canApprove = crew.can("crew.timesheet.approve");
  const name = (e: TimeEntry) => e.member.name ?? t("crew.common.unnamed");
  const at = (iso: string, zone: string) =>
    format.dateTime(new Date(iso), {
      timeZone: zone,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  const lifecycle = (e: TimeEntry) => (e.clockOut === null ? "Open" : "Closed");
  const peekHref = (id: string) => withParams(base, search, { peek: id, full: null });

  let peek = null;
  let editing: TimeEntry | null = null;
  if (search["peek"] || search["edit"] || search["correct"]) {
    const id = search["peek"] ?? search["edit"] ?? search["correct"] ?? "";
    const detail = await getTimeEntry(db, id);
    if (detail.ok) {
      const e = detail.data;
      editing = e;
      const zone = zoneOf(e.projectId);
      const mine = e.member.membershipId === crew.membershipId;
      const pending = e.corrections.filter((c) => c.state === "Proposed");
      if (search["peek"]) {
        const record = (
          <CrewRecord
            crew={crew}
            mode={search["full"] === "1" ? "full" : "peek"}
            subject={{ table: "app.time_entries", id: e.id }}
            kindLabel={t("crew.kinds.entry")}
            recordKey={e.projectKey}
            title={t("crew.entries.title", { name: name(e), day: at(e.clockIn, zone) })}
            state={stateIcon("entry", lifecycle(e))}
            stateLabel={t(`crew.states.entry.${lifecycle(e)}`)}
            backHref={withParams(base, search, { peek: null, full: null })}
            actions={
              <>
                {canWrite ? (
                  <ButtonLink
                    href={withParams(base, search, { peek: null, full: null, edit: e.id })}
                    size="sm"
                  >
                    {t("crew.common.edit")}
                  </ButtonLink>
                ) : null}
                {canWrite || mine ? (
                  <ButtonLink
                    href={withParams(base, search, { peek: null, full: null, correct: e.id })}
                    size="sm"
                  >
                    {t("crew.entries.requestCorrection")}
                  </ButtonLink>
                ) : null}
                {canWrite ? (
                  <ConfirmButton
                    label={t("crew.entries.void")}
                    title={t("crew.entries.voidTitle")}
                    description={t("crew.entries.voidHelp")}
                    defaultReason={t("crew.entries.voidReason")}
                    reason={false}
                    action={voidTimeEntryAction}
                    hidden={{ org: crew.slug, id: e.id }}
                    variant="danger"
                  />
                ) : null}
              </>
            }
            properties={[
              { label: t("crew.fields.person"), value: name(e) },
              { label: t("crew.fields.project"), value: e.projectKey },
              { label: t("crew.entries.clockIn"), value: at(e.clockIn, zone) },
              {
                label: t("crew.entries.clockOut"),
                value: e.clockOut ? at(e.clockOut, zone) : t("crew.time.clockedIn"),
              },
              {
                label: t("crew.entries.break"),
                value: t("crew.entries.minutes", { count: e.breakMinutes }),
              },
              {
                label: t("crew.fields.hours"),
                value:
                  workedMinutes(e) === null
                    ? t("crew.time.clockedIn")
                    : format.number(hoursFromMinutes(workedMinutes(e) ?? 0)),
              },
              { label: t("crew.entries.source"), value: t(`crew.entries.sources.${e.source}`) },
              ...(e.shiftId
                ? [
                    {
                      label: t("crew.kinds.shift"),
                      value: (
                        <Link
                          href={`/${crew.slug}/crew/shifts?peek=${e.shiftId}` as Route}
                          className="text-accent-text underline"
                        >
                          {t("crew.swapsPage.openShift")}
                        </Link>
                      ),
                    },
                  ]
                : []),
            ]}
          >
            {e.corrections.length > 0 ? (
              <section aria-labelledby="entry-corrections" className="flex flex-col gap-8">
                <h2 id="entry-corrections" className="m-0 text-text-13 font-semibold">
                  {t("crew.entries.corrections")}
                </h2>
                <ul className="m-0 flex list-none flex-col gap-8 p-0">
                  {e.corrections.map((c) => (
                    <li
                      key={c.id}
                      className="flex flex-col gap-4 rounded-card border border-border-subtle p-8 text-text-12"
                    >
                      <span>
                        {t("crew.entries.correctionTo", {
                          start: at(c.clockIn, zone),
                          end: c.clockOut ? at(c.clockOut, zone) : t("crew.time.clockedIn"),
                          minutes: c.breakMinutes,
                        })}
                      </span>
                      <span className="text-text-secondary">{c.reason}</span>
                      <span className="text-text-tertiary">
                        {t(`crew.states.correction.${c.state}`)}
                      </span>
                      {c.state === "Proposed" && canApprove ? (
                        <span className="flex gap-8">
                          <ConfirmButton
                            label={t("crew.swapsPage.approve")}
                            title={t("crew.entries.approveCorrection")}
                            defaultReason={t("crew.entries.approveCorrectionReason")}
                            action={decideCorrectionAction}
                            hidden={{ org: crew.slug, id: c.id, decision: "Approved" }}
                            variant="primary"
                          />
                          <ConfirmButton
                            label={t("crew.swapsPage.reject")}
                            title={t("crew.entries.rejectCorrection")}
                            defaultReason={t("crew.entries.rejectCorrectionReason")}
                            action={decideCorrectionAction}
                            hidden={{ org: crew.slug, id: c.id, decision: "Rejected" }}
                          />
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {pending.length > 0 && !canApprove ? (
              <p className="m-0 text-text-12 text-text-secondary">
                {t("crew.entries.pendingNote")}
              </p>
            ) : null}
            <section aria-labelledby="entry-audit" className="flex flex-col gap-8">
              <h2 id="entry-audit" className="m-0 text-text-13 font-semibold">
                {t("crew.entries.audit")}
              </h2>
              <ol className="m-0 flex list-none flex-col gap-4 p-0 text-text-12">
                {e.audit.map((a) => (
                  <li key={a.id} className="border-s border-border-subtle ps-8">
                    {a.before === null
                      ? t("crew.entries.auditCreated")
                      : t("crew.entries.auditChanged")}
                    {" · "}
                    {format.dateTime(new Date(a.at), { dateStyle: "medium", timeStyle: "short" })}
                  </li>
                ))}
              </ol>
            </section>
          </CrewRecord>
        );
        if (search["full"] === "1") return record;
        peek = record;
      }
    } else if (!peekRowMissing(detail.error)) {
      throw new Error(`Cannot read time entry: ${detail.error.kind}`);
    }
  }

  const members = canWrite ? await getMembers(crew.ctx) : [];
  const timeFields = (e: TimeEntry | null, zone: string): FieldSpec[] => [
    {
      kind: "datetime",
      name: "clockIn",
      label: t("crew.entries.clockInZone", { zone }),
      value: e ? isoToZoned(e.clockIn, zone) : `${week}T08:00`,
      required: true,
    },
    {
      kind: "datetime",
      name: "clockOut",
      label: t("crew.entries.clockOutZone", { zone }),
      value: e?.clockOut ? isoToZoned(e.clockOut, zone) : "",
      help: t("crew.entries.clockOutHelp"),
    },
    {
      kind: "number",
      name: "breakMinutes",
      label: t("crew.entries.breakMinutes"),
      value: String(e?.breakMinutes ?? 0),
      min: "0",
      step: "1",
    },
  ];
  const defaultProject = projectFilter ?? projects[0] ?? null;
  let drawer = null;
  if (search["create"] === "1" && canWrite && defaultProject) {
    drawer = (
      <DrawerForm
        title={t("crew.entries.createTitle")}
        submitLabel={t("crew.entries.create")}
        action={createTimeEntryAction}
        fields={[
          { kind: "hidden", name: "org", value: crew.slug },
          { kind: "hidden", name: "timeZone", value: defaultProject.timeZone },
          {
            kind: "select",
            name: "projectId",
            label: t("crew.fields.project"),
            value: defaultProject.id,
            options: projects.map((p) => ({ value: p.id, label: `${p.key} · ${p.name}` })),
          },
          {
            kind: "select",
            name: "membershipId",
            label: t("crew.fields.person"),
            options: members.map((m) => ({
              value: m.membershipId,
              label: m.name ?? t("crew.common.unnamed"),
            })),
          },
          ...timeFields(null, defaultProject.timeZone),
        ]}
      />
    );
  } else if (search["edit"] && editing && canWrite) {
    const zone = zoneOf(editing.projectId);
    drawer = (
      <DrawerForm
        title={t("crew.entries.editTitle")}
        submitLabel={t("crew.common.save")}
        action={updateTimeEntryAction}
        fields={[
          { kind: "hidden", name: "org", value: crew.slug },
          { kind: "hidden", name: "id", value: editing.id },
          { kind: "hidden", name: "timeZone", value: zone },
          ...timeFields(editing, zone),
        ]}
      />
    );
  } else if (search["correct"] && editing) {
    const zone = zoneOf(editing.projectId);
    drawer = (
      <DrawerForm
        title={t("crew.entries.correctTitle")}
        submitLabel={t("crew.entries.requestCorrection")}
        action={requestCorrectionAction}
        openKeys={["correct"]}
        fields={[
          { kind: "hidden", name: "org", value: crew.slug },
          { kind: "hidden", name: "id", value: editing.id },
          { kind: "hidden", name: "timeZone", value: zone },
          ...timeFields(editing, zone),
          {
            kind: "textarea",
            name: "reason",
            label: t("crew.entries.correctReason"),
            required: true,
          },
        ]}
      />
    );
  }

  const totalMinutes = entries.reduce((sum, e) => sum + (workedMinutes(e) ?? 0), 0);
  let body;
  if (entries.length === 0) {
    body = (
      <EmptyStateLink
        icon="Clock"
        sentence={canWrite ? t("crew.entries.emptyWriter") : t("crew.entries.emptyReader")}
        actionLabel={canWrite ? t("crew.entries.create") : t("crew.swapsPage.viewShifts")}
        href={canWrite ? withParams(base, search, { create: "1" }) : `/${crew.slug}/crew/shifts`}
        secondary={canWrite && projects.length > 0}
      />
    );
  } else if (view === "list") {
    body = (
      <ul
        aria-label={t("crew.entries.caption")}
        className="m-0 flex list-none flex-col divide-y divide-border-subtle rounded-card border border-border-subtle p-0"
      >
        {entries.map((e) => (
          <li key={e.id}>
            <Link
              href={peekHref(e.id) as Route}
              className="flex flex-wrap items-center justify-between gap-8 px-12 py-8 hover:bg-bg-hover"
            >
              <span className="flex flex-col">
                <span className="text-text-13 font-medium">{name(e)}</span>
                <span className="text-text-12 text-text-secondary">
                  {t("crew.common.range", {
                    start: at(e.clockIn, zoneOf(e.projectId)),
                    end: e.clockOut
                      ? at(e.clockOut, zoneOf(e.projectId))
                      : t("crew.time.clockedIn"),
                  })}
                </span>
              </span>
              <span className="text-text-12 tabular-nums text-text-secondary">
                {workedMinutes(e) === null
                  ? t("crew.time.clockedIn")
                  : format.number(hoursFromMinutes(workedMinutes(e) ?? 0))}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    );
  } else {
    body = (
      <PeekTable
        caption={t("crew.entries.caption")}
        columns={[
          { key: "person", label: t("crew.fields.person") },
          { key: "project", label: t("crew.fields.project"), type: "code" },
          { key: "in", label: t("crew.entries.clockIn") },
          { key: "out", label: t("crew.entries.clockOut") },
          { key: "break", label: t("crew.entries.break"), type: "number" },
          { key: "hours", label: t("crew.fields.hours"), type: "number" },
          { key: "state", label: t("crew.fields.state"), type: "state" },
        ]}
        rows={entries.map((e) => ({
          id: e.id,
          person: name(e),
          project: e.projectKey,
          in: at(e.clockIn, zoneOf(e.projectId)),
          out: e.clockOut ? at(e.clockOut, zoneOf(e.projectId)) : t("crew.time.clockedIn"),
          break: e.breakMinutes,
          hours: workedMinutes(e) === null ? null : hoursFromMinutes(workedMinutes(e) ?? 0),
          state: {
            state: stateIcon("entry", lifecycle(e)),
            label: t(`crew.states.entry.${lifecycle(e)}`),
          },
        }))}
        totals={{ hours: hoursFromMinutes(totalMinutes) }}
        totalsLabel={t("crew.entries.weekTotal")}
      />
    );
  }

  return (
    <CrewFrame
      crew={crew}
      node={node}
      module="crew"
      params={routeParams}
      search={search}
      count={entries.length}
      view={view}
      {...(canWrite && projects.length > 0
        ? {
            actions: (
              <ButtonLink
                href={withParams(base, search, { create: "1" })}
                variant="primary"
                size="sm"
              >
                {t("crew.entries.create")}
              </ButtonLink>
            ),
          }
        : {})}
      filters={
        <>
          <nav aria-label={t("crew.shifts.weekNav")} className="flex items-center gap-4">
            <Link
              href={withParams(base, search, { week: addDays(week, -7), peek: null }) as Route}
              className="rounded-control px-8 py-4 text-text-12 text-text-secondary hover:bg-bg-hover"
            >
              {t("crew.shifts.prevWeek")}
            </Link>
            <span className="text-text-13 font-medium">
              {t("crew.shifts.weekOf", {
                date: format.dateTime(new Date(`${week}T12:00:00Z`), {
                  timeZone: "UTC",
                  dateStyle: "medium",
                }),
              })}
            </span>
            <Link
              href={withParams(base, search, { week: addDays(week, 7), peek: null }) as Route}
              className="rounded-control px-8 py-4 text-text-12 text-text-secondary hover:bg-bg-hover"
            >
              {t("crew.shifts.nextWeek")}
            </Link>
          </nav>
          <FilterSelect
            name="project"
            label={t("crew.fields.project")}
            value={projectFilter?.key ?? ""}
            options={[
              { value: "", label: t("crew.common.allProjects") },
              ...projects.map((p) => ({ value: p.key, label: `${p.key} · ${p.name}` })),
            ]}
          />
          <FilterSelect
            name="open"
            label={t("crew.fields.state")}
            value={search["open"] === "1" ? "1" : ""}
            options={[
              { value: "", label: t("crew.common.allStates") },
              { value: "1", label: t("crew.states.entry.Open") },
            ]}
          />
        </>
      }
      peek={
        <>
          {collectionPeek(search["peek"], peek)}
          {drawer}
        </>
      }
    >
      {body}
    </CrewFrame>
  );
}
