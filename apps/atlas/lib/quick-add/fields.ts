import { zonedInstant, type QuickAddResult } from "@xos/ui/quick-add";

/**
 * From a saved quick add line to the fields of a record or a shift (Section 11.7, ADR 0073). Shared by
 * the client rows, which send what the line set, and the server actions, which turn its wall-clock
 * date into instants in the zone of the project the record or shift lands in.
 */

/** A date phrase as a wall clock: the day, the time when one was named, and the end of a range. */
export interface QuickAddWhen {
  readonly iso: string;
  readonly time?: string | undefined;
  readonly endIso?: string | undefined;
  readonly endTime?: string | undefined;
}

/** What a quick add line set, by id: the person, tag, kind and scope it resolved to, and its date. */
export interface QuickAddInput {
  readonly title: string;
  readonly personId: string | null;
  readonly tagId: string | null;
  readonly kind: string | null;
  readonly scopeNodeId: string | null;
  readonly when: QuickAddWhen | null;
}

/** The ids and date a finalized line set; each type is set once at most. */
export function quickAddInput(result: QuickAddResult): QuickAddInput {
  const id = (type: string) => result.tokens.find((t) => t.type === type)?.id ?? null;
  const date = result.tokens.find((t) => t.type === "date" && t.iso);
  return {
    title: result.title,
    personId: id("person"),
    tagId: id("tag"),
    kind: id("kind"),
    scopeNodeId: id("scope"),
    when: date?.iso
      ? {
          iso: date.iso,
          ...(date.time ? { time: date.time } : {}),
          ...(date.endIso ? { endIso: date.endIso } : {}),
          ...(date.endTime ? { endTime: date.endTime } : {}),
        }
      : null,
  };
}

/** A day with no time starts a record or shift at 08:00, the New shift form's default call. */
export const DAY_START = "08:00";
/** A day with no time ends a record at 17:00, the close of the working day. */
export const DAY_END = "17:00";
/** A shift with no end time runs eight hours, as the New shift form's default does. */
export const SHIFT_HOURS = 8;

export interface RecordWhen {
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly dueAt: string | null;
}

/**
 * A record's dates from a line: one date is when it is due, a range is when it starts and ends.
 * Times are read in the zone given, the project's.
 */
export function recordWhen(when: QuickAddWhen | null, zone: string): RecordWhen {
  if (when === null) return { startsAt: null, endsAt: null, dueAt: null };
  if (when.endIso === undefined) {
    return {
      startsAt: null,
      endsAt: null,
      dueAt: zonedInstant(when.iso, when.time ?? DAY_END, zone),
    };
  }
  return {
    startsAt: zonedInstant(when.iso, when.time ?? DAY_START, zone),
    endsAt: zonedInstant(when.endIso, when.endTime ?? DAY_END, zone),
    dueAt: null,
  };
}

/** A shift's call and end from a line, or null when the line names no date. */
export function shiftWhen(
  when: QuickAddWhen | null,
  zone: string,
): { readonly startsAt: string; readonly endsAt: string } | null {
  if (when === null) return null;
  const startsAt = zonedInstant(when.iso, when.time ?? DAY_START, zone);
  const endsAt =
    when.endIso !== undefined && (when.endTime !== undefined || when.time === undefined)
      ? zonedInstant(when.endIso, when.endTime ?? DAY_END, zone)
      : new Date(Date.parse(startsAt) + SHIFT_HOURS * 3_600_000).toISOString();
  return { startsAt, endsAt };
}
