import { listTravelGrid, type TravelGridRow } from "@xos/data/hospitality";
import type { RecordState } from "@xos/ui";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { EmptyStateLink } from "@/components/ui";
import {
  FLIGHT_PRESETS,
  matchesTravelSearch,
  phasesOf,
  presetFilters,
} from "@/lib/hospitality/travel";
import { nodeHref } from "@/lib/shell/sitemap";
import { OperationsList, OperationsTable } from "./client";
import { getZonedFormat, param, readView, type PageScope, type SearchParams } from "./kit";
import { TravelGridViews } from "./travel-grid-views";
import { PageHeader, TemplateCollection } from "./ui";

/**
 * Hospitality > Travel (B5, G-58): every live flight the viewer may read across the org or the project, with the
 * journey it belongs to (Leg n of m, Final arrival) and its phase now, from app.travel_grid. Built-in views filter the
 * phase; the export (CSV, .xlsx and PDF) reads the same relation with the same filters. Every time shows in the zone
 * it was entered in. The fare never appears.
 */

export const TRAVEL_VIEWS = ["table", "list"] as const;
type TravelView = (typeof TRAVEL_VIEWS)[number];

const PHASE_STATE: Record<TravelGridRow["phase"], RecordState> = {
  Upcoming: "scheduled",
  "In Flight": "active",
  Departed: "active",
  Landed: "complete",
};

export async function TravelGridSection({
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
  const t = (await getTranslations("hospitality.travelGrid")) as unknown as (
    key: string,
    values?: Record<string, string | number>,
  ) => string;
  const tc = await getTranslations("logistics.common");
  const format = await getZonedFormat();
  const view = readView<TravelView>(search, TRAVEL_VIEWS, "table");
  const phases = phasesOf(param(search, "phase"));
  const rows = await listTravelGrid(scope.ctx.viewer.db, {
    orgId: scope.ctx.org.id,
    ...(scope.project ? { projectId: scope.project.id } : {}),
    phases,
  });
  if (!rows.ok) throw new Error(`Cannot read the flight grid: ${JSON.stringify(rows.error)}`);
  const shown = rows.data.filter((r) => matchesTravelSearch(r, param(search, "q")));

  const phaseLabel = (r: TravelGridRow) =>
    t(`phase.${r.phase === "In Flight" ? "inFlight" : r.phase.toLowerCase()}`);
  const leg = (r: TravelGridRow) => t("leg", { leg: r.legNumber, count: r.legCount });
  const departs = (r: TravelGridRow) => format.dateTime(r.departsAt, r.departsTimeZone) ?? "";
  const arrives = (r: TravelGridRow) =>
    format.dateTime(r.arrivesAt, r.arrivesTimeZone) ?? t("arrivalUnknown");
  const finalArrival = (r: TravelGridRow) =>
    r.legCount > 1
      ? t("finalArrival", {
          place: r.finalArrivalPlace ?? "",
          at:
            format.dateTime(r.finalArrivalAt, r.finalArrivalTimeZone ?? r.arrivesTimeZone) ??
            t("arrivalUnknown"),
        })
      : "";
  const traveler = (r: TravelGridRow) => r.travelerName ?? tc("unnamed");
  const route = (r: TravelGridRow) => t("route", { from: r.departsFrom, to: r.arrivesAtPlace });

  const header = (
    <PageHeader
      title={t("title")}
      count={shown.length}
      views={
        <TravelGridViews
          label={tc("views.label")}
          view={view}
          options={TRAVEL_VIEWS.map((v) => ({ value: v, label: tc(`views.${v}`) }))}
          presets={FLIGHT_PRESETS.map((p) => ({
            id: p.id,
            name: t(`views.${p.id}`),
            filters: presetFilters(p.phases),
          }))}
        />
      }
    />
  );

  let body: ReactNode;
  if (shown.length === 0) {
    body = (
      <EmptyStateLink
        icon="Plane"
        sentence={phases.length > 0 || param(search, "q") ? t("emptyFiltered") : t("empty")}
        actionLabel={phases.length > 0 || param(search, "q") ? t("views.all") : t("emptyAction")}
        href={
          phases.length > 0 || param(search, "q")
            ? base
            : (nodeHref("hospitality.fulfillments", scope.params) ?? "/")
        }
      />
    );
  } else if (view === "list") {
    body = (
      <OperationsList
        label={t("title")}
        openLabel={tc("open")}
        items={shown.map((r) => ({
          key: r.id,
          href: nodeHref("hospitality.fulfillments", scope.params) ?? "/",
          state: PHASE_STATE[r.phase],
          stateLabel: phaseLabel(r),
          title: `${traveler(r)} ${r.serviceIdentifier ?? ""}`.trim(),
          chips: [route(r), leg(r), ...(r.legCount > 1 ? [finalArrival(r)] : [])],
          next: departs(r),
        }))}
      />
    );
  } else {
    body = (
      <OperationsTable
        caption={t("title")}
        columns={[
          { key: "traveler", label: t("columns.traveler"), wrap: true },
          { key: "flight", label: t("columns.flight"), type: "code", width: 110 },
          { key: "route", label: t("columns.route") },
          { key: "departs", label: t("columns.departs") },
          { key: "arrives", label: t("columns.arrives") },
          { key: "final", label: t("columns.finalArrival"), wrap: true },
          { key: "leg", label: t("columns.leg"), width: 110 },
          { key: "confirmation", label: t("columns.confirmation"), type: "code", width: 120 },
          { key: "phase", label: t("columns.phase"), width: 120 },
        ]}
        rows={shown.map((r) => ({
          id: r.id,
          label: `${traveler(r)} ${r.serviceIdentifier ?? ""}`.trim(),
          traveler: traveler(r),
          flight: r.serviceIdentifier ?? "",
          route: route(r),
          departs: departs(r),
          arrives: arrives(r),
          final: finalArrival(r),
          leg: leg(r),
          confirmation: r.confirmationIdentifier ?? "",
          phase: phaseLabel(r),
          href: nodeHref("hospitality.fulfillments", scope.params) ?? "/",
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
    >
      {body}
    </TemplateCollection>
  );
}
