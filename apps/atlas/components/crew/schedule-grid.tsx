import type { Shift } from "@xos/data/crew";
import type { DayType } from "@xos/data/schedule-days";
import type { LaneSlot, VendorLane, ZoneLane } from "@xos/data/resource-lanes";
import Link from "next/link";
import type { Route } from "next";
import { getFormatter } from "next-intl/server";
import { stateIcon } from "@/lib/crew/states";
import { addDays, dayIn, hoursFromMinutes } from "@/lib/crew/time";
import { getTranslate } from "@/lib/shell/translate";
import { Avatar, StateIcon } from "./ui";
import { DayTypeTags } from "@/components/schedule/day-type-tags";
import { ShiftDropIsland } from "./lazy-scheduling";

export type LaneMode = "people" | "vendors" | "zones";
export const LANE_MODES: readonly LaneMode[] = ["people", "vendors", "zones"];

/**
 * The resource schedule (Section 11.15: shifts default to it in Atlas): people down the side, the
 * week across, each shift a chip that opens its side peek. Open shifts sit on their own row. A day
 * with two shifts for one person is marked as a double booking, and weekly hours over the canon
 * wage-hour threshold of the project's jurisdiction are flagged so planners see overtime before they publish. It is a real table, so
 * it is its own accessible alternative.
 *
 * B4 (G-43): a Lanes control (server-rendered links, `lanes=`) switches the rows between people, suppliers (each
 * company's or contractor's engagement windows, engagement shifts and dock slots) and zones (dock slots and work
 * orders); supplier and zone lanes are read-only. A band under the dates names the projects' day types, prefixed with
 * project keys when several projects are in view. For planners, a person's row takes an open shift dragged from the
 * board (shift-drop.tsx), checked against that shift's ranking first.
 */
export async function ScheduleGrid(props: {
  shifts: readonly Shift[];
  weekStart: string;
  roleTitles: ReadonlyMap<string, { title: string }>;
  peekHref: (id: string) => string;
  label: string;
  /** Weekly overtime threshold in hours by project, from its canon wage-hour rule; null is no answer. */
  overtimeHours: ReadonlyMap<string, number | null>;
  /** B4: which lanes the rows are, and the link that shows each. */
  lanes?: LaneMode;
  laneHref?: (lane: LaneMode) => string;
  /** B4: each date's day-type tags, already named and prefixed. */
  dayTypes?: ReadonlyMap<string, { tags: { label: string; dayType: DayType }[]; more: number }>;
  vendorLanes?: readonly VendorLane[];
  zoneLanes?: readonly ZoneLane[];
  /** B4: planners drop an open shift from the board onto a person's row. */
  drop?: { org: string } | null;
}) {
  const lanes = props.lanes ?? "people";
  const t = await getTranslate();
  const format = await getFormatter();
  const days = Array.from({ length: 7 }, (_, i) => addDays(props.weekStart, i));
  type Row = { key: string; name: string; role: string; shifts: Shift[] };
  const rows = new Map<string, Row>();
  const open: Shift[] = [];
  for (const s of props.shifts) {
    if (!s.member) {
      open.push(s);
      continue;
    }
    const key = s.member.personId ?? s.member.membershipId;
    const row = rows.get(key) ?? {
      key,
      name: s.member.name ?? t("crew.common.unnamed"),
      role: s.roleCode ? (props.roleTitles.get(s.roleCode)?.title ?? s.roleCode) : "",
      shifts: [],
    };
    row.shifts.push(s);
    rows.set(key, row);
  }
  const people = [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (open.length > 0) {
    people.push({ key: "open", name: t("crew.shifts.openRow"), role: "", shifts: open });
  }

  const chip = (s: Shift) => {
    const live = s.state !== "Canceled";
    return (
      <Link
        key={s.id}
        href={props.peekHref(s.id) as Route}
        className={
          live
            ? "mb-2 flex items-center gap-4 rounded-chip bg-bg-hover px-6 py-2 text-text-12 text-text-primary hover:bg-bg-surface"
            : "mb-2 flex items-center gap-4 rounded-chip px-6 py-2 text-text-12 text-text-tertiary line-through"
        }
      >
        <StateIcon state={stateIcon("shift", s.state)} size={12} />
        <span className="tabular-nums">
          {format.dateTime(new Date(s.startsAt), { timeZone: s.timeZone, timeStyle: "short" })}
        </span>
        <span className="sr-only">
          {t("crew.shifts.chipLabel", {
            state: t(`crew.states.shift.${s.state}`),
            project: s.projectKey,
          })}
        </span>
      </Link>
    );
  };

  const gridId = "crew-resource-schedule";
  const slotChip = (slot: LaneSlot, kind: "dock" | "workOrder") => (
    <span
      key={slot.id}
      className="mb-2 flex items-center gap-4 rounded-chip bg-bg-hover px-6 py-2 text-text-12"
    >
      <span className="tabular-nums">
        {format.dateTime(new Date(slot.startsAt), { timeStyle: "short" })}
      </span>
      <span className="truncate">
        {t(kind === "dock" ? "crew.lanes.dockSlot" : "crew.lanes.workOrder", {
          label: slot.label,
          project: slot.projectKey,
        })}
      </span>
    </span>
  );
  const slotsOn = (list: readonly LaneSlot[], d: string) =>
    list.filter((x) => x.startsAt.slice(0, 10) === d);
  const band = props.dayTypes && props.dayTypes.size > 0 ? props.dayTypes : null;
  return (
    <div className="flex flex-col gap-8">
      {props.laneHref ? (
        <nav aria-label={t("crew.lanes.label")} className="flex flex-wrap gap-4">
          {LANE_MODES.map((mode) => (
            <Link
              key={mode}
              href={(props.laneHref as (l: LaneMode) => string)(mode) as Route}
              aria-current={mode === lanes ? "page" : undefined}
              className={
                mode === lanes
                  ? "rounded-control bg-bg-hover px-12 py-6 text-text-13 font-medium text-text-primary"
                  : "rounded-control px-12 py-6 text-text-13 text-text-secondary hover:bg-bg-hover"
              }
            >
              {t(`crew.lanes.${mode}`)}
            </Link>
          ))}
        </nav>
      ) : null}
      {props.drop && lanes === "people" ? (
        <ShiftDropIsland org={props.drop.org} weekStart={props.weekStart} gridId={gridId} />
      ) : null}
      <div
        id={gridId}
        role="region"
        aria-label={props.label}
        tabIndex={0}
        className="overflow-x-auto rounded-card border border-border-subtle"
      >
        <table className="w-full border-collapse text-text-13">
          <caption className="sr-only">{props.label}</caption>
          <thead>
            <tr>
              <th
                scope="col"
                className="h-control-lg border-b border-border-subtle bg-bg-surface px-12 text-start text-text-12 font-medium text-text-secondary"
              >
                {t(
                  lanes === "vendors"
                    ? "crew.lanes.vendor"
                    : lanes === "zones"
                      ? "crew.lanes.zone"
                      : "crew.shifts.person",
                )}
              </th>
              {days.map((d) => (
                <th
                  key={d}
                  scope="col"
                  className="h-control-lg border-b border-border-subtle bg-bg-surface px-12 text-start text-text-12 font-medium"
                >
                  {format.dateTime(new Date(`${d}T12:00:00Z`), {
                    timeZone: "UTC",
                    weekday: "short",
                    day: "numeric",
                  })}
                </th>
              ))}
              <th
                scope="col"
                className="h-control-lg border-b border-border-subtle bg-bg-surface px-12 text-end text-text-12 font-medium text-text-secondary"
              >
                {lanes === "people" ? t("crew.shifts.weekHours") : ""}
              </th>
            </tr>
            {band ? (
              <tr>
                <th
                  scope="row"
                  className="border-b border-border-subtle bg-bg-surface px-12 py-4 text-start text-text-12 font-medium text-text-secondary"
                >
                  {t("crew.lanes.dayTypes")}
                </th>
                {days.map((d) => (
                  <td
                    key={d}
                    className="border-b border-border-subtle bg-bg-surface px-12 py-4 align-top"
                  >
                    <DayTypeTags
                      label={t("crew.lanes.dayTypesOn", { day: d })}
                      tags={band.get(d)?.tags ?? []}
                      more={band.get(d)?.more ?? 0}
                      moreLabel={t("crew.lanes.more", { n: band.get(d)?.more ?? 0 })}
                    />
                  </td>
                ))}
                <td className="border-b border-border-subtle bg-bg-surface" />
              </tr>
            ) : null}
          </thead>
          {lanes === "vendors" ? (
            <tbody>
              {(props.vendorLanes ?? []).length === 0 ? (
                <tr>
                  <td
                    colSpan={days.length + 2}
                    className="px-12 py-12 text-text-13 text-text-secondary"
                  >
                    {t("crew.lanes.noVendors")}
                  </td>
                </tr>
              ) : null}
              {(props.vendorLanes ?? []).map((lane) => (
                <tr key={lane.key}>
                  <th
                    scope="row"
                    className="border-b border-border-subtle px-12 py-6 text-start font-normal"
                  >
                    <span className="flex flex-col">
                      <span>{lane.label || t("crew.common.unnamed")}</span>
                      <span className="text-text-12 text-text-secondary">
                        {lane.engagements
                          .map((e) => `${e.projectKey} ${e.startDate}\u2013${e.endDate ?? ""}`)
                          .join(", ")}
                      </span>
                    </span>
                  </th>
                  {days.map((d) => {
                    const ids = new Set(lane.engagements.map((e) => e.id));
                    const shiftsToday = props.shifts.filter(
                      (s) =>
                        s.member?.engagementId &&
                        ids.has(s.member.engagementId) &&
                        dayIn(s.startsAt, s.timeZone) === d,
                    );
                    const engaged = lane.engagements.some(
                      (e) => e.startDate <= d && (e.endDate === null || e.endDate >= d),
                    );
                    return (
                      <td
                        key={d}
                        className={
                          engaged
                            ? "min-w-(--space-64) border-b border-border-subtle bg-bg-surface px-12 py-6 align-top"
                            : "min-w-(--space-64) border-b border-border-subtle px-12 py-6 align-top"
                        }
                      >
                        {engaged ? (
                          <span className="sr-only">{t("crew.lanes.engaged")}</span>
                        ) : null}
                        {shiftsToday.map(chip)}
                        {slotsOn(lane.dockSlots, d).map((slot) => slotChip(slot, "dock"))}
                      </td>
                    );
                  })}
                  <td className="border-b border-border-subtle" />
                </tr>
              ))}
            </tbody>
          ) : lanes === "zones" ? (
            <tbody>
              {(props.zoneLanes ?? []).length === 0 ? (
                <tr>
                  <td
                    colSpan={days.length + 2}
                    className="px-12 py-12 text-text-13 text-text-secondary"
                  >
                    {t("crew.lanes.noZones")}
                  </td>
                </tr>
              ) : null}
              {(props.zoneLanes ?? []).map((lane) => (
                <tr key={lane.key}>
                  <th
                    scope="row"
                    className="border-b border-border-subtle px-12 py-6 text-start font-normal"
                  >
                    <span className="flex flex-col">
                      <span>{lane.label}</span>
                      <span className="text-text-12 text-text-secondary">{lane.venueName}</span>
                    </span>
                  </th>
                  {days.map((d) => (
                    <td
                      key={d}
                      className="min-w-(--space-64) border-b border-border-subtle px-12 py-6 align-top"
                    >
                      {slotsOn(lane.dockSlots, d).map((slot) => slotChip(slot, "dock"))}
                      {slotsOn(lane.workOrders, d).map((slot) => slotChip(slot, "workOrder"))}
                    </td>
                  ))}
                  <td className="border-b border-border-subtle" />
                </tr>
              ))}
            </tbody>
          ) : (
            <tbody>
              {people.map((p) => {
                const minutes = p.shifts
                  .filter((s) => s.state !== "Canceled")
                  .reduce(
                    (sum, s) => sum + (Date.parse(s.endsAt) - Date.parse(s.startsAt)) / 60_000,
                    0,
                  );
                const hours = hoursFromMinutes(minutes);
                const thresholds = p.shifts
                  .map((s) => props.overtimeHours.get(s.projectId) ?? null)
                  .filter((h): h is number => h !== null);
                const over =
                  p.key !== "open" && thresholds.length > 0 && hours > Math.min(...thresholds);
                const membershipId =
                  p.shifts.find((s) => s.member?.membershipId)?.member?.membershipId ?? null;
                return (
                  <tr
                    key={p.key}
                    {...(props.drop && p.key !== "open" && membershipId
                      ? { "data-shift-drop": membershipId, "data-shift-drop-name": p.name }
                      : {})}
                    className="data-drop-over:bg-bg-hover data-drop-over:ring-(length:--stroke-width-focus) data-drop-over:ring-inset data-drop-over:ring-accent"
                  >
                    <th
                      scope="row"
                      className="border-b border-border-subtle px-12 py-6 text-start font-normal"
                    >
                      <span className="flex items-center gap-8 whitespace-nowrap">
                        {p.key === "open" ? null : <Avatar name={p.name} />}
                        <span className="flex flex-col">
                          <span>{p.name}</span>
                          {p.role ? (
                            <span className="text-text-12 text-text-secondary">{p.role}</span>
                          ) : null}
                        </span>
                      </span>
                    </th>
                    {days.map((d) => {
                      const today = p.shifts.filter((s) => dayIn(s.startsAt, s.timeZone) === d);
                      const clash =
                        p.key !== "open" && today.filter((s) => s.state !== "Canceled").length > 1;
                      return (
                        <td
                          key={d}
                          className={
                            clash
                              ? "min-w-(--space-64) border-b border-border-subtle px-12 py-6 align-top ring-(length:--stroke-width-focus) ring-inset ring-danger"
                              : "min-w-(--space-64) border-b border-border-subtle px-12 py-6 align-top"
                          }
                        >
                          {today.map(chip)}
                          {clash ? (
                            <span className="text-text-11 font-medium text-danger-text">
                              {t("crew.shifts.doubleBooked")}
                            </span>
                          ) : null}
                        </td>
                      );
                    })}
                    <td className="border-b border-border-subtle px-12 py-6 text-end align-top tabular-nums">
                      <span className={over ? "font-medium text-warning-text" : undefined}>
                        {format.number(hours, { maximumFractionDigits: 2 })}
                      </span>
                      {over ? (
                        <span className="block text-text-11 text-warning-text">
                          {t("crew.shifts.overtimeRisk")}
                        </span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          )}
        </table>
      </div>
    </div>
  );
}
