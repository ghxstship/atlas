import { FLIGHT_PHASES, type FlightPhase, type TravelGridRow } from "@xos/data/hospitality";
import type { Transfer } from "@xos/data/transfers";

/**
 * Pure helpers of the B5 travel pages (ADR 0144): the flight grid's built-in views and search, the transfer warnings,
 * and the transfer lanes. Kept out of the components so the unit tests read them without rendering.
 */

/** The flight grid's built-in views (FilterPreset, as R7a's units list): each filters the phase column. */
export const FLIGHT_PRESETS: readonly {
  readonly id: "upcoming" | "inFlight" | "all";
  readonly phases: readonly FlightPhase[];
}[] = [
  { id: "upcoming", phases: ["Upcoming"] },
  { id: "inFlight", phases: ["In Flight", "Departed"] },
  { id: "all", phases: [] },
];

/** The preset's filters in the saved view grammar: `phase=Upcoming`, `phase=In Flight,Departed`, none for All. */
export function presetFilters(phases: readonly FlightPhase[]) {
  return phases.length === 0
    ? []
    : [{ field: "phase", operator: "eq" as const, value: phases.join(",") }];
}

/** The phases a `phase` query value names, ignoring anything that is not one. */
export function phasesOf(value: string | undefined): FlightPhase[] {
  if (!value) return [];
  return value
    .split(",")
    .map((v) => v.trim())
    .filter((v): v is FlightPhase => (FLIGHT_PHASES as readonly string[]).includes(v));
}

/** Search over traveller, flight number, confirmation code and places, case-insensitive. */
export function matchesTravelSearch(row: TravelGridRow, q: string | undefined): boolean {
  const needle = q?.trim().toLowerCase();
  if (!needle) return true;
  return [
    row.travelerName,
    row.serviceIdentifier,
    row.confirmationIdentifier,
    row.operatorName,
    row.departsFrom,
    row.arrivesAtPlace,
    row.finalArrivalPlace,
  ].some((v) => (v ?? "").toLowerCase().includes(needle));
}

export type TransferWarning = "tightTurnaround" | "flightAfterPickup";

/** The warnings a transfer shows beside its status chip. */
export function transferWarnings(
  t: Pick<Transfer, "tightTurnaround" | "flightLandsAfterPickup">,
): TransferWarning[] {
  return [
    ...(t.tightTurnaround ? (["tightTurnaround"] as const) : []),
    ...(t.flightLandsAfterPickup ? (["flightAfterPickup"] as const) : []),
  ];
}

export type LaneMode = "driver" | "vehicle";

/** Lanes of the transfers resource schedule: one per driver or vehicle, unassigned last, in name order. */
export function transferLanes(
  transfers: readonly Transfer[],
  mode: LaneMode,
): { id: string | null; label: string | null; transfers: Transfer[] }[] {
  const lanes = new Map<
    string | null,
    { id: string | null; label: string | null; transfers: Transfer[] }
  >();
  for (const t of transfers) {
    const id = mode === "driver" ? t.driverPersonId : t.vehicleId;
    const label = mode === "driver" ? t.driverName : t.vehicleLabel;
    const lane = lanes.get(id) ?? { id, label, transfers: [] };
    lane.transfers.push(t);
    lanes.set(id, lane);
  }
  return [...lanes.values()].sort((a, b) =>
    a.id === null ? 1 : b.id === null ? -1 : (a.label ?? "").localeCompare(b.label ?? ""),
  );
}
