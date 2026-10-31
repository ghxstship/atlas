import { dateIn, instantOfLocalIn } from "./calendar.ts";

/**
 * A whole-stay itinerary (B6, G-65, ADR 0145): a person's travel, hotel nights and set times grouped
 * by day, with the rows changed since they last looked marked. Gateway's Travel and Lodging and
 * Hospitality tabs and Compass Travel and lodging build it from the same api_external rows, so the
 * three read alike. Pure: no clock, no network.
 *
 * Placement follows how a traveller reads the day:
 *   * a segment sits on the day it departs, in its departure zone (a 23:00 Los Angeles flight
 *     landing in New York the next morning is on the Los Angeles day);
 *   * a check-in sits on check_in_on and a check-out on check_out_on, as calendar dates in the hotel's
 *     own calendar, so a daylight saving change never moves them;
 *   * a set time sits on its day in the project's zone.
 * Within a day items run by instant. A check-out sorts at 11:00 and a check-in at 15:00 in the
 * project zone, the usual hotel times, so the morning flight and the afternoon arrival read in order.
 */

export type ItineraryChangeKind = "added" | "changed" | "removed";

export interface ItineraryTravel {
  readonly id: string;
  readonly engagement_id?: string | null;
  readonly travel_mode: string;
  readonly operator_name: string | null;
  readonly service_identifier: string | null;
  readonly confirmation_identifier?: string | null;
  readonly departs_from: string;
  readonly departs_at: string;
  readonly departs_time_zone: string;
  readonly arrives_at_place: string;
  readonly arrives_at: string | null;
  readonly arrives_time_zone: string;
}

export interface ItineraryLodging {
  readonly id: string;
  readonly hotel_name: string | null;
  readonly block_title: string | null;
  readonly guest_name?: string | null;
  readonly check_in_on: string;
  readonly check_out_on: string;
}

export interface ItinerarySetTime {
  readonly id: string;
  readonly label: string;
  readonly planned_at: string | null;
  readonly duration: string | null;
}

/** A row of api_external.itinerary_changes (2952). */
export interface ItineraryChangeRow {
  readonly subject_kind: string | null;
  readonly subject_id: string | null;
  readonly change_kind: string | null;
  readonly changed_fields: readonly string[] | null;
  readonly changed_at: string | null;
  readonly baseline_at: string | null;
  readonly title: string | null;
}

export interface ItemChange {
  readonly kind: ItineraryChangeKind;
  readonly fields: readonly string[];
}

export type ItineraryItem =
  | {
      readonly type: "travel";
      readonly id: string;
      readonly at: string;
      readonly travel: ItineraryTravel;
      readonly changed: ItemChange | null;
    }
  | {
      readonly type: "check-in" | "check-out";
      readonly id: string;
      readonly at: string;
      readonly lodging: ItineraryLodging;
      readonly changed: ItemChange | null;
    }
  | {
      readonly type: "set";
      readonly id: string;
      readonly at: string;
      readonly set: ItinerarySetTime;
      readonly changed: ItemChange | null;
    };

export interface ItineraryDay {
  /** The calendar date, `YYYY-MM-DD`. */
  readonly date: string;
  readonly items: readonly ItineraryItem[];
}

export interface RemovedItem {
  readonly kind: "travel" | "lodging" | "set_time";
  readonly id: string;
  /** The route ("MIA → JFK") or hotel the database titled it with. */
  readonly title: string | null;
  readonly changedAt: string | null;
}

export interface Itinerary {
  readonly days: readonly ItineraryDay[];
  readonly removed: readonly RemovedItem[];
  /** The instant compared against; null on a first visit, when nothing is marked. */
  readonly baselineAt: string | null;
}

export interface BuildItineraryInput {
  readonly travel: readonly ItineraryTravel[];
  readonly lodging: readonly ItineraryLodging[];
  readonly setTimes?: readonly ItinerarySetTime[];
  readonly changes: readonly ItineraryChangeRow[];
  readonly projectZone: string | null;
  /**
   * Changes at or before this instant are hidden: Compass records a visit when the screen opens and
   * shows only what changed after the baseline it gets back.
   */
  readonly hideAtOrBefore?: string | null;
}

const KIND_OF: Record<ItineraryItem["type"], string> = {
  travel: "travel",
  "check-in": "lodging",
  "check-out": "lodging",
  set: "set_time",
};

function toKind(value: string | null): ItineraryChangeKind {
  return value === "added" || value === "removed" ? value : "changed";
}

function isAfter(at: string | null, bound: string | null | undefined): boolean {
  if (!bound) return true;
  if (!at) return false;
  return Date.parse(at) > Date.parse(bound);
}

function hotelInstant(day: string, time: string, zone: string | null): string {
  return instantOfLocalIn(`${day}T${time}`, zone) ?? `${day}T${time}:00Z`;
}

/** Builds the day groups and the removed list. */
export function buildItinerary(input: BuildItineraryInput): Itinerary {
  const visible = input.changes.filter(
    (c) => c.subject_id !== null && isAfter(c.changed_at, input.hideAtOrBefore),
  );
  const changeOf = new Map<string, ItemChange>();
  const removed: RemovedItem[] = [];
  for (const c of visible) {
    const kind = toKind(c.change_kind);
    if (kind === "removed") {
      const k =
        c.subject_kind === "lodging" || c.subject_kind === "set_time" ? c.subject_kind : "travel";
      removed.push({
        kind: k,
        id: c.subject_id as string,
        title: c.title,
        changedAt: c.changed_at,
      });
      continue;
    }
    changeOf.set(`${c.subject_kind ?? ""}:${c.subject_id}`, {
      kind,
      fields: c.changed_fields ?? [],
    });
  }
  const changed = (type: ItineraryItem["type"], id: string): ItemChange | null => {
    const change = changeOf.get(`${KIND_OF[type]}:${id}`) ?? null;
    if (!change || change.kind === "added" || (type !== "check-in" && type !== "check-out"))
      return change;
    // A room's change marks the line it moved: the check-in for its first night, the check-out for its last.
    const own = type === "check-in" ? "check_in_on" : "check_out_on";
    const fields = change.fields.filter((f) => f === own || f === "hotel");
    return fields.length > 0 ? { kind: change.kind, fields } : null;
  };

  const items: { date: string; item: ItineraryItem }[] = [];
  for (const t of input.travel) {
    items.push({
      date: dateIn(new Date(t.departs_at), t.departs_time_zone),
      item: {
        type: "travel",
        id: t.id,
        at: t.departs_at,
        travel: t,
        changed: changed("travel", t.id),
      },
    });
  }
  for (const l of input.lodging) {
    items.push({
      date: l.check_in_on,
      item: {
        type: "check-in",
        id: l.id,
        at: hotelInstant(l.check_in_on, "15:00", input.projectZone),
        lodging: l,
        changed: changed("check-in", l.id),
      },
    });
    items.push({
      date: l.check_out_on,
      item: {
        type: "check-out",
        id: l.id,
        at: hotelInstant(l.check_out_on, "11:00", input.projectZone),
        lodging: l,
        changed: changed("check-out", l.id),
      },
    });
  }
  for (const s of input.setTimes ?? []) {
    if (!s.planned_at) continue;
    items.push({
      date: dateIn(new Date(s.planned_at), input.projectZone),
      item: { type: "set", id: s.id, at: s.planned_at, set: s, changed: changed("set", s.id) },
    });
  }

  const byDate = new Map<string, ItineraryItem[]>();
  for (const { date, item } of items) {
    const list = byDate.get(date) ?? [];
    list.push(item);
    byDate.set(date, list);
  }
  const days = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, list]) => ({
      date,
      items: [...list].sort(
        (a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id),
      ),
    }));

  const baselineAt = input.changes.find((c) => c.baseline_at)?.baseline_at ?? null;
  return { days, removed, baselineAt };
}

/** Whether any item of an itinerary is marked or removed. */
export function hasItineraryChanges(itinerary: Itinerary): boolean {
  return itinerary.removed.length > 0 || itinerary.days.some((d) => d.items.some((i) => i.changed));
}
