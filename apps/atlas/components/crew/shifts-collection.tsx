import {
  doubleBookings,
  getShift,
  getWageHourRule,
  listShifts,
  listTimeEntries,
  shiftMinutes,
  type Shift,
} from "@xos/data/crew";
import { startOfDayIn, todayIn } from "@xos/data/calendar";
import Link from "next/link";
import type { Route } from "next";
import { getFormatter } from "next-intl/server";
import { EmptyStateLink, ButtonLink } from "@/components/ui";
import { collectionPeek } from "@/components/shell/collection-peek";
import {
  acceptShiftAction,
  awardShiftAction,
  claimShiftAction,
  decideClaimAction,
  withdrawClaimAction,
  clockInAction,
  clockOutAction,
  createShiftAction,
  publishShiftsAction,
  requestSwapAction,
  transitionShiftAction,
  trashShiftAction,
  updateShiftAction,
} from "@/app/[org]/crew/actions";
import {
  getCrewContext,
  getMembers,
  getProjects,
  getRoleTitles,
  withParams,
  type SearchParams,
} from "@/lib/crew/context";
import { stateIcon } from "@/lib/crew/states";
import {
  addDays,
  dayIn,
  hoursFromMinutes,
  isIsoDate,
  isoToZoned,
  weekStartOf,
} from "@/lib/crew/time";
import { getShellSettings } from "@/lib/shell/org-settings";
import { scheduleViewOf } from "@/components/work/format";
import { displayTimeZone } from "@xos/ui/preferences";
import { peekRowMissing } from "@/lib/shell/peek-handoff";
import { getOrgTimeZone, getOrgWeekStart } from "@/lib/shell/time-zone";
import { claimingRule, listShiftClaims } from "@xos/data/crew";
import { resolveSettings } from "@xos/data/settings";
import { nodeHref } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";
import { CrewFrame, resolveView } from "./frame";
import { ConfirmButton } from "./forms-confirm-button";
import { type FieldSpec } from "./forms.types";
import { CrewRecord } from "./record";
import { ScheduleGrid } from "./schedule-grid";
import { InlineAlert } from "./ui";
import { FilterSelect } from "./views-filter-select";
// The table and calendar views and the drawers render only in some states (A24-009).
import { DrawerForm, PeekCalendar, PeekTable, ShiftQuickAdd } from "./lazy";
import { LiveRefresh } from "@/components/live/live-refresh";

/**
 * Shifts in every view the registry offers (resource schedule, list, table, calendar), for the org
 * (Crew > Schedule and Crew > Shifts) and for one project (the project Crew tab). Planners create,
 * edit, publish and cancel shifts; the person assigned accepts; any crew member may claim a published
 * open shift; the person on a shift asks to swap it and clocks in from here or from Compass.
 */
export async function ShiftsCollection(props: {
  node: string;
  params: Readonly<Record<string, string>>;
  search: SearchParams;
}) {
  const { node, params, search } = props;
  const crew = await getCrewContext(node, params);
  const t = await getTranslate();
  const format = await getFormatter();
  const db = crew.ctx.viewer.db;
  const view = resolveView(node, search["view"]);
  const base = nodeHref(node, params) ?? "/";
  const [projects, roles] = await Promise.all([getProjects(crew.ctx), getRoleTitles(crew.ctx)]);
  const projectFilter = crew.project ?? projects.find((p) => p.key === search["project"]) ?? null;
  // The week and its bounds are on the project's calendar, or the org's across projects (A71): in UTC,
  // Sunday evening in New York already showed next week and a Sunday night shift left its week. The week
  // is the org's payroll week (its own payroll.week_start), the week payroll counts overtime over
  // (app.calculate_payroll_run, 1398), so the weekly hours and overtime warning match what is paid; a
  // person's own week start shapes their month calendars only.
  const zone = projectFilter?.timeZone ?? (await getOrgTimeZone(crew.ctx));
  const today = todayIn(zone);
  const { preferences, viewerTimeZone } = await getShellSettings(db, crew.orgId, null);
  // Shift times show in the event's zone or the viewer's own (me.time_zone_display), labeled with the zone.
  const zoneView = scheduleViewOf(preferences, viewerTimeZone);
  const shown = (s: Shift) =>
    displayTimeZone(s.timeZone, zoneView.display, zoneView.viewerZone) ?? s.timeZone;
  const week = weekStartOf(
    isIsoDate(search["week"]) ? search["week"] : today,
    await getOrgWeekStart(crew.ctx),
  );
  const monthStart = `${week.slice(0, 7)}-01`;
  const from = view === "calendar" ? monthStart : week;
  const to =
    view === "calendar"
      ? addDays(`${addDays(monthStart, 32).slice(0, 7)}-01`, 0)
      : addDays(week, 7);

  const stateFilter = ["Draft", "Published", "Accepted", "Canceled"].find(
    (s) => s === search["state"],
  );
  const result = await listShifts(db, {
    orgId: crew.orgId,
    from: startOfDayIn(from, zone),
    to: startOfDayIn(to, zone),
    ...(projectFilter ? { projectId: projectFilter.id } : {}),
    ...(stateFilter ? { states: [stateFilter as Shift["state"]] } : {}),
  });
  if (!result.ok) throw new Error(`Cannot list shifts: ${result.error.kind}`);
  const shifts = result.data;
  const canWrite = crew.can("crew.shift.write");
  const drafts = shifts.filter((s) => s.state === "Draft");

  const rules = new Map<string, number | null>();
  for (const p of projects) {
    const rule = await getWageHourRule(db, p.jurisdictionId);
    rules.set(p.id, rule.ok ? (rule.data?.weeklyOvertimeAfterHours ?? null) : null);
  }

  const peekHref = (id: string) => withParams(base, search, { peek: id, full: null });
  const roleName = (code: string | null) =>
    code === null ? t("crew.common.noRole") : (roles.get(code)?.title ?? code);
  const personName = (s: Shift) =>
    s.member ? (s.member.name ?? t("crew.common.unnamed")) : t("crew.shifts.open");
  const when = (s: Shift) =>
    t("crew.common.range", {
      start: format.dateTime(new Date(s.startsAt), {
        timeZone: shown(s),
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }),
      end: format.dateTime(new Date(s.endsAt), {
        timeZone: shown(s),
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }),
    });

  // A shift's hover card (Section 11.7): role and person, its project, state and time.
  const preview = (s: Shift) => ({
    recordKey: s.projectKey,
    recordKind: "Shift" as const,
    title: t("crew.common.pair", { a: roleName(s.roleCode), b: personName(s) }),
    state: stateIcon("shift", s.state),
    stateLabel: t(`crew.states.shift.${s.state}`),
    owner: personName(s),
    next: when(s),
  });

  // Peek and full record page.
  let peek = null;
  const peekId = search["peek"];
  if (peekId) {
    const detail = await getShift(db, peekId);
    if (detail.ok) {
      const s = detail.data;
      const mine = s.member !== null && s.member.membershipId === crew.membershipId;
      const entries = await listTimeEntries(db, { orgId: crew.orgId, shiftId: s.id });
      const myOpen = entries.ok
        ? entries.data.find(
            (e) => e.clockOut === null && e.member.membershipId === crew.membershipId,
          )
        : undefined;
      const hidden = { org: crew.slug, id: s.id };
      // The project's scheduling settings decide claims and swaps (1322).
      const scheduling = await resolveSettings(db, { orgId: crew.orgId, projectId: s.projectId });
      const rule = claimingRule(
        scheduling.ok ? scheduling.data.get("scheduling.open_shift_claiming")?.value : undefined,
      );
      const swapsAllowed =
        !scheduling.ok || scheduling.data.get("scheduling.allow_swaps")?.value !== false;
      const open = s.member === null && s.state === "Published";
      const claims = open ? await listShiftClaims(db, s.id) : null;
      const waiting = claims?.ok ? claims.data : [];
      const myClaim = waiting.find((c) => c.member.membershipId === crew.membershipId) ?? null;
      const actions = (
        <>
          {canWrite && s.state === "Draft" ? (
            <ConfirmButton
              label={t("crew.shifts.publish")}
              title={t("crew.shifts.publishTitle")}
              defaultReason={t("crew.shifts.publishReason")}
              action={transitionShiftAction}
              hidden={{ ...hidden, expected: "Draft", next: "Published" }}
              variant="primary"
            />
          ) : null}
          {canWrite && s.state === "Published" ? (
            <ConfirmButton
              label={t("crew.shifts.unpublish")}
              title={t("crew.shifts.unpublishTitle")}
              defaultReason={t("crew.shifts.unpublishReason")}
              action={transitionShiftAction}
              hidden={{ ...hidden, expected: "Published", next: "Draft" }}
            />
          ) : null}
          {mine && s.state === "Published" ? (
            <ConfirmButton
              label={t("crew.shifts.accept")}
              title={t("crew.shifts.acceptTitle")}
              defaultReason={t("crew.shifts.acceptReason")}
              action={acceptShiftAction}
              hidden={hidden}
              variant="primary"
            />
          ) : null}
          {open && !myClaim ? (
            <ConfirmButton
              label={t("crew.shifts.claim")}
              title={t("crew.shifts.claimTitle")}
              {...(rule === "first-come" ? {} : { description: t(`crew.claims.ruleHelp.${rule}`) })}
              defaultReason={t("crew.shifts.claimReason")}
              action={claimShiftAction}
              hidden={hidden}
              variant="primary"
            />
          ) : null}
          {myClaim ? (
            <ConfirmButton
              label={t("crew.claims.withdraw")}
              title={t("crew.claims.withdrawTitle")}
              defaultReason=""
              reason={false}
              action={withdrawClaimAction}
              hidden={{ org: crew.slug, id: myClaim.id }}
              variant="ghost"
            />
          ) : null}
          {canWrite && open && rule === "seniority" && waiting.length > 0 ? (
            <ConfirmButton
              label={t("crew.claims.award")}
              title={t("crew.claims.awardTitle")}
              defaultReason={t("crew.claims.awardReason")}
              action={awardShiftAction}
              hidden={hidden}
              variant="primary"
            />
          ) : null}
          {mine &&
          swapsAllowed &&
          (s.state === "Published" || s.state === "Accepted") &&
          crew.can("crew.swap.request") ? (
            <ButtonLink href={withParams(base, search, { swap: s.id })} size="sm">
              {t("crew.shifts.requestSwap")}
            </ButtonLink>
          ) : null}
          {mine && s.state === "Accepted" && !myOpen && crew.can("crew.time_entry.write") ? (
            <ConfirmButton
              label={t("crew.shifts.clockIn")}
              title={t("crew.shifts.clockInTitle")}
              defaultReason={t("crew.shifts.clockInReason")}
              reason={false}
              action={clockInAction}
              hidden={{ org: crew.slug, shiftId: s.id, projectId: s.projectId }}
              variant="primary"
            />
          ) : null}
          {myOpen ? (
            <ConfirmButton
              label={t("crew.shifts.clockOut")}
              title={t("crew.shifts.clockOutTitle")}
              defaultReason={t("crew.shifts.clockOutReason")}
              reason={false}
              action={clockOutAction}
              hidden={{ org: crew.slug, id: myOpen.id, breakMinutes: "0" }}
              variant="primary"
            />
          ) : null}
          {canWrite && s.state !== "Canceled" ? (
            <ButtonLink href={withParams(base, search, { edit: s.id })} size="sm">
              {t("crew.common.edit")}
            </ButtonLink>
          ) : null}
          {canWrite && s.state !== "Canceled" ? (
            <ConfirmButton
              label={t("crew.shifts.cancel")}
              title={t("crew.shifts.cancelTitle")}
              defaultReason={t("crew.shifts.cancelReason")}
              action={transitionShiftAction}
              hidden={{ ...hidden, expected: s.state, next: "Canceled" }}
              variant="danger"
            />
          ) : null}
          {canWrite ? (
            <ConfirmButton
              label={t("crew.common.trash")}
              title={t("crew.shifts.trashTitle")}
              description={t("crew.shifts.trashHelp")}
              defaultReason={t("crew.shifts.trashReason")}
              reason={false}
              action={trashShiftAction}
              hidden={{ ...hidden, back: withParams(base, search, { peek: null, full: null }) }}
              variant="ghost"
            />
          ) : null}
        </>
      );
      peek = (
        <CrewRecord
          crew={crew}
          mode={search["full"] === "1" ? "full" : "peek"}
          subject={{ table: "app.shifts", id: s.id }}
          kindLabel={t("crew.kinds.shift")}
          recordKey={s.projectKey}
          title={`${roleName(s.roleCode)} · ${personName(s)}`}
          state={stateIcon("shift", s.state)}
          stateLabel={t(`crew.states.shift.${s.state}`)}
          stateName={(v) => t(`crew.states.shift.${v}`)}
          history={s.transitions}
          backHref={withParams(base, search, { peek: null, full: null })}
          actions={actions}
          properties={[
            { label: t("crew.fields.project"), value: `${s.projectKey} · ${s.projectName}` },
            { label: t("crew.fields.person"), value: personName(s) },
            { label: t("crew.fields.role"), value: roleName(s.roleCode) },
            { label: t("crew.fields.when"), value: when(s) },
            { label: t("crew.fields.timeZone"), value: s.timeZone },
            {
              label: t("crew.fields.hours"),
              value: format.number(hoursFromMinutes(shiftMinutes(s))),
            },
          ]}
        >
          {myClaim ? (
            <p role="status" className="m-0 text-text-13 text-text-secondary">
              {t("crew.claims.waiting")}
            </p>
          ) : null}
          {canWrite && waiting.length > 0 ? (
            <section aria-labelledby="shift-claims" className="flex flex-col gap-8">
              <h2 id="shift-claims" className="m-0 text-text-13 font-semibold">
                {t("crew.claims.title")}
              </h2>
              <p className="m-0 text-text-12 text-text-secondary">
                {t(`crew.claims.ruleHelp.${rule}`)}
              </p>
              <ul className="m-0 flex list-none flex-col gap-8 p-0">
                {waiting.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center justify-between gap-8">
                    <span className="text-text-13">
                      {c.member.name ?? t("crew.common.unnamed")}
                    </span>
                    <span className="flex flex-wrap gap-8">
                      {rule === "approval" ? (
                        <ConfirmButton
                          label={t("crew.claims.approve")}
                          title={t("crew.claims.approveTitle", {
                            name: c.member.name ?? t("crew.common.unnamed"),
                          })}
                          defaultReason={t("crew.claims.approveReason")}
                          action={decideClaimAction}
                          hidden={{ org: crew.slug, id: c.id, decision: "Approved" }}
                          variant="primary"
                        />
                      ) : null}
                      <ConfirmButton
                        label={t("crew.claims.reject")}
                        title={t("crew.claims.rejectTitle", {
                          name: c.member.name ?? t("crew.common.unnamed"),
                        })}
                        defaultReason=""
                        action={decideClaimAction}
                        hidden={{ org: crew.slug, id: c.id, decision: "Rejected" }}
                      />
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {entries.ok && entries.data.length > 0 ? (
            <section aria-labelledby="shift-entries" className="flex flex-col gap-8">
              <h2 id="shift-entries" className="m-0 text-text-13 font-semibold">
                {t("crew.shifts.entries")}
              </h2>
              <ul className="m-0 flex list-none flex-col gap-4 p-0 text-text-12">
                {entries.data.map((e) => (
                  <li key={e.id}>
                    {format.dateTime(new Date(e.clockIn), {
                      timeZone: shown(s),
                      hour: "numeric",
                      minute: "2-digit",
                      timeZoneName: "short",
                    })}
                    {" · "}
                    {e.clockOut
                      ? format.dateTime(new Date(e.clockOut), {
                          timeZone: shown(s),
                          hour: "numeric",
                          minute: "2-digit",
                          timeZoneName: "short",
                        })
                      : t("crew.time.clockedIn")}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </CrewRecord>
      );
      if (search["full"] === "1") return peek;
    } else if (!peekRowMissing(detail.error)) {
      throw new Error(`Cannot read shift: ${detail.error.kind}`);
    }
  }

  // Create, edit and swap drawers.
  const members = canWrite || search["swap"] ? await getMembers(crew.ctx) : [];
  const editing = search["edit"] ? (shifts.find((s) => s.id === search["edit"]) ?? null) : null;
  const defaultProject = projectFilter ?? projects[0] ?? null;
  const shiftFields = (s: Shift | null): FieldSpec[] => {
    const zone = s?.timeZone ?? defaultProject?.timeZone ?? "UTC";
    return [
      { kind: "hidden", name: "org", value: crew.slug },
      ...(s ? [{ kind: "hidden" as const, name: "id", value: s.id }] : []),
      { kind: "hidden", name: "timeZone", value: zone },
      ...(s || crew.project
        ? [
            {
              kind: "hidden" as const,
              name: "projectId",
              value: s?.projectId ?? crew.project?.id ?? "",
            },
          ]
        : [
            {
              kind: "select" as const,
              name: "projectId",
              label: t("crew.fields.project"),
              value: defaultProject?.id ?? "",
              options: projects.map((p) => ({ value: p.id, label: `${p.key} · ${p.name}` })),
            },
          ]),
      {
        kind: "select",
        name: "roleCode",
        label: t("crew.fields.role"),
        value: s?.roleCode ?? "",
        options: [
          { value: "", label: t("crew.common.noRole") },
          ...[...roles.values()].map((r) => ({ value: r.code, label: `${r.code} · ${r.title}` })),
        ],
      },
      {
        kind: "select",
        name: "membershipId",
        label: t("crew.fields.person"),
        value: s?.member?.membershipId ?? "",
        help: t("crew.shifts.openHelp"),
        options: [
          { value: "", label: t("crew.shifts.open") },
          ...members.map((m) => ({
            value: m.membershipId,
            label: m.name ?? t("crew.common.unnamed"),
          })),
        ],
      },
      {
        kind: "datetime",
        name: "startsAt",
        label: t("crew.fields.startsAt", { zone }),
        value: s ? isoToZoned(s.startsAt, zone) : `${week}T08:00`,
        required: true,
      },
      {
        kind: "datetime",
        name: "endsAt",
        label: t("crew.fields.endsAt", { zone }),
        value: s ? isoToZoned(s.endsAt, zone) : `${week}T16:00`,
        required: true,
      },
    ];
  };
  const swapShift = search["swap"] ? (shifts.find((s) => s.id === search["swap"]) ?? null) : null;
  const drawer =
    search["create"] === "1" && canWrite && projects.length > 0 ? (
      <DrawerForm
        title={t("crew.shifts.createTitle")}
        submitLabel={t("crew.shifts.create")}
        action={createShiftAction}
        fields={shiftFields(null)}
        signal="atlas.crew:step1"
      />
    ) : editing && canWrite ? (
      <DrawerForm
        title={t("crew.shifts.editTitle")}
        submitLabel={t("crew.common.save")}
        action={updateShiftAction}
        fields={shiftFields(editing)}
      />
    ) : swapShift ? (
      <DrawerForm
        title={t("crew.swaps.requestTitle")}
        submitLabel={t("crew.swaps.request")}
        action={requestSwapAction}
        openKeys={["swap"]}
        fields={[
          { kind: "hidden", name: "org", value: crew.slug },
          { kind: "hidden", name: "shiftId", value: swapShift.id },
          { kind: "hidden", name: "projectId", value: swapShift.projectId },
          {
            kind: "select",
            name: "proposedMembershipId",
            label: t("crew.swaps.proposed"),
            options: members
              .filter((m) => m.membershipId !== crew.membershipId)
              .map((m) => ({ value: m.membershipId, label: m.name ?? t("crew.common.unnamed") })),
          },
        ]}
      />
    ) : null;

  // Warnings: double bookings and overtime risk before publishing.
  const clashes = doubleBookings(shifts);
  const actions = canWrite ? (
    <div className="flex flex-wrap gap-8">
      {drafts.length > 0 ? (
        <ConfirmButton
          label={t("crew.shifts.publishAll", { count: drafts.length })}
          title={t("crew.shifts.publishAllTitle", { count: drafts.length })}
          defaultReason={t("crew.shifts.publishReason")}
          action={publishShiftsAction}
          hidden={{ org: crew.slug, ids: drafts.map((d) => d.id).join(",") }}
          signal="atlas.crew:done"
        />
      ) : null}
      {projects.length > 0 ? (
        <ButtonLink href={withParams(base, search, { create: "1" })} variant="primary" size="sm">
          {t("crew.shifts.create")}
        </ButtonLink>
      ) : null}
    </div>
  ) : undefined;

  const weekNav = (
    <nav aria-label={t("crew.shifts.weekNav")} className="flex items-center gap-4">
      <Link
        href={
          withParams(base, search, {
            week: addDays(week, view === "calendar" ? -28 : -7),
            peek: null,
          }) as Route
        }
        className="rounded-control px-8 py-4 text-text-12 text-text-secondary hover:bg-bg-hover"
      >
        {t(view === "calendar" ? "crew.shifts.prevMonth" : "crew.shifts.prevWeek")}
      </Link>
      <span className="text-text-13 font-medium">
        {view === "calendar"
          ? format.dateTime(new Date(`${monthStart}T12:00:00Z`), {
              timeZone: "UTC",
              month: "long",
              year: "numeric",
            })
          : t("crew.shifts.weekOf", {
              date: format.dateTime(new Date(`${week}T12:00:00Z`), {
                timeZone: "UTC",
                dateStyle: "medium",
              }),
            })}
      </span>
      <Link
        href={
          withParams(base, search, {
            week: addDays(week, view === "calendar" ? 35 : 7),
            peek: null,
          }) as Route
        }
        className="rounded-control px-8 py-4 text-text-12 text-text-secondary hover:bg-bg-hover"
      >
        {t(view === "calendar" ? "crew.shifts.nextMonth" : "crew.shifts.nextWeek")}
      </Link>
    </nav>
  );

  const filters = (
    <>
      {weekNav}
      {crew.project ? null : (
        <FilterSelect
          name="project"
          label={t("crew.fields.project")}
          value={projectFilter?.key ?? ""}
          options={[
            { value: "", label: t("crew.common.allProjects") },
            ...projects.map((p) => ({ value: p.key, label: `${p.key} · ${p.name}` })),
          ]}
        />
      )}
      <FilterSelect
        name="state"
        label={t("crew.fields.state")}
        value={stateFilter ?? ""}
        options={[
          { value: "", label: t("crew.common.allStates") },
          ...["Draft", "Published", "Accepted", "Canceled"].map((v) => ({
            value: v,
            label: t(`crew.states.shift.${v}`),
          })),
        ]}
      />
    </>
  );

  let body;
  if (shifts.length === 0) {
    body = (
      <EmptyStateLink
        icon="CalendarClock"
        sentence={
          projects.length === 0
            ? t("crew.shifts.emptyNoProjects")
            : canWrite
              ? t("crew.shifts.emptyWriter")
              : t("crew.shifts.emptyReader")
        }
        actionLabel={
          projects.length === 0
            ? t("crew.shifts.goProjects")
            : canWrite
              ? t("crew.shifts.create")
              : t("crew.shifts.nextWeek")
        }
        href={
          projects.length === 0
            ? `/${crew.slug}/projects`
            : canWrite
              ? withParams(base, search, { create: "1" })
              : withParams(base, search, { week: addDays(week, 7) })
        }
      />
    );
  } else if (view === "resource-schedule") {
    body = (
      <ScheduleGrid
        shifts={shifts}
        weekStart={week}
        roleTitles={roles}
        peekHref={peekHref}
        label={t("crew.shifts.gridLabel")}
        overtimeHours={rules}
      />
    );
  } else if (view === "calendar") {
    body = (
      <PeekCalendar
        month={monthStart}
        today={today}
        events={shifts.map((s) => ({
          id: s.id,
          date: dayIn(s.startsAt, shown(s)),
          label: `${format.dateTime(new Date(s.startsAt), { timeZone: shown(s), hour: "numeric", minute: "2-digit", timeZoneName: "short" })} ${personName(s)}`,
          state: stateIcon("shift", s.state),
          preview: preview(s),
        }))}
      />
    );
  } else if (view === "table") {
    body = (
      <PeekTable
        caption={t("crew.shifts.tableCaption")}
        columns={[
          { key: "project", label: t("crew.fields.project"), type: "code" },
          { key: "person", label: t("crew.fields.person") },
          { key: "role", label: t("crew.fields.role") },
          { key: "when", label: t("crew.fields.when"), wrap: true },
          { key: "hours", label: t("crew.fields.hours"), type: "number" },
          { key: "state", label: t("crew.fields.state"), type: "state" },
        ]}
        rows={shifts.map((s) => ({
          id: s.id,
          label: t("crew.common.pair", { a: personName(s), b: when(s) }),
          project: s.projectKey,
          person: personName(s),
          role: roleName(s.roleCode),
          when: when(s),
          hours: hoursFromMinutes(shiftMinutes(s)),
          state: { state: stateIcon("shift", s.state), label: t(`crew.states.shift.${s.state}`) },
          preview: preview(s),
        }))}
        bulk={
          canWrite
            ? {
                org: crew.ctx.org.slug,
                resource: "shifts",
                fields: [
                  {
                    key: "shift_state",
                    label: t("crew.fields.state"),
                    reason: true,
                    options: (["Published", "Draft", "Canceled"] as const).map((state) => ({
                      value: state,
                      label: t(`crew.states.shift.${state}`),
                    })),
                  },
                  {
                    key: "membership_id",
                    label: t("crew.fields.person"),
                    options: [
                      { value: null, label: t("crew.shifts.open") },
                      ...members.map((m) => ({
                        value: m.membershipId,
                        label: m.name ?? m.membershipId,
                      })),
                    ],
                  },
                ],
              }
            : null
        }
      />
    );
  } else {
    body = (
      <ul
        aria-label={t("crew.shifts.listLabel")}
        className="m-0 flex list-none flex-col divide-y divide-border-subtle rounded-card border border-border-subtle p-0"
      >
        {shifts.map((s) => (
          <li key={s.id}>
            <Link
              href={peekHref(s.id) as Route}
              className="flex flex-wrap items-center justify-between gap-8 px-12 py-8 hover:bg-bg-hover"
            >
              <span className="flex flex-col">
                <span className="text-text-13 font-medium">
                  {t("crew.common.pair", { a: roleName(s.roleCode), b: personName(s) })}
                </span>
                <span className="text-text-12 text-text-secondary">
                  {t("crew.common.pair", { a: s.projectKey, b: when(s) })}
                </span>
              </span>
              <span className="text-text-12 text-text-secondary">
                {t(`crew.states.shift.${s.state}`)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <CrewFrame
      crew={crew}
      node={node}
      module="crew"
      params={params}
      search={search}
      count={shifts.length}
      view={view}
      {...(actions ? { actions } : {})}
      filters={filters}
      peek={
        <>
          {collectionPeek(search["peek"], peek)}
          {drawer}
        </>
      }
    >
      {/* Shifts update live as crew accept, swap and get assigned (Section 11.7, ADR 0044). */}
      <LiveRefresh topics={[{ table: "shifts", filter: `org_id=eq.${crew.orgId}` }]} />
      {clashes.length > 0 ? (
        <InlineAlert tone="warning" title={t("crew.shifts.clashTitle", { count: clashes.length })}>
          {t("crew.shifts.clashBody")}
        </InlineAlert>
      ) : null}
      {/* Quick add (Section 11.7): planners plan a shift from one line, in the filtered project. */}
      {canWrite && projects.length > 0 ? (
        <ShiftQuickAdd org={crew.slug} timeZone={zone} projectId={projectFilter?.id ?? null} />
      ) : null}
      {body}
    </CrewFrame>
  );
}
