import {
  listGateQueue,
  listMarshallingLog,
  listShipments,
  listZoneOptions,
  type GateEntry,
  type Shipment,
} from "@xos/data/logistics";
import type { Route } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import {
  addYardEntryAction,
  recordGateArrivalAction,
  releaseVehicleAction,
} from "@/app/[org]/logistics/actions";
import { EmptyStateLink } from "@/components/ui";
import { nodeHref } from "@/lib/shell/sitemap";
import { OperationsBoard, OperationsTable, ViewSwitcher } from "./client";
import { ActionButton, InlineForm, type FieldSpec } from "./forms";
import {
  getZonedFormat,
  hrefWith,
  param,
  readView,
  Section,
  writableProjects,
  type PageScope,
  type SearchParams,
} from "./kit";
import { RecordView } from "./record";
import { PageHeader, RefusalNotice, TemplateCollection } from "./ui";

/**
 * Marshalling yard log (Section 4.5.5 Logistics; journey 20): the gate queue, where vehicles wait and
 * are released into the site by someone with logistics.release.approve, and the append-only yard log
 * of staging and moves. Views: list (queue and log), table (the log) and board (the queue by state).
 */

export const YARD_VIEWS = ["list", "table", "board"] as const;
type YardView = (typeof YARD_VIEWS)[number];

/** Joins short facts in a meta line; a typographic separator, not copy. */
const SEPARATOR = " · ";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function YardSection({
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
  const org = scope.ctx.org.slug;
  const view = readView<YardView>(search, YARD_VIEWS, "list");
  const filter = {
    orgId: scope.ctx.org.id,
    ...(scope.project ? { projectId: scope.project.id } : {}),
  };
  const projects = scope.project ? [scope.project] : scope.projects;
  const venueIds = [...new Set(projects.flatMap((p) => (p.venueId ? [p.venueId] : [])))];
  const [gate, log, shipments, zones] = await Promise.all([
    listGateQueue(db, filter),
    listMarshallingLog(db, filter),
    listShipments(db, filter),
    listZoneOptions(db, venueIds),
  ]);
  if (!gate.ok) throw new Error(`Cannot read the gate queue: ${JSON.stringify(gate.error)}`);
  if (!log.ok) throw new Error(`Cannot read the yard log: ${JSON.stringify(log.error)}`);
  if (!shipments.ok) throw new Error(`Cannot read shipments: ${JSON.stringify(shipments.error)}`);
  if (!zones.ok) throw new Error(`Cannot read zones: ${JSON.stringify(zones.error)}`);
  const shipmentById = new Map(shipments.data.map((s) => [s.id, s]));
  const shipmentsHref = nodeHref("logistics.shipments", scope.params);
  const shipmentTitle = (s: Shipment) =>
    s.carrierName
      ? t("shipments.titleWithCarrier", { direction: s.direction, carrier: s.carrierName })
      : t("shipments.titleNoCarrier", { direction: s.direction });
  const yardWritable = writableProjects(scope, "logistics.yard.write");
  const listHref = hrefWith(base, search, { peek: null, full: null });
  const peekHref = (id: string) => hrefWith(base, search, { peek: id, full: null });

  const projectField = (): FieldSpec[] =>
    scope.project
      ? []
      : [
          {
            name: "projectId",
            label: t("shipments.fields.project"),
            kind: "select",
            required: true,
            defaultValue: yardWritable[0]?.id ?? "",
            options: yardWritable.map((p) => ({ value: p.id, label: `${p.key} ${p.name}` })),
          },
        ];
  const shipmentField: FieldSpec = {
    name: "shipmentId",
    label: t("yard.shipment"),
    kind: "select",
    defaultValue: "",
    options: [
      { value: "", label: t("common.none") },
      ...shipments.data
        .filter((s) => yardWritable.some((p) => p.id === s.projectId))
        .map((s) => ({ value: s.id, label: `${s.key} ${shipmentTitle(s)}` })),
    ],
  };
  const hidden = scope.project ? { org, projectId: scope.project.id } : { org };

  const releaseLine = (g: GateEntry) =>
    g.releasedAt
      ? g.releasedByName
        ? t("yard.released", {
            time: format.dateTime(g.releasedAt, g.timeZone) ?? "",
            name: g.releasedByName,
          })
        : t("yard.releasedNoName", { time: format.dateTime(g.releasedAt, g.timeZone) ?? "" })
      : t("yard.waiting", { time: format.dateTime(g.arrivedAt, g.timeZone) ?? "" });
  const shipmentLink = (shipmentId: string | null) => {
    const s = shipmentId ? shipmentById.get(shipmentId) : undefined;
    if (!s) return null;
    return shipmentsHref ? (
      <Link href={`${shipmentsHref}?peek=${s.key}` as Route} className="text-accent-text">
        {s.key} {shipmentTitle(s)}
      </Link>
    ) : (
      <span>{s.key}</span>
    );
  };

  // A vehicle in the side peek.
  const peekId = param(search, "peek");
  let record: ReactNode = null;
  if (peekId) {
    const g = UUID.test(peekId) ? gate.data.find((x) => x.id === peekId) : undefined;
    if (g) {
      const full = param(search, "full") === "1";
      record = (
        <RecordView
          mode={full ? "full" : "peek"}
          kindLabel={t("kinds.gateEntry")}
          recordKey={g.projectKey}
          title={g.vehicleIdentifier}
          state={g.releasedAt ? "complete" : "active"}
          stateLabel={g.releasedAt ? t("yard.gateState.released") : t("yard.gateState.waiting")}
          propertiesLabel={t("common.properties")}
          backHref={listHref}
          backLabel={t("common.backToList", { section: t("yard.title") })}
          properties={[
            { label: t("shipments.fields.project"), value: g.projectKey },
            { label: t("yard.vehicle"), value: g.vehicleIdentifier },
            { label: t("yard.shipment"), value: shipmentLink(g.shipmentId) ?? t("common.none") },
            { label: t("yard.gateState.waiting"), value: format.dateTime(g.arrivedAt, g.timeZone) },
            {
              label: t("yard.gateState.released"),
              value: g.releasedAt ? releaseLine(g) : t("common.notSet"),
            },
          ]}
          actions={
            !g.releasedAt && scope.access.can(g.projectId, "logistics.release.approve") ? (
              <ActionButton
                label={t("yard.release", { vehicle: g.vehicleIdentifier })}
                variant="primary"
                run={releaseVehicleAction.bind(null, org, g.id)}
              />
            ) : null
          }
        >
          <ol className="m-0 flex list-none flex-col gap-8 p-0">
            {log.data
              .filter((e) => g.shipmentId !== null && e.shipmentId === g.shipmentId)
              .map((e) => (
                <li key={e.id} className="flex flex-col gap-2 border-s border-border-subtle ps-12">
                  <span className="text-text-14">{e.entry}</span>
                  <span className="text-text-12 text-text-secondary">
                    {format.dateTime(e.loggedAt, e.timeZone)}
                  </span>
                </li>
              ))}
          </ol>
        </RecordView>
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

  const header = (
    <PageHeader
      title={t("yard.title")}
      count={log.data.length}
      views={
        <ViewSwitcher
          label={t("common.views.label")}
          current={view}
          options={YARD_VIEWS.map((v) => ({ value: v, label: t(`common.views.${v}`) }))}
        />
      }
    />
  );

  const arrivalForm =
    yardWritable.length > 0 ? (
      <InlineForm
        label={t("yard.arrivalTitle")}
        hidden={hidden}
        action={recordGateArrivalAction}
        submitLabel={t("yard.arrival")}
        fields={[
          ...projectField(),
          { name: "vehicleIdentifier", label: t("yard.vehicle"), kind: "text", required: true },
          shipmentField,
        ]}
      />
    ) : null;
  const entryForm =
    yardWritable.length > 0 ? (
      <InlineForm
        label={t("yard.addEntry")}
        hidden={hidden}
        action={addYardEntryAction}
        submitLabel={t("yard.addEntry")}
        fields={[
          ...projectField(),
          {
            name: "entry",
            label: t("yard.entry"),
            kind: "textarea",
            required: true,
            help: t("yard.entryHelp"),
          },
          shipmentField,
          {
            name: "zoneId",
            label: t("yard.zone"),
            kind: "select",
            defaultValue: "",
            options: [
              { value: "", label: t("common.none") },
              ...zones.data.map((z) => ({ value: z.id, label: `${z.code} ${z.name}` })),
            ],
          },
        ]}
      />
    ) : null;

  const queue = [...gate.data].sort(
    (a, b) =>
      Number(a.releasedAt !== null) - Number(b.releasedAt !== null) ||
      a.arrivedAt.localeCompare(b.arrivedAt),
  );

  let body: ReactNode;
  if (view === "board") {
    body = (
      <>
        {queue.length === 0 ? (
          <EmptyStateLink
            icon="Truck"
            sentence={yardWritable.length > 0 ? t("yard.emptyQueue") : t("yard.emptyQueueReadOnly")}
            actionLabel={yardWritable.length > 0 ? t("yard.arrival") : t("shipments.title")}
            href={
              yardWritable.length > 0
                ? hrefWith(base, search, { view: "list" })
                : (shipmentsHref ?? "/")
            }
          />
        ) : (
          <OperationsBoard
            columns={[
              { state: "active" as const, label: t("yard.gateState.waiting"), released: false },
              { state: "complete" as const, label: t("yard.gateState.released"), released: true },
            ].map((c) => ({
              state: c.state,
              label: c.label,
              cards: queue
                .filter((g) => (g.releasedAt !== null) === c.released)
                .map((g) => ({
                  key: g.id,
                  title: g.vehicleIdentifier,
                  meta: releaseLine(g),
                  href: peekHref(g.id),
                })),
            }))}
          />
        )}
      </>
    );
  } else if (view === "table") {
    body =
      log.data.length === 0 ? (
        <EmptyStateLink
          icon="ClipboardList"
          sentence={yardWritable.length > 0 ? t("yard.emptyLog") : t("yard.emptyLogReadOnly")}
          actionLabel={yardWritable.length > 0 ? t("yard.addEntry") : t("shipments.title")}
          href={
            yardWritable.length > 0
              ? hrefWith(base, search, { view: "list" })
              : (shipmentsHref ?? "/")
          }
        />
      ) : (
        <OperationsTable
          caption={t("yard.logTitle")}
          columns={[
            { key: "time", label: t("yard.columns.time"), width: 190 },
            { key: "project", label: t("yard.columns.project"), type: "code", width: 90 },
            { key: "entry", label: t("yard.columns.entry"), wrap: true },
            { key: "shipment", label: t("yard.columns.shipment"), type: "code" },
            { key: "zone", label: t("yard.columns.zone"), type: "code" },
            { key: "author", label: t("yard.columns.author") },
          ]}
          rows={log.data.map((e) => {
            const s = e.shipmentId ? shipmentById.get(e.shipmentId) : undefined;
            return {
              time: format.dateTime(e.loggedAt, e.timeZone) ?? "",
              project: e.projectKey,
              entry: e.entry,
              shipment: s?.key ?? "",
              zone: e.zoneCode ?? "",
              author: e.loggedByName ?? "",
              href: s && shipmentsHref ? `${shipmentsHref}?peek=${s.key}` : listHref,
            };
          })}
        />
      );
  } else {
    body = (
      <div className="grid gap-24 lg:grid-cols-2">
        <Section id="yard-gate" title={t("yard.gateTitle")}>
          {queue.length === 0 ? (
            <p className="m-0 text-text-13 text-text-secondary">
              {yardWritable.length > 0 ? t("yard.emptyQueue") : t("yard.emptyQueueReadOnly")}
            </p>
          ) : (
            <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle rounded-card border border-border-subtle p-0">
              {queue.map((g) => (
                <li
                  key={g.id}
                  className="flex flex-wrap items-center justify-between gap-8 px-12 py-8"
                >
                  <span className="flex flex-col gap-2">
                    <Link
                      href={peekHref(g.id) as Route}
                      scroll={false}
                      className="font-mono text-text-14 text-accent-text"
                    >
                      {g.vehicleIdentifier}
                    </Link>
                    <span className="text-text-12 text-text-secondary">
                      {g.projectKey} · {releaseLine(g)}
                    </span>
                    {shipmentLink(g.shipmentId)}
                  </span>
                  {!g.releasedAt && scope.access.can(g.projectId, "logistics.release.approve") ? (
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
          {arrivalForm}
        </Section>
        <Section id="yard-log" title={t("yard.logTitle")}>
          {log.data.length === 0 ? (
            <p className="m-0 text-text-13 text-text-secondary">
              {yardWritable.length > 0 ? t("yard.emptyLog") : t("yard.emptyLogReadOnly")}
            </p>
          ) : (
            <ol className="m-0 flex list-none flex-col gap-8 p-0">
              {log.data.map((e) => (
                <li key={e.id} className="flex flex-col gap-2 border-s border-border-subtle ps-12">
                  <span className="text-text-14">{e.entry}</span>
                  <span className="text-text-12 text-text-secondary">
                    {[
                      e.loggedByName
                        ? t("yard.loggedBy", {
                            time: format.dateTime(e.loggedAt, e.timeZone) ?? "",
                            name: e.loggedByName,
                          })
                        : t("yard.loggedAt", {
                            time: format.dateTime(e.loggedAt, e.timeZone) ?? "",
                          }),
                      e.projectKey,
                      e.zoneCode,
                    ]
                      .filter(Boolean)
                      .join(SEPARATOR)}
                  </span>
                  {shipmentLink(e.shipmentId)}
                </li>
              ))}
            </ol>
          )}
          {entryForm}
        </Section>
      </div>
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
      peek={record}
    >
      {body}
    </TemplateCollection>
  );
}
