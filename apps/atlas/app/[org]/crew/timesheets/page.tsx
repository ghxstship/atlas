import {
  getTimesheet,
  listTimesheets,
  personNames,
  TIMESHEET_STATES,
  workedMinutes,
  type Timesheet,
} from "@xos/data/crew";
import Link from "next/link";
import type { Route } from "next";
import { getFormatter } from "next-intl/server";
import {
  createTimesheetAction,
  decideTimesheetAction,
  submitTimesheetAction,
} from "@/app/[org]/crew/actions";
import { ConfirmButton, DrawerForm } from "@/components/crew/forms";
import { CrewFrame, resolveView } from "@/components/crew/frame";
import { CrewRecord } from "@/components/crew/record";
import { InlineAlert } from "@/components/crew/ui";
import { FilterSelect, PeekBoard, PeekTable } from "@/components/crew/views";
import { ButtonLink, EmptyStateLink } from "@/components/ui";
import {
  flatParams,
  getCrewContext,
  getMembers,
  getProjects,
  withParams,
} from "@/lib/crew/context";
import { stateIcon } from "@/lib/crew/states";
import { addDays, hoursFromMinutes, mondayOf } from "@/lib/crew/time";
import { nodeHref } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";

/**
 * Crew > Timesheets (Section 4.5.5): a person's time on a project for a period, with hours derived
 * from the entries. The worker submits; an approver who is neither the worker nor the submitter
 * approves or rejects (invariant 18); a change to the hours after approval voids it (invariant 19).
 */
export default async function Page({ params, searchParams }: PageProps<"/[org]/crew/timesheets">) {
  const routeParams = await params;
  const search = flatParams(await searchParams);
  const node = "crew.timesheets";
  const crew = await getCrewContext(node, routeParams);
  const t = await getTranslate();
  const format = await getFormatter();
  const db = crew.ctx.viewer.db;
  const view = resolveView(node, search["view"]);
  const base = nodeHref(node, routeParams) ?? "/";
  const projects = await getProjects(crew.ctx);
  const projectFilter = projects.find((p) => p.key === search["project"]) ?? null;
  const stateFilter = TIMESHEET_STATES.find((s) => s === search["state"]);
  const result = await listTimesheets(db, {
    orgId: crew.orgId,
    ...(projectFilter ? { projectId: projectFilter.id } : {}),
    ...(stateFilter ? { states: [stateFilter] } : {}),
  });
  if (!result.ok) throw new Error(`Cannot list timesheets: ${result.error.kind}`);
  const sheets = result.data;
  const canApprove = crew.can("crew.timesheet.approve");
  const canSubmitOthers = crew.canAll("crew.timesheet.submit");
  const name = (s: Timesheet) => s.member.name ?? t("crew.common.unnamed");
  const period = (s: Timesheet) =>
    format.dateTimeRange(
      new Date(`${s.periodStart}T12:00:00Z`),
      new Date(`${s.periodEnd}T12:00:00Z`),
      {
        timeZone: "UTC",
        month: "short",
        day: "numeric",
      },
    );
  const hours = (s: Timesheet) => format.number(hoursFromMinutes(s.workedMinutes));
  const peekHref = (id: string) => withParams(base, search, { peek: id, full: null });

  let peek = null;
  if (search["peek"]) {
    const detail = await getTimesheet(db, search["peek"]);
    if (detail.ok) {
      const s = detail.data;
      const zone = projects.find((p) => p.id === s.projectId)?.timeZone ?? "UTC";
      const own = s.member.membershipId === crew.membershipId;
      const approvers = await personNames(
        db,
        s.approvals.map((a) => a.approvedBy),
      );
      const hidden = { org: crew.slug, id: s.id };
      const record = (
        <CrewRecord
          crew={crew}
          mode={search["full"] === "1" ? "full" : "peek"}
          subject={{ table: "app.timesheets", id: s.id }}
          kindLabel={t("crew.kinds.timesheet")}
          recordKey={s.projectKey}
          title={t("crew.sheets.title", { name: name(s), hours: hours(s) })}
          state={stateIcon("timesheet", s.state)}
          stateLabel={t(`crew.states.timesheet.${s.state}`)}
          stateName={(v) => t(`crew.states.timesheet.${v}`)}
          history={s.transitions}
          backHref={withParams(base, search, { peek: null, full: null })}
          actions={
            <>
              {(s.state === "Proposed" || s.state === "Rejected") && (own || canSubmitOthers) ? (
                <ConfirmButton
                  label={t("crew.sheets.submit")}
                  title={t("crew.sheets.submitTitle")}
                  defaultReason={t("crew.sheets.submitReason")}
                  action={submitTimesheetAction}
                  hidden={hidden}
                  variant="primary"
                />
              ) : null}
              {s.state === "Submitted" && canApprove && !own ? (
                <>
                  <ConfirmButton
                    label={t("crew.swapsPage.approve")}
                    title={t("crew.sheets.approveTitle", { hours: hours(s) })}
                    defaultReason={t("crew.sheets.approveReason")}
                    action={decideTimesheetAction}
                    hidden={{ ...hidden, decision: "Approved" }}
                    variant="primary"
                  />
                  <ConfirmButton
                    label={t("crew.swapsPage.reject")}
                    title={t("crew.sheets.rejectTitle")}
                    defaultReason={t("crew.sheets.rejectReason")}
                    action={decideTimesheetAction}
                    hidden={{ ...hidden, decision: "Rejected" }}
                  />
                </>
              ) : null}
            </>
          }
          properties={[
            { label: t("crew.fields.person"), value: name(s) },
            { label: t("crew.fields.project"), value: s.projectKey },
            { label: t("crew.sheets.period"), value: period(s) },
            { label: t("crew.fields.hours"), value: hours(s) },
          ]}
        >
          {s.hasOpenEntry ? (
            <InlineAlert tone="warning" title={t("crew.sheets.openTitle")}>
              {t("crew.sheets.openBody")}
            </InlineAlert>
          ) : null}
          {s.approvals.some((a) => a.voidedAt !== null) ? (
            <InlineAlert tone="info" title={t("crew.sheets.voidedTitle")}>
              {t("crew.sheets.voidedBody")}
            </InlineAlert>
          ) : null}
          <PeekTable
            caption={t("crew.sheets.entries")}
            activatable={false}
            columns={[
              { key: "day", label: t("crew.sheets.day") },
              { key: "in", label: t("crew.entries.clockIn") },
              { key: "out", label: t("crew.entries.clockOut") },
              { key: "break", label: t("crew.entries.break"), type: "number" },
              { key: "hours", label: t("crew.fields.hours"), type: "number" },
            ]}
            rows={s.entries.map((e) => ({
              id: e.id,
              day: format.dateTime(new Date(e.clockIn), {
                timeZone: zone,
                weekday: "short",
                month: "short",
                day: "numeric",
              }),
              in: format.dateTime(new Date(e.clockIn), { timeZone: zone, timeStyle: "short" }),
              out: e.clockOut
                ? format.dateTime(new Date(e.clockOut), { timeZone: zone, timeStyle: "short" })
                : t("crew.time.clockedIn"),
              break: e.breakMinutes,
              hours: workedMinutes(e) === null ? null : hoursFromMinutes(workedMinutes(e) ?? 0),
            }))}
            totals={{ hours: hoursFromMinutes(s.workedMinutes) }}
            totalsLabel={t("crew.sheets.total")}
          />
          {s.approvals.length > 0 ? (
            <section aria-labelledby="sheet-approvals" className="flex flex-col gap-8">
              <h2 id="sheet-approvals" className="m-0 text-text-13 font-semibold">
                {t("crew.sheets.approvals")}
              </h2>
              <ul className="m-0 flex list-none flex-col gap-4 p-0 text-text-12">
                {s.approvals.map((a) => (
                  <li key={a.id}>
                    {t(a.voidedAt ? "crew.sheets.approvalVoided" : "crew.sheets.approvalStands", {
                      name:
                        (approvers.ok ? approvers.data.get(a.approvedBy) : null) ??
                        t("crew.record.someone"),
                      hours: format.number(hoursFromMinutes(a.approvedMinutes)),
                    })}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </CrewRecord>
      );
      if (search["full"] === "1") return record;
      peek = record;
    } else if (detail.error.kind !== "not-found") {
      throw new Error(`Cannot read timesheet: ${detail.error.kind}`);
    }
  }

  const canCreate = crew.can("crew.timesheet.submit");
  const members = canSubmitOthers ? await getMembers(crew.ctx) : [];
  const week = mondayOf(new Date().toISOString().slice(0, 10));
  const defaultProject = projectFilter ?? projects[0] ?? null;
  const drawer =
    search["create"] === "1" && canCreate && defaultProject ? (
      <DrawerForm
        title={t("crew.sheets.createTitle")}
        submitLabel={t("crew.sheets.create")}
        action={createTimesheetAction}
        fields={[
          { kind: "hidden", name: "org", value: crew.slug },
          {
            kind: "select",
            name: "projectId",
            label: t("crew.fields.project"),
            value: defaultProject.id,
            options: projects.map((p) => ({ value: p.id, label: `${p.key} · ${p.name}` })),
          },
          canSubmitOthers
            ? {
                kind: "select",
                name: "membershipId",
                label: t("crew.fields.person"),
                value: crew.membershipId,
                options: members.map((m) => ({
                  value: m.membershipId,
                  label: m.name ?? t("crew.common.unnamed"),
                })),
              }
            : { kind: "hidden", name: "membershipId", value: crew.membershipId },
          {
            kind: "date",
            name: "periodStart",
            label: t("crew.sheets.periodStart"),
            value: week,
            required: true,
          },
          {
            kind: "date",
            name: "periodEnd",
            label: t("crew.sheets.periodEnd"),
            value: addDays(week, 6),
            required: true,
          },
        ]}
      />
    ) : null;

  let body;
  if (sheets.length === 0) {
    body = (
      <EmptyStateLink
        icon="ClipboardCheck"
        sentence={canCreate ? t("crew.sheets.emptyWriter") : t("crew.sheets.emptyReader")}
        actionLabel={canCreate ? t("crew.sheets.create") : t("crew.sheets.viewEntries")}
        href={
          canCreate ? withParams(base, search, { create: "1" }) : `/${crew.slug}/crew/time-entries`
        }
      />
    );
  } else if (view === "board") {
    body = (
      <PeekBoard
        columns={TIMESHEET_STATES.map((st) => ({
          state: stateIcon("timesheet", st),
          label: t(`crew.states.timesheet.${st}`),
          cards: sheets
            .filter((s) => s.state === st)
            .map((s) => ({
              key: s.id,
              title: t("crew.sheets.title", { name: name(s), hours: hours(s) }),
              meta: `${s.projectKey} · ${period(s)}`,
            })),
        }))}
      />
    );
  } else if (view === "list") {
    body = (
      <ul
        aria-label={t("crew.sheets.caption")}
        className="m-0 flex list-none flex-col divide-y divide-border-subtle rounded-card border border-border-subtle p-0"
      >
        {sheets.map((s) => (
          <li key={s.id}>
            <Link
              href={peekHref(s.id) as Route}
              className="flex flex-wrap items-center justify-between gap-8 px-12 py-8 hover:bg-bg-hover"
            >
              <span className="flex flex-col">
                <span className="text-text-13 font-medium">
                  {t("crew.sheets.title", { name: name(s), hours: hours(s) })}
                </span>
                <span className="text-text-12 text-text-secondary">
                  {t("crew.common.pair", { a: s.projectKey, b: period(s) })}
                </span>
              </span>
              <span className="text-text-12 text-text-secondary">
                {t(`crew.states.timesheet.${s.state}`)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    );
  } else {
    body = (
      <PeekTable
        caption={t("crew.sheets.caption")}
        columns={[
          { key: "person", label: t("crew.fields.person") },
          { key: "project", label: t("crew.fields.project"), type: "code" },
          { key: "period", label: t("crew.sheets.period") },
          { key: "hours", label: t("crew.fields.hours"), type: "number" },
          { key: "state", label: t("crew.fields.state"), type: "state" },
        ]}
        rows={sheets.map((s) => ({
          id: s.id,
          person: name(s),
          project: s.projectKey,
          period: period(s),
          hours: hoursFromMinutes(s.workedMinutes),
          state: {
            state: stateIcon("timesheet", s.state),
            label: t(`crew.states.timesheet.${s.state}`),
          },
        }))}
      />
    );
  }

  const waiting = sheets.filter((s) => s.state === "Submitted").length;
  return (
    <CrewFrame
      crew={crew}
      node={node}
      module="crew"
      params={routeParams}
      search={search}
      count={sheets.length}
      view={view}
      {...(canCreate && projects.length > 0
        ? {
            actions: (
              <ButtonLink
                href={withParams(base, search, { create: "1" })}
                variant="primary"
                size="sm"
              >
                {t("crew.sheets.create")}
              </ButtonLink>
            ),
          }
        : {})}
      filters={
        <>
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
            name="state"
            label={t("crew.fields.state")}
            value={stateFilter ?? ""}
            options={[
              { value: "", label: t("crew.common.allStates") },
              ...TIMESHEET_STATES.map((v) => ({
                value: v,
                label: t(`crew.states.timesheet.${v}`),
              })),
            ]}
          />
        </>
      }
      peek={
        <>
          {peek}
          {drawer}
        </>
      }
    >
      {canApprove && waiting > 0 ? (
        <InlineAlert tone="info" title={t("crew.sheets.waitingTitle", { count: waiting })}>
          {t("crew.sheets.waitingBody")}
        </InlineAlert>
      ) : null}
      {body}
    </CrewFrame>
  );
}
