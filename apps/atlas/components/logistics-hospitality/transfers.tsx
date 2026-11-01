import { listTravelGrid } from "@xos/data/hospitality";
import { findIdByKey, instantToLocal, listCounterpartyOptions } from "@xos/data/logistics";
import {
  getTransfer,
  listTransferPersonOptions,
  listTransfers,
  listTransferVehicles,
  VEHICLE_TYPES,
  type Transfer,
  type TransferDetail,
  type TransferStatus,
} from "@xos/data/transfers";
import type { RecordState } from "@xos/ui";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import {
  addPassengerAction,
  cancelTransferAction,
  createTransferAction,
  createVehicleAction,
  deleteVehicleAction,
  removePassengerAction,
  restoreTransferAction,
  restoreVehicleAction,
  setPrimaryPassengerAction,
  updateTransferAction,
} from "@/app/[org]/hospitality/transfer-actions";
import { ButtonLink, EmptyStateLink } from "@/components/ui";
import { transferLanes, transferWarnings, type LaneMode } from "@/lib/hospitality/travel";
import { OperationsCalendar, OperationsList, OperationsTable, ViewSwitcher } from "./client";
import { ActionButton, FormDrawer, InlineForm, type FieldSpec } from "./forms";
import {
  calendarMonth,
  getZonedFormat,
  hrefWith,
  isoDateIn,
  param,
  readView,
  RecordCollab,
  Section,
  writableProjects,
  type PageScope,
  type SearchParams,
} from "./kit";
import { LaneSchedule, mondayOf, weekDays } from "./lanes";
import { RecordView } from "./record";
import { PageHeader, RefusalNotice, TemplateCollection } from "./ui";

/**
 * Hospitality > Transfers (B5, G-33): ground transfers with their vehicle, driver and passengers, read from
 * app.transfer_board with the status (Unassigned, Assigned, Underway, Done) and warnings (Tight turnaround, Flight
 * lands after pickup) computed on read. The planner types the drop-off estimate; no drive time or map is computed
 * (G-34). Vehicles are managed in a drawer. The database refuses every double booking and a full vehicle.
 */

export const TRANSFER_VIEWS = ["list", "table", "resource-schedule", "calendar"] as const;
type TransferView = (typeof TRANSFER_VIEWS)[number];

const STATUS_STATE: Record<TransferStatus, RecordState> = {
  Unassigned: "blocked",
  Assigned: "scheduled",
  Underway: "active",
  Done: "complete",
};

export async function TransfersSection({
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
  const t = (await getTranslations("hospitality.transfers")) as unknown as (
    key: string,
    values?: Record<string, string | number>,
  ) => string;
  const tv = await getTranslations("hospitality.vehicles");
  const tc = await getTranslations("logistics.common");
  const format = await getZonedFormat();
  const db = scope.ctx.viewer.db;
  const org = scope.ctx.org.slug;
  const view = readView<TransferView>(search, TRANSFER_VIEWS, "list");
  const projectScope = {
    orgId: scope.ctx.org.id,
    ...(scope.project ? { projectId: scope.project.id } : {}),
  };
  const [rows, vehicles] = await Promise.all([
    listTransfers(db, projectScope),
    listTransferVehicles(db, projectScope),
  ]);
  if (!rows.ok) throw new Error(`Cannot read transfers: ${JSON.stringify(rows.error)}`);
  if (!vehicles.ok) throw new Error(`Cannot read vehicles: ${JSON.stringify(vehicles.error)}`);
  const writable = writableProjects(scope, "hospitality.fulfillment.write");
  const listHref = hrefWith(base, search, {
    peek: null,
    full: null,
    edit: null,
    create: null,
    vehicles: null,
  });
  const peekHref = (key: string) => hrefWith(base, search, { peek: key, full: null, edit: null });
  const statusLabel = (s: TransferStatus) => t(`status.${s.toLowerCase()}`);
  const warnings = (r: Transfer) => transferWarnings(r).map((w) => t(`warnings.${w}`));
  const when = (r: Transfer) =>
    t("window", {
      pickup: format.dateTime(r.pickupAt, r.pickupTimeZone) ?? "",
      dropoff: format.time(r.dropoffAt, r.dropoffTimeZone),
    });
  const title = (r: Transfer) => t("route", { from: r.pickupPlace, to: r.dropoffPlace });

  const projectFields = (): FieldSpec[] => [
    {
      name: "projectId",
      label: t("fields.project"),
      kind: "select",
      required: true,
      defaultValue: scope.project?.id ?? writable[0]?.id ?? "",
      options: writable.map((p) => ({ value: p.id, label: `${p.key} ${p.name}` })),
    },
  ];

  const transferFields = async (
    projectId: string | undefined,
    r?: TransferDetail,
  ): Promise<FieldSpec[]> => {
    const zone =
      r?.pickupTimeZone ?? scope.projects.find((p) => p.id === projectId)?.timeZone ?? "UTC";
    const [people, flights] = projectId
      ? await Promise.all([
          listTransferPersonOptions(db, projectId),
          listTravelGrid(db, { orgId: scope.ctx.org.id, projectId }),
        ])
      : [null, null];
    const projectVehicles = vehicles.data.filter((v) => !projectId || v.projectId === projectId);
    return [
      {
        name: "pickupPlace",
        label: t("fields.pickupPlace"),
        kind: "text",
        required: true,
        defaultValue: r?.pickupPlace ?? param(search, "pickupPlace") ?? "",
      },
      {
        name: "pickupAt",
        label: t("fields.pickupAt"),
        kind: "datetime",
        required: true,
        help: tc("timeZoneHelp", { zone }),
        defaultValue: r
          ? instantToLocal(r.pickupAt, r.pickupTimeZone)
          : (param(search, "pickupAt") ?? ""),
      },
      {
        name: "dropoffPlace",
        label: t("fields.dropoffPlace"),
        kind: "text",
        required: true,
        defaultValue: r?.dropoffPlace ?? "",
      },
      {
        name: "dropoffAt",
        label: t("fields.dropoffAt"),
        kind: "datetime",
        required: true,
        help: t("fields.dropoffHelp"),
        defaultValue: r ? instantToLocal(r.dropoffAt, r.dropoffTimeZone) : "",
      },
      {
        name: "vehicleId",
        label: t("fields.vehicle"),
        kind: "select",
        defaultValue: r?.vehicleId ?? "",
        options: [
          { value: "", label: tc("none") },
          ...projectVehicles.map((v) => ({
            value: v.id,
            label: tv("option", { label: v.label, seats: v.seats }),
          })),
        ],
      },
      {
        name: "driverPersonId",
        label: t("fields.driver"),
        kind: "select",
        defaultValue: r?.driverPersonId ?? "",
        options: [
          { value: "", label: tc("none") },
          ...(people?.ok
            ? people.data.map((p) => ({
                value: p.personId,
                label: p.partyName ? `${p.fullName} (${p.partyName})` : p.fullName,
              }))
            : []),
        ],
      },
      {
        name: "meetsSegmentId",
        label: t("fields.meetsFlight"),
        kind: "select",
        defaultValue: r?.meetsSegmentId ?? "",
        options: [
          { value: "", label: tc("none") },
          ...(flights?.ok
            ? flights.data.map((f) => ({
                value: f.id,
                label: t("flightOption", {
                  flight: f.serviceIdentifier ?? f.departsFrom,
                  traveler: f.travelerName ?? tc("unnamed"),
                  arrives: format.dateTime(f.arrivesAt, f.arrivesTimeZone) ?? "",
                }),
              }))
            : []),
        ],
      },
      { name: "notes", label: t("fields.notes"), kind: "textarea", defaultValue: r?.notes ?? "" },
    ];
  };

  let overlay: ReactNode = null;
  if (param(search, "create") === "1") {
    const projectId = scope.project?.id ?? writable[0]?.id;
    overlay =
      writable.length === 0 ? (
        <RefusalNotice
          outcome="REFUSE"
          title={tc("refusal.createTitle")}
          reason={tc("refusal.createReason", { thing: t("title") })}
        />
      ) : (
        <FormDrawer
          title={t("new")}
          fields={[...(scope.project ? [] : projectFields()), ...(await transferFields(projectId))]}
          hidden={{
            org,
            ...(scope.project ? { projectId: scope.project.id } : {}),
            ...(param(search, "passenger")
              ? { passengerPersonId: param(search, "passenger") ?? "" }
              : {}),
          }}
          action={createTransferAction}
          submitLabel={t("new")}
          closeHref={listHref}
          successHref={hrefWith(base, search, {
            create: null,
            passenger: null,
            pickupAt: null,
            pickupPlace: null,
            peek: "{key}",
          })}
        />
      );
  } else if (param(search, "vehicles") === "1") {
    const projectId = scope.project?.id ?? writable[0]?.id;
    const counterparties = await listCounterpartyOptions(db, scope.ctx.org.id);
    overlay = (
      <RecordView
        mode="peek"
        kindLabel={tv("kind")}
        recordKey=""
        title={tv("title")}
        state="active"
        stateLabel={tv("count", { count: vehicles.data.length })}
        propertiesLabel={tc("properties")}
        backHref={listHref}
        backLabel={tc("backToList", { section: t("title") })}
        properties={[]}
      >
        <Section id="vehicles" title={tv("title")}>
          {vehicles.data.length === 0 ? (
            <p className="m-0 text-text-13 text-text-secondary">{tv("empty")}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
              {vehicles.data.map((v) => (
                <li key={v.id} className="flex flex-wrap items-center justify-between gap-8 py-8">
                  <span className="flex flex-col gap-2">
                    <span className="text-text-14">{v.label}</span>
                    <span className="text-text-12 text-text-secondary">
                      {tv("detail", { type: tv(`types.${v.vehicleType}`), seats: v.seats })}
                    </span>
                  </span>
                  {scope.access.can(v.projectId, "hospitality.fulfillment.write") ? (
                    <ActionButton
                      label={tv("remove", { label: v.label })}
                      variant="ghost"
                      run={deleteVehicleAction.bind(null, org, v.id)}
                      undo={{
                        message: tc("deleted", { key: v.label }),
                        restore: restoreVehicleAction.bind(null, org, v.id),
                      }}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {projectId && writable.length > 0 ? (
            <InlineForm
              label={tv("add")}
              hidden={{ org, ...(scope.project ? { projectId: scope.project.id } : {}) }}
              action={createVehicleAction}
              submitLabel={tv("add")}
              fields={[
                ...(scope.project ? [] : projectFields()),
                {
                  name: "label",
                  label: tv("fields.label"),
                  kind: "text",
                  required: true,
                  hint: tv("fields.labelHint"),
                },
                {
                  name: "vehicleType",
                  label: tv("fields.type"),
                  kind: "select",
                  required: true,
                  defaultValue: "Van",
                  options: VEHICLE_TYPES.map((v) => ({ value: v, label: tv(`types.${v}`) })),
                },
                {
                  name: "seats",
                  label: tv("fields.seats"),
                  kind: "number",
                  required: true,
                  defaultValue: "7",
                  help: tv("fields.seatsHelp"),
                },
                {
                  name: "supplierId",
                  label: tv("fields.supplier"),
                  kind: "select",
                  defaultValue: "",
                  options: [
                    { value: "", label: tc("none") },
                    ...(counterparties.ok
                      ? counterparties.data.map((c) => ({
                          value: c.id,
                          label: c.name ?? tc("notSet"),
                        }))
                      : []),
                  ],
                },
              ]}
            />
          ) : null}
        </Section>
      </RecordView>
    );
  }

  const peekKey = param(search, "peek");
  let record: ReactNode = null;
  if (peekKey) {
    const id = await findIdByKey(db, scope.ctx.org.id, "transfers", peekKey);
    const detail = id.ok ? await getTransfer(db, id.data) : id;
    if (!detail.ok && detail.error.kind !== "not-found") {
      throw new Error(`Cannot read transfer: ${JSON.stringify(detail.error)}`);
    }
    if (detail.ok) {
      const r = detail.data;
      const full = param(search, "full") === "1";
      const canWrite = scope.access.can(r.projectId, "hospitality.fulfillment.write");
      const people = canWrite ? await listTransferPersonOptions(db, r.projectId) : null;
      const riding = new Set(r.passengers.map((p) => p.personId));
      record = (
        <>
          <RecordView
            mode={full ? "full" : "peek"}
            kindLabel={t("kind")}
            recordKey={r.key}
            title={title(r)}
            state={STATUS_STATE[r.status]}
            stateLabel={statusLabel(r.status)}
            propertiesLabel={tc("properties")}
            backHref={listHref}
            backLabel={tc("backToList", { section: t("title") })}
            properties={[
              {
                label: t("fields.pickupAt"),
                value: format.dateTime(r.pickupAt, r.pickupTimeZone) ?? "",
              },
              {
                label: t("fields.dropoffAt"),
                value: format.dateTime(r.dropoffAt, r.dropoffTimeZone) ?? "",
              },
              {
                label: t("fields.vehicle"),
                value: r.vehicleLabel
                  ? tv("option", { label: r.vehicleLabel, seats: r.seats ?? 0 })
                  : tc("notSet"),
              },
              { label: t("fields.driver"), value: r.driverName ?? tc("notSet") },
              {
                label: t("fields.meetsFlight"),
                value: r.meetsServiceIdentifier
                  ? t("meets", {
                      flight: r.meetsServiceIdentifier,
                      arrives:
                        format.dateTime(r.meetsArrivesAt, r.pickupTimeZone) ?? t("arrivalUnknown"),
                    })
                  : tc("notSet"),
              },
              { label: t("fields.warnings"), value: warnings(r).join(", ") || t("warnings.none") },
              ...(r.notes ? [{ label: t("fields.notes"), value: r.notes }] : []),
            ]}
            actions={
              canWrite ? (
                <>
                  <ButtonLink href={hrefWith(base, search, { edit: "1" })} size="sm">
                    {tc("edit")}
                  </ButtonLink>
                  <ActionButton
                    label={t("cancel")}
                    variant="ghost"
                    run={cancelTransferAction.bind(null, org, r.id)}
                    doneHref={listHref}
                    undo={{
                      message: t("canceled", { key: r.key }),
                      restore: restoreTransferAction.bind(null, org, r.id),
                    }}
                  />
                </>
              ) : null
            }
          >
            <Section
              id={`passengers-${r.id}`}
              title={t("passengers.title", { count: r.passengers.length, seats: r.seats ?? 0 })}
            >
              {r.passengers.length === 0 ? (
                <p className="m-0 text-text-13 text-text-secondary">{t("passengers.empty")}</p>
              ) : (
                <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
                  {r.passengers.map((p) => (
                    <li
                      key={p.id}
                      className="flex flex-wrap items-center justify-between gap-8 py-8"
                    >
                      <span className="flex flex-col gap-2">
                        <span className="text-text-14">{p.personName ?? tc("unnamed")}</span>
                        {p.isPrimary ? (
                          <span className="text-text-12 text-text-secondary">
                            {t("passengers.primary")}
                          </span>
                        ) : null}
                      </span>
                      {canWrite ? (
                        <span className="flex gap-4">
                          {!p.isPrimary ? (
                            <ActionButton
                              label={t("passengers.makePrimary", {
                                name: p.personName ?? tc("unnamed"),
                              })}
                              variant="ghost"
                              run={setPrimaryPassengerAction.bind(null, org, r.id, p.id)}
                            />
                          ) : null}
                          <ActionButton
                            label={t("passengers.remove", { name: p.personName ?? tc("unnamed") })}
                            variant="ghost"
                            run={removePassengerAction.bind(null, org, p.id)}
                          />
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              {canWrite && people?.ok ? (
                <InlineForm
                  label={t("passengers.add")}
                  hidden={{ org, transferId: r.id }}
                  action={addPassengerAction}
                  submitLabel={t("passengers.add")}
                  fields={[
                    {
                      name: "personId",
                      label: t("passengers.person"),
                      kind: "select",
                      required: true,
                      options: people.data
                        .filter((p) => !riding.has(p.personId) && p.personId !== r.driverPersonId)
                        .map((p) => ({
                          value: p.personId,
                          label: p.partyName ? `${p.fullName} (${p.partyName})` : p.fullName,
                        })),
                    },
                  ]}
                />
              ) : null}
            </Section>
            <RecordCollab
              scope={scope}
              subject={{ table: "app.transfers", id: r.id }}
              canPost={canWrite}
            />
          </RecordView>
          {param(search, "edit") === "1" && canWrite ? (
            <FormDrawer
              title={t("editTitle", { key: r.key })}
              fields={await transferFields(r.projectId, r)}
              hidden={{ org, id: r.id }}
              action={updateTransferAction}
              submitLabel={tc("save")}
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
          title={tc("peekMissing.title")}
          reason={tc("peekMissing.reason")}
        />
      );
    }
  }

  const createHref = hrefWith(base, search, { create: "1", peek: null });
  const header = (
    <PageHeader
      title={t("title")}
      count={rows.data.length}
      views={
        <ViewSwitcher
          label={tc("views.label")}
          current={view}
          options={TRANSFER_VIEWS.map((v) => ({
            value: v,
            label: tc(`views.${v === "resource-schedule" ? "resourceSchedule" : v}`),
          }))}
        />
      }
      actions={
        <>
          <ButtonLink
            href={hrefWith(base, search, { vehicles: "1", peek: null, create: null })}
            size="sm"
          >
            {tv("manage")}
          </ButtonLink>
          {writable.length > 0 ? (
            <ButtonLink href={createHref} variant="primary">
              {t("new")}
            </ButtonLink>
          ) : null}
        </>
      }
    />
  );

  const chips = (r: Transfer) => [
    r.key,
    ...(r.driverName ? [r.driverName] : []),
    ...(r.vehicleLabel ? [r.vehicleLabel] : []),
    t("passengerCount", { count: r.passengerCount }),
    ...warnings(r),
  ];

  let body: ReactNode;
  if (rows.data.length === 0) {
    body =
      writable.length > 0 ? (
        <EmptyStateLink
          icon="Navigation"
          sentence={t("empty")}
          actionLabel={t("new")}
          href={createHref}
        />
      ) : (
        <EmptyStateLink
          icon="Navigation"
          sentence={t("emptyReadOnly")}
          actionLabel={t("travelLink")}
          href={base}
        />
      );
  } else if (view === "table") {
    body = (
      <OperationsTable
        caption={t("title")}
        columns={[
          { key: "key", label: t("fields.key"), type: "code", width: 110 },
          { key: "when", label: t("fields.pickupAt"), wrap: true },
          { key: "route", label: t("fields.route"), wrap: true },
          { key: "driver", label: t("fields.driver") },
          { key: "vehicle", label: t("fields.vehicle") },
          { key: "passengers", label: t("fields.passengers"), type: "number", width: 110 },
          { key: "status", label: t("fields.status"), width: 120 },
          { key: "warnings", label: t("fields.warnings"), wrap: true },
        ]}
        rows={rows.data.map((r) => ({
          id: r.id,
          label: r.key,
          key: r.key,
          when: when(r),
          route: title(r),
          driver: r.driverName ?? "",
          vehicle: r.vehicleLabel ?? "",
          passengers: r.passengerCount,
          status: statusLabel(r.status),
          warnings: warnings(r).join(", "),
          href: peekHref(r.key),
          fullHref: hrefWith(base, search, { peek: r.key, full: "1", edit: null }),
          ...(scope.access.can(r.projectId, "hospitality.fulfillment.write")
            ? { trashMessage: t("canceled", { key: r.key }) }
            : {}),
        }))}
        trash={{
          org,
          label: t("cancel"),
          run: cancelTransferAction,
          restore: restoreTransferAction,
        }}
      />
    );
  } else if (view === "calendar") {
    const cal = calendarMonth(search, scope.today);
    body = (
      <OperationsCalendar
        month={cal.month}
        today={cal.today}
        previousMonth={cal.previous}
        nextMonth={cal.next}
        previousLabel={tc("previousMonth")}
        nextLabel={tc("nextMonth")}
        items={rows.data.map((r) => ({
          date: isoDateIn(r.pickupAt, r.pickupTimeZone),
          label: `${r.key} ${title(r)}`,
          state: STATUS_STATE[r.status],
          href: peekHref(r.key),
        }))}
      />
    );
  } else if (view === "resource-schedule") {
    const mode: LaneMode = param(search, "lanes") === "vehicle" ? "vehicle" : "driver";
    const monday = mondayOf(param(search, "week") ?? scope.today);
    const days = weekDays(monday);
    body = (
      <div className="flex flex-col gap-8">
        <nav aria-label={t("lanes.label")} className="flex flex-wrap items-center gap-8">
          <ButtonLink
            href={hrefWith(base, search, { lanes: "driver" })}
            size="sm"
            variant={mode === "driver" ? "primary" : "ghost"}
          >
            {t("lanes.driver")}
          </ButtonLink>
          <ButtonLink
            href={hrefWith(base, search, { lanes: "vehicle" })}
            size="sm"
            variant={mode === "vehicle" ? "primary" : "ghost"}
          >
            {t("lanes.vehicle")}
          </ButtonLink>
          <ButtonLink
            href={hrefWith(base, search, { week: isoShift(monday, -7) })}
            size="sm"
            variant="ghost"
          >
            {tc("previousWeek")}
          </ButtonLink>
          <ButtonLink
            href={hrefWith(base, search, { week: isoShift(monday, 7) })}
            size="sm"
            variant="ghost"
          >
            {tc("nextWeek")}
          </ButtonLink>
        </nav>
        <LaneSchedule
          caption={t("lanes.caption", { date: format.date(monday) ?? "" })}
          laneHeading={mode === "driver" ? t("lanes.driver") : t("lanes.vehicle")}
          days={days}
          dayLabel={(d) => ({ weekday: format.weekday(d), date: format.date(d) ?? "" })}
          lanes={transferLanes(rows.data, mode).map((lane) => ({
            id: lane.id ?? "unassigned",
            label: lane.label ?? (lane.id === null ? t("lanes.unassigned") : tc("unnamed")),
            items: lane.transfers.map((r) => ({
              id: r.id,
              day: isoDateIn(r.pickupAt, r.pickupTimeZone),
              label: `${format.time(r.pickupAt, r.pickupTimeZone)} ${r.key}`,
              state: STATUS_STATE[r.status],
              href: peekHref(r.key),
            })),
          }))}
        />
      </div>
    );
  } else {
    body = (
      <OperationsList
        label={t("title")}
        openLabel={tc("open")}
        items={rows.data.map((r) => ({
          key: r.key,
          href: peekHref(r.key),
          state: STATUS_STATE[r.status],
          stateLabel: statusLabel(r.status),
          title: title(r),
          chips: chips(r),
          next: format.dateTime(r.pickupAt, r.pickupTimeZone) ?? "",
        }))}
      />
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

/** A YYYY-MM-DD day moved by whole days. */
function isoShift(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
