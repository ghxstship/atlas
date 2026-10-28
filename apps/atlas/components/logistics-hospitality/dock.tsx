import {
  getDockSlot,
  instantToLocal,
  listDockSlots,
  listShipments,
  listZoneOptions,
  type DockSlot,
  type Shipment,
  type ZoneOption,
} from "@xos/data/logistics";
import type { EngagementOption } from "@xos/data/project-people";
import type { RecordState } from "@xos/ui";
import type { Route } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import {
  bookDockSlotAction,
  cancelDockSlotAction,
  checkInDockSlotAction,
  restoreDockSlotAction,
} from "@/app/[org]/logistics/actions";
import { ButtonLink, EmptyStateLink } from "@/components/ui";
import { engagementOptions } from "@/lib/people/project-people";
import { nodeHref } from "@/lib/shell/sitemap";
import { OperationsCalendar, OperationsList, OperationsTable, ViewSwitcher } from "./client";
import { ActionButton, FormDrawer, type FieldSpec } from "./forms";
import {
  calendarMonth,
  getZonedFormat,
  hrefWith,
  isoDateIn,
  param,
  readView,
  RecordCollab,
  writableProjects,
  type PageScope,
  type SearchParams,
} from "./kit";
import { RecordView } from "./record";
import { PageHeader, RefusalNotice, StateIcon, TemplateCollection } from "./ui";

/**
 * Dock schedule (Section 4.5.5 Logistics; journey 20): booked windows at each loading dock, as a
 * resource schedule by dock and day (the default), a calendar, a list and a table, where the week's
 * slots select and move to another dock in bulk (Section 11.7). A slot opens in the side peek
 * (`?peek={slot id}`; dock slots carry no display key), where it is checked in, moved or canceled.
 * Slots at one dock never overlap (dock_slot_overlap).
 */

export const DOCK_VIEWS = ["resource-schedule", "calendar", "list", "table"] as const;
type DockView = (typeof DOCK_VIEWS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY_MS = 86_400_000;

/**
 * Monday of the week to show (`week=YYYY-MM-DD`, default the week of `today`, the scope's date on
 * the project's or org's calendar), as a day number.
 */
function weekStart(search: SearchParams, today: string): number {
  const asked = param(search, "week") ?? "";
  const base = Date.parse(`${/^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : today}T00:00:00Z`);
  const day = Math.floor(base / DAY_MS);
  const dow = (new Date(day * DAY_MS).getUTCDay() + 6) % 7;
  return day - dow;
}

const isoDay = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);

function slotState(slot: DockSlot): RecordState {
  return slot.checkedInAt ? "active" : "scheduled";
}

export async function DockSection({
  scope,
  search,
  base,
  heading,
}: {
  scope: PageScope;
  search: SearchParams;
  base: string;
  heading?: ReactNode;
}) {
  const t = await getTranslations("logistics");
  const format = await getZonedFormat();
  const db = scope.ctx.viewer.db;
  const view = readView<DockView>(search, DOCK_VIEWS, "resource-schedule");
  const projects = scope.project ? [scope.project] : scope.projects;
  const venueIds = [...new Set(projects.flatMap((p) => (p.venueId ? [p.venueId] : [])))];
  const timeZone = scope.project?.timeZone ?? projects[0]?.timeZone ?? "UTC";
  const monday = weekStart(search, scope.today);
  const cal = calendarMonth(search, scope.today);
  const window =
    view === "calendar"
      ? { from: `${cal.previous}-20T00:00:00Z`, to: `${cal.next}-10T00:00:00Z` }
      : { from: `${isoDay(monday - 1)}T00:00:00Z`, to: `${isoDay(monday + 8)}T00:00:00Z` };
  const [zones, slots, shipments] = await Promise.all([
    listZoneOptions(db, venueIds),
    listDockSlots(db, {
      orgId: scope.ctx.org.id,
      ...(scope.project ? { projectId: scope.project.id } : {}),
      ...window,
    }),
    listShipments(db, {
      orgId: scope.ctx.org.id,
      ...(scope.project ? { projectId: scope.project.id } : {}),
    }),
  ]);
  if (!zones.ok) throw new Error(`Cannot read docks: ${JSON.stringify(zones.error)}`);
  if (!slots.ok) throw new Error(`Cannot read dock slots: ${JSON.stringify(slots.error)}`);
  if (!shipments.ok) throw new Error(`Cannot read shipments: ${JSON.stringify(shipments.error)}`);
  const shipmentById = new Map(shipments.data.map((s) => [s.id, s]));
  const shipmentTitle = (s: Shipment) =>
    s.carrierName
      ? t("shipments.titleWithCarrier", { direction: s.direction, carrier: s.carrierName })
      : t("shipments.titleNoCarrier", { direction: s.direction });
  const writable = writableProjects(scope, "logistics.dock_slot.write");
  // Vendor engagements a slot can serve (R1, app.engagement_options).
  const vendors = (await engagementOptions(scope.ctx)).filter((e) => e.roleType === "Vendor");
  // The account and its contact: one vendor can hold several engagements on a project.
  const vendorLabel = (e: EngagementOption) =>
    [
      `${e.projectKey} ${e.accountName ?? e.personName ?? ""}`.trim(),
      e.accountName ? e.personName : null,
    ]
      .filter(Boolean)
      .join(" · ");
  const listHref = hrefWith(base, search, { peek: null, full: null, edit: null, create: null });
  const peekHref = (id: string) => hrefWith(base, search, { peek: id, full: null, edit: null });
  const slotLabel = (slot: DockSlot) => {
    const shipment = slot.shipmentId ? shipmentById.get(slot.shipmentId) : undefined;
    const start = format.time(slot.startsAt, slot.timeZone);
    const end = format.time(slot.endsAt, slot.timeZone);
    return shipment
      ? t("dock.slotWithShipment", {
          start,
          end,
          shipment: `${shipment.key} ${shipmentTitle(shipment)}`,
        })
      : t("dock.slot", { start, end });
  };

  const fieldsFor = (slot?: DockSlot): FieldSpec[] => {
    const projectId = slot?.projectId ?? param(search, "project") ?? writable[0]?.id ?? "";
    const project = writable.find((p) => p.id === projectId) ?? writable[0];
    const zoneChoices = zones.data.filter(
      (z) => !project?.venueId || z.venueId === project.venueId,
    );
    const zoneLabel = (z: ZoneOption) => `${z.code} ${z.name}`;
    const tz = project?.timeZone ?? timeZone;
    return [
      ...(slot
        ? []
        : [
            {
              name: "projectId",
              label: t("dock.fields.project"),
              kind: "select" as const,
              required: true,
              defaultValue: project?.id ?? "",
              options: writable.map((p) => ({ value: p.id, label: `${p.key} ${p.name}` })),
            },
          ]),
      {
        name: "zoneId",
        label: t("dock.fields.zone"),
        kind: "select",
        required: true,
        defaultValue: slot?.zoneId ?? zoneChoices[0]?.id ?? "",
        options: zoneChoices.map((z) => ({ value: z.id, label: zoneLabel(z) })),
      },
      {
        name: "shipmentId",
        label: t("dock.fields.shipment"),
        kind: "select",
        defaultValue: slot?.shipmentId ?? param(search, "shipment") ?? "",
        options: [
          { value: "", label: t("dock.noShipment") },
          ...shipments.data
            .filter((s) => !project || s.projectId === project.id)
            .map((s) => ({ value: s.id, label: `${s.key} ${shipmentTitle(s)}` })),
        ],
      },
      {
        name: "engagementId",
        label: t("dock.fields.vendor"),
        kind: "select",
        defaultValue: slot?.engagementId ?? "",
        options: [
          { value: "", label: t("dock.noVendor") },
          // engagement_options lists live engagements only; a slot whose vendor engagement has ended keeps it
          // as an option, so saving other changes does not clear the vendor.
          ...(slot?.engagementId && !vendors.some((e) => e.engagementId === slot.engagementId)
            ? [{ value: slot.engagementId, label: t("dock.endedVendor") }]
            : []),
          ...vendors
            .filter((e) => !project || e.projectId === project.id)
            .map((e) => ({ value: e.engagementId, label: vendorLabel(e) })),
        ],
      },
      {
        name: "startsAt",
        label: t("dock.fields.startsAt"),
        kind: "datetime",
        required: true,
        help: t("common.timeZoneHelp", { zone: tz }),
        defaultValue: slot ? instantToLocal(slot.startsAt, slot.timeZone) : "",
      },
      {
        name: "endsAt",
        label: t("dock.fields.endsAt"),
        kind: "datetime",
        required: true,
        defaultValue: slot ? instantToLocal(slot.endsAt, slot.timeZone) : "",
      },
    ];
  };

  let overlay: ReactNode = null;
  if (param(search, "create") === "1") {
    overlay =
      writable.length === 0 ? (
        <RefusalNotice
          outcome="REFUSE"
          title={t("common.refusal.createTitle")}
          reason={t("common.refusal.createReason", { thing: t("dock.title") })}
        />
      ) : (
        <FormDrawer
          title={t("dock.book")}
          fields={fieldsFor()}
          hidden={{ org: scope.ctx.org.slug }}
          action={bookDockSlotAction}
          submitLabel={t("dock.book")}
          closeHref={listHref}
        />
      );
  }

  const peekId = param(search, "peek");
  let record: ReactNode = null;
  if (peekId) {
    const found = UUID.test(peekId) ? await getDockSlot(db, peekId) : null;
    if (found && !found.ok && found.error.kind !== "not-found") {
      throw new Error(`Cannot read dock slot: ${JSON.stringify(found.error)}`);
    }
    if (found?.ok) {
      const slot = found.data;
      const full = param(search, "full") === "1";
      const canDock =
        scope.access.can(slot.projectId, "logistics.dock_slot.write") ||
        scope.access.can(slot.projectId, "logistics.yard.write");
      const canMove = scope.access.can(slot.projectId, "logistics.dock_slot.write");
      const org = scope.ctx.org.slug;
      const shipment = slot.shipmentId ? shipmentById.get(slot.shipmentId) : undefined;
      const shipmentsHref = nodeHref("logistics.shipments", scope.params);
      record = (
        <>
          <RecordView
            mode={full ? "full" : "peek"}
            kindLabel={t("kinds.dockSlot")}
            recordKey={`${slot.projectKey} ${slot.zoneCode ?? ""}`.trim()}
            title={`${slot.zoneName ?? slot.zoneCode ?? ""}, ${format.dateTime(slot.startsAt, slot.timeZone) ?? ""}`}
            state={slotState(slot)}
            stateLabel={slot.checkedInAt ? t("dock.state.checkedIn") : t("dock.state.booked")}
            propertiesLabel={t("common.properties")}
            backHref={listHref}
            backLabel={t("common.backToList", { section: t("dock.title") })}
            properties={[
              { label: t("dock.fields.project"), value: slot.projectKey },
              {
                label: t("dock.fields.zone"),
                value: `${slot.zoneCode ?? ""} ${slot.zoneName ?? ""}`.trim(),
              },
              {
                label: t("dock.fields.shipment"),
                value:
                  shipment && shipmentsHref ? (
                    <Link
                      href={`${shipmentsHref}?peek=${shipment.key}` as Route}
                      className="text-accent-text"
                    >
                      {shipment.key} {shipmentTitle(shipment)}
                    </Link>
                  ) : (
                    t("dock.noShipment")
                  ),
              },
              {
                label: t("dock.fields.vendor"),
                value: slot.engagementId
                  ? (() => {
                      const vendor = vendors.find((e) => e.engagementId === slot.engagementId);
                      if (vendor) return vendorLabel(vendor);
                      // Writers reach every live engagement of the project, so a missing one has ended; a
                      // reader without a picker capability sees only that one is linked.
                      return writable.some((p) => p.id === slot.projectId)
                        ? t("dock.endedVendor")
                        : t("dock.linkedVendor");
                    })()
                  : t("dock.noVendor"),
              },
              {
                label: t("dock.fields.startsAt"),
                value: format.dateTime(slot.startsAt, slot.timeZone),
              },
              {
                label: t("dock.fields.endsAt"),
                value: format.dateTime(slot.endsAt, slot.timeZone),
              },
              {
                label: t("dock.fields.checkedIn"),
                value: slot.checkedInAt
                  ? slot.checkedInByName
                    ? t("dock.checkedIn", {
                        time: format.dateTime(slot.checkedInAt, slot.timeZone) ?? "",
                        name: slot.checkedInByName,
                      })
                    : t("dock.checkedInNoName", {
                        time: format.dateTime(slot.checkedInAt, slot.timeZone) ?? "",
                      })
                  : t("common.notSet"),
              },
            ]}
            actions={
              <>
                {!slot.checkedInAt && canDock ? (
                  <ActionButton
                    label={t("dock.checkIn")}
                    variant="primary"
                    run={checkInDockSlotAction.bind(null, org, slot.id)}
                  />
                ) : null}
                {!slot.checkedInAt && canMove ? (
                  <>
                    <ButtonLink href={hrefWith(base, search, { edit: "1" })} size="sm">
                      {t("common.edit")}
                    </ButtonLink>
                    <ActionButton
                      label={t("dock.cancelSlot")}
                      variant="ghost"
                      run={cancelDockSlotAction.bind(null, org, slot.id)}
                      doneHref={listHref}
                      undo={{
                        message: t("dock.canceled"),
                        restore: restoreDockSlotAction.bind(null, org, slot.id),
                      }}
                    />
                  </>
                ) : null}
              </>
            }
          >
            <RecordCollab
              scope={scope}
              subject={{ table: "app.dock_slots", id: slot.id }}
              canPost={canDock}
            />
          </RecordView>
          {param(search, "edit") === "1" && canMove && !slot.checkedInAt ? (
            <FormDrawer
              title={t("dock.editTitle")}
              fields={fieldsFor(slot)}
              hidden={{ org, id: slot.id, projectId: slot.projectId }}
              action={bookDockSlotAction}
              submitLabel={t("common.save")}
              closeHref={hrefWith(base, search, { edit: null })}
            />
          ) : null}
        </>
      );
      if (full) return record;
    } else {
      record = (
        <RefusalNotice
          outcome="NO_ANSWER"
          title={t("common.peekMissing.title")}
          reason={t("common.peekMissing.reason")}
        />
      );
    }
  }

  const createHref = hrefWith(base, search, { create: "1", peek: null });
  const header = (
    <PageHeader
      title={t("dock.title")}
      count={slots.data.length}
      views={
        <ViewSwitcher
          label={t("common.views.label")}
          current={view}
          options={DOCK_VIEWS.map((v) => ({
            value: v,
            label: t(`common.views.${v === "resource-schedule" ? "resourceSchedule" : v}`),
          }))}
        />
      }
      actions={
        writable.length > 0 && zones.data.length > 0 ? (
          <ButtonLink href={createHref} variant="primary">
            {t("dock.book")}
          </ButtonLink>
        ) : undefined
      }
    />
  );

  const weekNav =
    view === "calendar" ? null : (
      <nav
        aria-label={t("dock.weekOf", { date: format.date(isoDay(monday)) ?? "" })}
        className="flex flex-wrap items-center gap-8"
      >
        <ButtonLink
          href={hrefWith(base, search, { week: isoDay(monday - 7) })}
          variant="ghost"
          size="sm"
        >
          {t("common.previousWeek")}
        </ButtonLink>
        <span className="text-text-13 font-medium">
          {t("dock.weekOf", { date: format.date(isoDay(monday)) ?? "" })}
        </span>
        <ButtonLink
          href={hrefWith(base, search, { week: isoDay(monday + 7) })}
          variant="ghost"
          size="sm"
        >
          {t("common.nextWeek")}
        </ButtonLink>
      </nav>
    );

  const weekSlots = slots.data.filter((s) => {
    const day = Math.floor(Date.parse(`${isoDateIn(s.startsAt, s.timeZone)}T00:00:00Z`) / DAY_MS);
    return day >= monday && day < monday + 7;
  });

  let body: ReactNode;
  if (zones.data.length === 0) {
    body = (
      <EmptyStateLink
        icon="Warehouse"
        sentence={t("dock.noDocks")}
        actionLabel={t("dock.noDocksAction")}
        href={nodeHref("places.spaces-and-zones", scope.params) ?? "/"}
      />
    );
  } else if (view === "calendar") {
    body = (
      <OperationsCalendar
        month={cal.month}
        today={cal.today}
        previousMonth={cal.previous}
        nextMonth={cal.next}
        previousLabel={t("common.previousMonth")}
        nextLabel={t("common.nextMonth")}
        items={slots.data.map((s) => ({
          date: isoDateIn(s.startsAt, s.timeZone),
          label: `${s.zoneCode ?? ""} ${slotLabel(s)}`,
          state: slotState(s),
          href: peekHref(s.id),
        }))}
      />
    );
  } else if (weekSlots.length === 0) {
    body = (
      <>
        {weekNav}
        {writable.length > 0 ? (
          <EmptyStateLink
            icon="CalendarClock"
            sentence={t("dock.empty")}
            actionLabel={t("dock.book")}
            href={createHref}
            secondary
          />
        ) : (
          <EmptyStateLink
            icon="CalendarClock"
            sentence={t("dock.emptyReadOnly")}
            actionLabel={t("shipments.title")}
            href={nodeHref("logistics.shipments", scope.params) ?? "/"}
          />
        )}
      </>
    );
  } else if (view === "table") {
    body = (
      <>
        {weekNav}
        <OperationsTable
          caption={t("dock.weekOf", { date: format.date(isoDay(monday)) ?? "" })}
          columns={[
            { key: "dock", label: t("dock.fields.zone"), type: "code", width: 110 },
            { key: "when", label: t("dock.fields.startsAt"), wrap: true },
            { key: "shipment", label: t("dock.fields.shipment"), wrap: true },
            { key: "project", label: t("dock.fields.project"), type: "code", width: 90 },
            { key: "state", label: t("dock.fields.checkedIn") },
          ]}
          rows={weekSlots.map((s) => {
            const shipment = s.shipmentId ? shipmentById.get(s.shipmentId) : undefined;
            const when = t("dock.slot", {
              start: format.dateTime(s.startsAt, s.timeZone) ?? "",
              end: format.time(s.endsAt, s.timeZone),
            });
            return {
              id: s.id,
              label: `${s.zoneCode ?? ""} ${when}`.trim(),
              dock: s.zoneCode ?? "",
              when,
              shipment: shipment ? `${shipment.key} ${shipmentTitle(shipment)}` : "",
              project: s.projectKey,
              state: s.checkedInAt ? t("dock.state.checkedIn") : t("dock.state.booked"),
              href: peekHref(s.id),
              fullHref: hrefWith(base, search, { peek: s.id, full: "1", edit: null }),
              ...(!s.checkedInAt && scope.access.can(s.projectId, "logistics.dock_slot.write")
                ? { trashMessage: t("dock.canceled") }
                : {}),
            };
          })}
          bulk={
            writable.length > 0
              ? {
                  org: scope.ctx.org.slug,
                  resource: "dock_slots",
                  fields: [
                    {
                      key: "zone_id",
                      label: t("dock.fields.zone"),
                      options: zones.data.map((z) => ({
                        value: z.id,
                        label: `${z.code} ${z.name}`,
                      })),
                    },
                  ],
                }
              : null
          }
          trash={{
            org: scope.ctx.org.slug,
            label: t("dock.cancelSlot"),
            run: cancelDockSlotAction,
            restore: restoreDockSlotAction,
          }}
        />
      </>
    );
  } else if (view === "list") {
    body = (
      <>
        {weekNav}
        <OperationsList
          label={t("dock.title")}
          openLabel={t("common.open")}
          items={weekSlots.map((s) => ({
            key: s.id,
            href: peekHref(s.id),
            state: slotState(s),
            stateLabel: s.checkedInAt ? t("dock.state.checkedIn") : t("dock.state.booked"),
            title: `${s.zoneCode ?? ""} ${slotLabel(s)}`,
            chips: [
              s.projectKey,
              s.checkedInAt ? t("dock.state.checkedIn") : t("dock.state.booked"),
            ],
            next: format.dateTime(s.startsAt, s.timeZone) ?? "",
          }))}
        />
      </>
    );
  } else {
    const days = Array.from({ length: 7 }, (_, i) => isoDay(monday + i));
    const rows = zones.data;
    body = (
      <>
        {weekNav}
        <div
          role="region"
          aria-label={t("dock.weekOf", { date: format.date(days[0] ?? "") ?? "" })}
          tabIndex={0}
          className="overflow-x-auto rounded-card border border-border-subtle"
        >
          <table className="w-full min-w-(--layout-reading) border-collapse text-text-13">
            <caption className="sr-only">
              {t("dock.weekOf", { date: format.date(days[0] ?? "") ?? "" })}
            </caption>
            <thead>
              <tr>
                <th
                  scope="col"
                  className="h-control-lg px-12 text-start text-text-12 font-medium text-text-secondary bg-bg-surface border-b border-border-subtle"
                >
                  {t("dock.dockColumn")}
                </th>
                {days.map((d) => (
                  <th
                    key={d}
                    scope="col"
                    className="h-control-lg px-12 text-start text-text-12 font-medium bg-bg-surface border-b border-border-subtle"
                  >
                    <span className="text-text-secondary">{format.weekday(d)}</span>{" "}
                    <span className="tabular-nums">{format.date(d)}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((z) => (
                <tr key={z.id}>
                  <th
                    scope="row"
                    className="px-12 py-8 text-start align-top font-medium border-b border-border-subtle"
                  >
                    <span className="font-mono text-text-12 text-text-secondary">{z.code}</span>
                    <br />
                    {z.name}
                  </th>
                  {days.map((d) => (
                    <td
                      key={d}
                      className="px-8 py-8 align-top border-b border-s border-border-subtle"
                    >
                      <ul className="m-0 flex list-none flex-col gap-4 p-0">
                        {weekSlots
                          .filter(
                            (s) => s.zoneId === z.id && isoDateIn(s.startsAt, s.timeZone) === d,
                          )
                          .map((s) => (
                            <li key={s.id}>
                              <Link
                                href={peekHref(s.id) as Route}
                                scroll={false}
                                className="flex items-start gap-4 rounded-chip bg-bg-surface px-6 py-4 text-text-12 text-text-primary outline-none hover:bg-bg-hover focus-visible:ring-(length:--stroke-width-focus) focus-visible:ring-focus-ring"
                              >
                                <StateIcon state={slotState(s)} size={12} />
                                <span>{slotLabel(s)}</span>
                              </Link>
                            </li>
                          ))}
                      </ul>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>
    );
  }

  return (
    <TemplateCollection
      header={
        heading ? (
          <>
            {heading}
            {header}
          </>
        ) : (
          header
        )
      }
      peek={
        <>
          {record}
          {overlay}
        </>
      }
    >
      {body}
    </TemplateCollection>
  );
}
