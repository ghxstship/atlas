/**
 * Today for a person who works the project only on a party's roster (R8, Section 4.5.7): when to arrive and
 * the call, their parking pass, the gear they hold and what waits for them at the desk, and whom to ask. Every
 * row is their own (api_external views filtered to their entries); a colleague's never reaches the device.
 * Pure, so the rules are unit tested.
 */

export interface RosterEntryRow {
  readonly id: string;
  readonly project_id?: string | null;
  readonly arrival_starts_at?: string | null;
  readonly arrival_ends_at?: string | null;
  readonly arrival_time_zone?: string | null;
}

export interface AllocationRow {
  readonly id: string;
  readonly roster_entry_id?: string | null;
  readonly kind?: string | null;
  readonly item_name?: string | null;
  readonly quantity?: number | string | null;
  readonly allocation_state?: string | null;
  readonly display_status?: string | null;
}

export interface ParkingPassRow {
  readonly id: string;
  readonly project_id?: string | null;
  readonly category_name?: string | null;
  readonly zone_names?: readonly string[] | null;
  readonly vehicle_make?: string | null;
  readonly vehicle_model?: string | null;
  readonly vehicle_color?: string | null;
  readonly revoked_at?: string | null;
}

export interface CustodyRow {
  readonly id: string;
  readonly roster_entry_id?: string | null;
  readonly class_name?: string | null;
  readonly asset_tag?: string | null;
}

export interface ShiftRow {
  readonly starts_at: string;
  readonly time_zone?: string | null;
}

/** Statuses of an approved allocation not yet handed over: what the person picks up. */
export const PENDING_PICKUP = [
  "Approved",
  "Reserved",
  "Awaiting Order",
  "On Order",
  "Confirmed",
  "Received",
] as const;

export interface RosterToday {
  readonly arrival: {
    readonly startsAt: string;
    readonly endsAt: string;
    readonly timeZone: string;
  } | null;
  /** The earliest of the person's own shifts today, else the start of their arrival window. */
  readonly call: {
    readonly at: string;
    readonly timeZone: string;
    readonly source: "shift" | "arrival";
  } | null;
  readonly parking: readonly {
    readonly id: string;
    readonly category: string;
    readonly zones: readonly string[];
    readonly vehicle: string;
  }[];
  /** Units the person holds now: class and tag. */
  readonly gear: readonly { readonly id: string; readonly label: string }[];
  /** Approved items waiting at the desk. */
  readonly pickups: readonly {
    readonly id: string;
    readonly label: string;
    readonly status: string;
  }[];
}

function localDay(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

export function rosterToday(input: {
  readonly entries: readonly RosterEntryRow[];
  readonly allocations: readonly AllocationRow[];
  readonly passes: readonly ParkingPassRow[];
  readonly custody: readonly CustodyRow[];
  /** The person's own shifts on the project, if any. */
  readonly shifts: readonly ShiftRow[];
  readonly projectTimeZone: string;
  /** Today on the project calendar, `YYYY-MM-DD`. */
  readonly today: string;
}): RosterToday {
  const entryIds = new Set(input.entries.map((e) => e.id));
  const withArrival = input.entries
    .filter((e) => e.arrival_starts_at && e.arrival_ends_at)
    .sort((a, b) => String(a.arrival_starts_at).localeCompare(String(b.arrival_starts_at)))[0];
  const arrival = withArrival
    ? {
        startsAt: String(withArrival.arrival_starts_at),
        endsAt: String(withArrival.arrival_ends_at),
        timeZone: withArrival.arrival_time_zone ?? input.projectTimeZone,
      }
    : null;
  const shift = input.shifts
    .filter((s) => localDay(s.starts_at, input.projectTimeZone) === input.today)
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at))[0];
  const call = shift
    ? {
        at: shift.starts_at,
        timeZone: shift.time_zone ?? input.projectTimeZone,
        source: "shift" as const,
      }
    : arrival
      ? { at: arrival.startsAt, timeZone: arrival.timeZone, source: "arrival" as const }
      : null;
  const mine = input.allocations.filter(
    (a) => a.roster_entry_id && entryIds.has(a.roster_entry_id),
  );
  return {
    arrival,
    call,
    parking: input.passes
      .filter((p) => !p.revoked_at)
      .map((p) => ({
        id: p.id,
        category: p.category_name ?? "",
        zones: p.zone_names ?? [],
        vehicle: [p.vehicle_make, p.vehicle_model, p.vehicle_color]
          .map((v) => v?.trim() ?? "")
          .filter((v) => v !== "")
          .join(" "),
      })),
    gear: input.custody
      .filter((c) => c.roster_entry_id && entryIds.has(c.roster_entry_id))
      .map((c) => ({
        id: c.id,
        label: c.asset_tag ? `${c.class_name ?? ""} (${c.asset_tag})`.trim() : (c.class_name ?? ""),
      })),
    pickups: mine
      .filter(
        (a) =>
          a.allocation_state === "Approved" &&
          (PENDING_PICKUP as readonly string[]).includes(String(a.display_status)),
      )
      .map((a) => ({
        id: a.id,
        label: `${a.item_name ?? a.kind ?? ""} (${Number(a.quantity ?? 0)})`,
        status: String(a.display_status),
      })),
  };
}
