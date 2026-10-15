import {
  findIdByKey,
  getShipment,
  instantToLocal,
  listCounterpartyOptions,
  listFreightTypes,
  listShipments,
  listZoneOptions,
  SHIPMENT_DIRECTIONS,
  SHIPMENT_PROGRESS,
  type Shipment,
  type ShipmentDetail,
  type ShipmentProgress,
} from "@xos/data/logistics";
import type { RecordState } from "@xos/ui";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import {
  addShipmentLineAction,
  addYardEntryAction,
  checkInDockSlotAction,
  createShipmentAction,
  deleteShipmentAction,
  recordGateArrivalAction,
  releaseVehicleAction,
  removeShipmentLineAction,
  restoreShipmentAction,
  updateShipmentAction,
} from "@/app/[org]/logistics/actions";
import { EmptyStateLink, ButtonLink } from "@/components/ui";
import { nodeHref } from "@/lib/shell/sitemap";
import {
  OperationsBoard,
  OperationsCalendar,
  OperationsList,
  OperationsTable,
  ViewSwitcher,
} from "./client";
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
import { RecordView } from "./record";
import { PageHeader, RefusalNotice, TemplateCollection } from "./ui";

/**
 * Shipments (Section 4.5.5 Logistics; journey 20): every inbound and outbound shipment with its
 * derived progress, in list, table, board and calendar views, with the record in a side peek or full
 * page. The sitemap also offers a map view; shipments carry no location, so the map never qualifies
 * and is not offered (Section 11.15).
 */

export const SHIPMENT_VIEWS = ["list", "table", "board", "calendar"] as const;
type ShipmentView = (typeof SHIPMENT_VIEWS)[number];

const PROGRESS_STATE: Record<ShipmentProgress, RecordState> = {
  logged: "proposed",
  booked: "scheduled",
  "at-gate": "ready",
  "checked-in": "active",
  released: "complete",
};

export async function ShipmentsSection({
  scope,
  search,
  base,
  heading,
}: {
  scope: PageScope;
  search: SearchParams;
  /** Path of the page the section renders on. */
  base: string;
  /** The page header; project tabs supply their own section switcher. */
  heading?: ReactNode;
}) {
  const t = await getTranslations("logistics");
  const db = scope.ctx.viewer.db;
  const view = readView<ShipmentView>(search, SHIPMENT_VIEWS, "list");
  const [shipments, carriers, freight] = await Promise.all([
    listShipments(db, {
      orgId: scope.ctx.org.id,
      ...(scope.project ? { projectId: scope.project.id } : {}),
    }),
    listCounterpartyOptions(db, scope.ctx.org.id),
    listFreightTypes(db),
  ]);
  if (!shipments.ok) throw new Error(`Cannot read shipments: ${JSON.stringify(shipments.error)}`);
  if (!carriers.ok) throw new Error(`Cannot read carriers: ${JSON.stringify(carriers.error)}`);
  if (!freight.ok) throw new Error(`Cannot read freight types: ${JSON.stringify(freight.error)}`);
  const freightLabel = new Map(freight.data.map((f) => [f.id, f.label ?? f.code ?? f.id]));
  const writable = writableProjects(scope, "logistics.shipment.write");
  const format = await getZonedFormat();

  const titleOf = (s: Shipment) =>
    s.carrierName
      ? t("shipments.titleWithCarrier", { direction: s.direction, carrier: s.carrierName })
      : t("shipments.titleNoCarrier", { direction: s.direction });
  const progressLabel = (p: ShipmentProgress) => t(`shipments.progress.${p}`);
  const peekHref = (key: string) => hrefWith(base, search, { peek: key, full: null, edit: null });
  const listHref = hrefWith(base, search, { peek: null, full: null, edit: null, create: null });

  // Create and edit drawers, and the refusal when the viewer may not create.
  const fieldsFor = (s?: ShipmentDetail): FieldSpec[] => {
    const zone = s?.timeZone ?? writable[0]?.timeZone ?? "UTC";
    return [
      ...(s
        ? []
        : [
            {
              name: "projectId",
              label: t("shipments.fields.project"),
              kind: "select" as const,
              required: true,
              defaultValue: scope.project?.id ?? writable[0]?.id ?? "",
              options: writable.map((p) => ({ value: p.id, label: `${p.key} ${p.name}` })),
            },
          ]),
      {
        name: "direction",
        label: t("shipments.fields.direction"),
        kind: "select",
        required: true,
        defaultValue: s?.direction ?? "Inbound",
        options: SHIPMENT_DIRECTIONS.map((d) => ({
          value: d,
          label: t(`shipments.direction.${d}`),
        })),
      },
      {
        name: "carrierId",
        label: t("shipments.fields.carrier"),
        kind: "select",
        help: t("shipments.fields.carrierHelp"),
        defaultValue: s?.carrierId ?? "",
        options: [
          { value: "", label: t("common.none") },
          ...carriers.data.map((c) => ({ value: c.id, label: c.name ?? t("common.notSet") })),
        ],
      },
      {
        name: "freightTypeId",
        label: t("shipments.fields.freightType"),
        kind: "select",
        defaultValue: s?.freightTypeId ?? "",
        options: [
          { value: "", label: t("common.notSet") },
          ...freight.data.map((f) => ({ value: f.id, label: f.label ?? f.id })),
        ],
      },
      {
        name: "trackingIdentifier",
        label: t("shipments.fields.tracking"),
        kind: "text",
        defaultValue: s?.trackingIdentifier ?? "",
      },
      {
        name: "shipsAt",
        label: t("shipments.fields.shipsAt"),
        kind: "datetime",
        help: t("common.timeZoneHelp", { zone }),
        defaultValue: s?.shipsAt ? instantToLocal(s.shipsAt, s.timeZone) : "",
      },
      {
        name: "arrivesAt",
        label: t("shipments.fields.arrivesAt"),
        kind: "datetime",
        help: t("common.timeZoneHelp", { zone }),
        defaultValue: s?.arrivesAt ? instantToLocal(s.arrivesAt, s.timeZone) : "",
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
          reason={t("common.refusal.createReason", { thing: t("shipments.title") })}
        />
      ) : (
        <FormDrawer
          title={t("shipments.new")}
          fields={fieldsFor()}
          hidden={{ org: scope.ctx.org.slug }}
          action={createShipmentAction}
          submitLabel={t("shipments.new")}
          closeHref={listHref}
          successHref={hrefWith(base, search, { create: null, peek: "{key}" })}
        />
      );
  }

  // The record, in the peek or on the full page.
  const peekKey = param(search, "peek");
  let record: ReactNode = null;
  if (peekKey) {
    const id = await findIdByKey(db, scope.ctx.org.id, "shipments", peekKey);
    const detail = id.ok ? await getShipment(db, id.data) : id;
    if (!detail.ok && detail.error.kind !== "not-found") {
      throw new Error(`Cannot read shipment: ${JSON.stringify(detail.error)}`);
    }
    if (detail.ok) {
      const s = detail.data;
      const canWrite = scope.access.can(s.projectId, "logistics.shipment.write");
      const full = param(search, "full") === "1";
      record = (
        <>
          <ShipmentRecord
            scope={scope}
            shipment={s}
            mode={full ? "full" : "peek"}
            title={titleOf(s)}
            freight={s.freightTypeId ? (freightLabel.get(s.freightTypeId) ?? null) : null}
            backHref={listHref}
            editHref={hrefWith(base, search, { edit: "1" })}
          />
          {param(search, "edit") === "1" && canWrite ? (
            <FormDrawer
              title={t("shipments.editTitle", { key: s.key })}
              fields={fieldsFor(s)}
              hidden={{ org: scope.ctx.org.slug, id: s.id, expectedUpdatedAt: s.updatedAt }}
              action={updateShipmentAction}
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

  const rows = shipments.data;
  const createHref = hrefWith(base, search, { create: "1", peek: null });
  const header = (
    <PageHeader
      title={t("shipments.title")}
      count={rows.length}
      views={
        <ViewSwitcher
          label={t("common.views.label")}
          current={view}
          options={SHIPMENT_VIEWS.map((v) => ({ value: v, label: t(`common.views.${v}`) }))}
        />
      }
      actions={
        writable.length > 0 ? (
          <ButtonLink href={createHref} variant="primary">
            {t("shipments.new")}
          </ButtonLink>
        ) : undefined
      }
    />
  );

  let body: ReactNode;
  if (rows.length === 0) {
    body =
      scope.projects.length === 0 ? (
        <EmptyStateLink
          icon="FolderPlus"
          sentence={t("shipments.noProjects")}
          actionLabel={t("shipments.noProjectsAction")}
          href={nodeHref("projects.all", scope.params) ?? "/"}
        />
      ) : writable.length > 0 ? (
        <EmptyStateLink
          icon="Truck"
          sentence={t("shipments.empty")}
          actionLabel={t("shipments.emptyAction")}
          href={createHref}
        />
      ) : (
        <EmptyStateLink
          icon="Truck"
          sentence={t("shipments.emptyReadOnly")}
          actionLabel={t("dock.title")}
          href={nodeHref("logistics.dock-schedule", scope.params) ?? "/"}
        />
      );
  } else if (view === "table") {
    body = (
      <OperationsTable
        caption={t("shipments.title")}
        columns={[
          { key: "key", label: t("shipments.fields.key"), type: "code", width: 110 },
          { key: "title", label: t("shipments.fields.direction"), wrap: true },
          { key: "progress", label: t("shipments.fields.progress") },
          { key: "freight", label: t("shipments.fields.freightType") },
          { key: "tracking", label: t("shipments.fields.tracking"), type: "code" },
          { key: "ships", label: t("shipments.fields.shipsAt") },
          { key: "arrives", label: t("shipments.fields.arrivesAt") },
          { key: "lines", label: t("shipments.fields.lines"), type: "number", width: 80 },
        ]}
        rows={rows.map((s) => ({
          key: s.key,
          title: titleOf(s),
          progress: progressLabel(s.progress),
          freight: s.freightTypeId ? (freightLabel.get(s.freightTypeId) ?? "") : "",
          tracking: s.trackingIdentifier ?? "",
          ships: format.dateTime(s.shipsAt, s.timeZone) ?? "",
          arrives: format.dateTime(s.arrivesAt, s.timeZone) ?? "",
          lines: s.lineCount,
          href: peekHref(s.key),
        }))}
      />
    );
  } else if (view === "board") {
    body = (
      <OperationsBoard
        columns={SHIPMENT_PROGRESS.map((p) => ({
          state: PROGRESS_STATE[p],
          label: progressLabel(p),
          cards: rows
            .filter((s) => s.progress === p)
            .map((s) => ({
              key: s.key,
              title: titleOf(s),
              meta: format.dateTime(s.arrivesAt, s.timeZone) ?? s.key,
              href: peekHref(s.key),
            })),
        }))}
      />
    );
  } else if (view === "calendar") {
    const cal = calendarMonth(search);
    body = (
      <OperationsCalendar
        month={cal.month}
        today={cal.today}
        previousMonth={cal.previous}
        nextMonth={cal.next}
        previousLabel={t("common.previousMonth")}
        nextLabel={t("common.nextMonth")}
        items={rows.flatMap((s) => {
          const at = s.arrivesAt ?? s.shipsAt;
          return at
            ? [
                {
                  date: isoDateIn(at, s.timeZone),
                  label: `${s.key} ${titleOf(s)}`,
                  state: PROGRESS_STATE[s.progress],
                  href: peekHref(s.key),
                },
              ]
            : [];
        })}
      />
    );
  } else {
    body = (
      <OperationsList
        label={t("shipments.title")}
        openLabel={t("common.open")}
        items={rows.map((s) => ({
          key: s.key,
          href: peekHref(s.key),
          state: PROGRESS_STATE[s.progress],
          stateLabel: progressLabel(s.progress),
          title: titleOf(s),
          chips: [
            progressLabel(s.progress),
            ...(scope.project ? [] : [s.projectKey]),
            ...(s.freightTypeId && freightLabel.get(s.freightTypeId)
              ? [freightLabel.get(s.freightTypeId) as string]
              : []),
          ],
          ...(s.arrivesAt ? { next: format.dateTime(s.arrivesAt, s.timeZone) ?? "" } : {}),
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

/** The shipment record: properties, actions, manifest, dock slots, gate, yard log and comments. */
async function ShipmentRecord({
  scope,
  shipment: s,
  mode,
  title,
  freight,
  backHref,
  editHref,
}: {
  scope: PageScope;
  shipment: ShipmentDetail;
  mode: "peek" | "full";
  title: string;
  freight: string | null;
  backHref: string;
  editHref: string;
}) {
  const t = await getTranslations("logistics");
  const format = await getZonedFormat();
  const org = scope.ctx.org.slug;
  const canWrite = scope.access.can(s.projectId, "logistics.shipment.write");
  const canYard = scope.access.can(s.projectId, "logistics.yard.write");
  const canDock = canYard || scope.access.can(s.projectId, "logistics.dock_slot.write");
  const canRelease = scope.access.can(s.projectId, "logistics.release.approve");
  const project = scope.projects.find((p) => p.id === s.projectId);
  const zones = project?.venueId
    ? await listZoneOptions(scope.ctx.viewer.db, [project.venueId])
    : null;
  if (zones && !zones.ok) throw new Error(`Cannot read zones: ${JSON.stringify(zones.error)}`);
  const zoneOptions = zones?.ok ? zones.data : [];
  const dockHref = nodeHref("logistics.dock-schedule", scope.params);

  const properties = [
    { label: t("shipments.fields.project"), value: `${s.projectKey} ${s.projectName}` },
    { label: t("shipments.fields.direction"), value: t(`shipments.direction.${s.direction}`) },
    { label: t("shipments.fields.carrier"), value: s.carrierName ?? t("common.notSet") },
    { label: t("shipments.fields.freightType"), value: freight ?? t("common.notSet") },
    { label: t("shipments.fields.tracking"), value: s.trackingIdentifier ?? t("common.notSet") },
    {
      label: t("shipments.fields.shipsAt"),
      value: format.dateTime(s.shipsAt, s.timeZone) ?? t("common.notSet"),
    },
    {
      label: t("shipments.fields.arrivesAt"),
      value: format.dateTime(s.arrivesAt, s.timeZone) ?? t("common.notSet"),
    },
  ];

  const actions = canWrite ? (
    <>
      <ButtonLink href={editHref} size="sm">
        {t("common.edit")}
      </ButtonLink>
      <ActionButton
        label={t("common.delete")}
        variant="ghost"
        run={deleteShipmentAction.bind(null, org, s.id)}
        doneHref={backHref}
        undo={{
          message: t("common.deleted", { key: s.key }),
          restore: restoreShipmentAction.bind(null, org, s.id),
        }}
      />
    </>
  ) : null;

  return (
    <RecordView
      mode={mode}
      kindLabel={t("kinds.shipment")}
      recordKey={s.key}
      title={title}
      state={PROGRESS_STATE[s.progress]}
      stateLabel={t(`shipments.progress.${s.progress}`)}
      properties={properties}
      propertiesLabel={t("common.properties")}
      actions={actions}
      backHref={backHref}
      backLabel={t("common.backToList", { section: t("shipments.title") })}
    >
      <Section id={`manifest-${s.id}`} title={t("shipments.lines.title")}>
        {s.lines.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("shipments.lines.empty")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
            {s.lines.map((line) => (
              <li key={line.id} className="flex flex-wrap items-center justify-between gap-8 py-8">
                <span className="text-text-14">
                  <span className="tabular-nums">{line.quantity}</span> {line.description}
                </span>
                {canWrite ? (
                  <ActionButton
                    label={t("shipments.lines.remove", { description: line.description })}
                    variant="ghost"
                    run={removeShipmentLineAction.bind(null, org, line.id)}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {canWrite ? (
          <InlineForm
            label={t("shipments.lines.add")}
            hidden={{ org, shipmentId: s.id }}
            action={addShipmentLineAction}
            submitLabel={t("shipments.lines.add")}
            fields={[
              {
                name: "description",
                label: t("shipments.lines.description"),
                kind: "text",
                required: true,
              },
              {
                name: "quantity",
                label: t("shipments.lines.quantity"),
                kind: "number",
                defaultValue: "1",
              },
            ]}
          />
        ) : null}
      </Section>

      <Section
        id={`dock-${s.id}`}
        title={t("shipments.dock.title")}
        actions={
          canDock && dockHref ? (
            <ButtonLink
              href={`${dockHref}?create=1&project=${s.projectId}&shipment=${s.id}`}
              size="sm"
            >
              {t("shipments.dock.book")}
            </ButtonLink>
          ) : undefined
        }
      >
        {s.dockSlots.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("shipments.dock.empty")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
            {s.dockSlots.map((slot) => (
              <li key={slot.id} className="flex flex-wrap items-center justify-between gap-8 py-8">
                <span className="flex flex-col gap-2 text-text-14">
                  <span>
                    {slot.zoneName ?? slot.zoneCode}{" "}
                    <span className="text-text-secondary">
                      {t("dock.slot", {
                        start: format.dateTime(slot.startsAt, slot.timeZone) ?? "",
                        end: format.time(slot.endsAt, slot.timeZone),
                      })}
                    </span>
                  </span>
                  {slot.checkedInAt ? (
                    <span className="text-text-12 text-text-secondary">
                      {slot.checkedInByName
                        ? t("dock.checkedIn", {
                            time: format.dateTime(slot.checkedInAt, slot.timeZone) ?? "",
                            name: slot.checkedInByName,
                          })
                        : t("dock.checkedInNoName", {
                            time: format.dateTime(slot.checkedInAt, slot.timeZone) ?? "",
                          })}
                    </span>
                  ) : null}
                </span>
                {!slot.checkedInAt && canDock ? (
                  <ActionButton
                    label={t("dock.checkIn")}
                    variant="primary"
                    run={checkInDockSlotAction.bind(null, org, slot.id)}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section id={`gate-${s.id}`} title={t("shipments.gate.title")}>
        {s.gateEntries.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("shipments.gate.empty")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
            {s.gateEntries.map((g) => (
              <li key={g.id} className="flex flex-wrap items-center justify-between gap-8 py-8">
                <span className="flex flex-col gap-2 text-text-14">
                  <span className="font-mono">{g.vehicleIdentifier}</span>
                  <span className="text-text-12 text-text-secondary">
                    {g.releasedAt
                      ? g.releasedByName
                        ? t("yard.released", {
                            time: format.dateTime(g.releasedAt, g.timeZone) ?? "",
                            name: g.releasedByName,
                          })
                        : t("yard.releasedNoName", {
                            time: format.dateTime(g.releasedAt, g.timeZone) ?? "",
                          })
                      : t("yard.waiting", { time: format.dateTime(g.arrivedAt, g.timeZone) ?? "" })}
                  </span>
                </span>
                {!g.releasedAt && canRelease ? (
                  <ActionButton
                    label={t("yard.release", { vehicle: g.vehicleIdentifier })}
                    variant="primary"
                    run={releaseVehicleAction.bind(null, org, g.id)}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {canYard && !s.gateEntries.some((g) => !g.releasedAt) ? (
          <InlineForm
            label={t("shipments.gate.arrive")}
            hidden={{ org, projectId: s.projectId, shipmentId: s.id }}
            action={recordGateArrivalAction}
            submitLabel={t("shipments.gate.arrive")}
            fields={[
              { name: "vehicleIdentifier", label: t("yard.vehicle"), kind: "text", required: true },
            ]}
          />
        ) : null}
      </Section>

      <Section id={`log-${s.id}`} title={t("shipments.log.title")}>
        {s.log.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("shipments.log.empty")}</p>
        ) : (
          <ol className="m-0 flex list-none flex-col gap-8 p-0">
            {s.log.map((entry) => (
              <li
                key={entry.id}
                className="flex flex-col gap-2 border-s border-border-subtle ps-12"
              >
                <span className="text-text-14">{entry.entry}</span>
                <span className="text-text-12 text-text-secondary">
                  {entry.loggedByName
                    ? t("yard.loggedBy", {
                        time: format.dateTime(entry.loggedAt, entry.timeZone) ?? "",
                        name: entry.loggedByName,
                      })
                    : t("yard.loggedAt", {
                        time: format.dateTime(entry.loggedAt, entry.timeZone) ?? "",
                      })}
                  {entry.zoneCode ? ` · ${entry.zoneCode}` : ""}
                </span>
              </li>
            ))}
          </ol>
        )}
        {canYard ? (
          <InlineForm
            label={t("yard.addEntry")}
            hidden={{ org, projectId: s.projectId, shipmentId: s.id }}
            action={addYardEntryAction}
            submitLabel={t("yard.addEntry")}
            fields={[
              {
                name: "entry",
                label: t("yard.entry"),
                kind: "textarea",
                required: true,
                help: t("yard.entryHelp"),
              },
              {
                name: "zoneId",
                label: t("yard.zone"),
                kind: "select",
                defaultValue: "",
                options: [
                  { value: "", label: t("common.none") },
                  ...zoneOptions.map((z) => ({ value: z.id, label: `${z.code} ${z.name}` })),
                ],
              },
            ]}
          />
        ) : null}
      </Section>

      <RecordCollab
        scope={scope}
        subject={{ table: "app.shipments", id: s.id }}
        canPost={canWrite || canYard}
      />
    </RecordView>
  );
}
