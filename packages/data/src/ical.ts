/**
 * An RFC 5545 iCalendar writer for calendar feeds (Section 4.6.5, ADR 0038). No dependencies and no
 * Node built-ins, so Atlas and Gateway route handlers and the tests share it.
 *
 * - Lines end in CRLF and fold at 75 octets of UTF-8 (RFC 5545 3.1), never inside a character.
 * - TEXT values escape backslash, semicolon, comma and newlines (3.3.11).
 * - Each event keeps the IANA zone its times were typed in: DTSTART and DTEND carry TZID and local
 *   time, and the calendar carries one VTIMEZONE per zone, built from the platform's time zone data
 *   for the span the events cover (3.6.5). A zone the platform does not know falls back to UTC.
 * - UID is the row id, so an event keeps its identity across fetches; SEQUENCE grows with every
 *   change; a canceled shift or record stays with STATUS:CANCELLED.
 */

export type ICalEventStatus = "tentative" | "confirmed" | "cancelled";

export interface ICalEvent {
  /** Stable row id; the UID is `<id>@xos`. */
  readonly id: string;
  readonly summary: string;
  readonly description?: string | null;
  readonly startsAt: Date;
  /** Null for a point in time (a milestone or deadline). */
  readonly endsAt: Date | null;
  /** IANA zone the times were typed in. */
  readonly timeZone: string | null;
  readonly status: ICalEventStatus;
  readonly sequence: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly url?: string | null;
  readonly categories?: readonly string[];
  /** Busy time (shifts, meetings) or free time (milestones and deadlines). */
  readonly transparent?: boolean;
}

export interface ICalCalendar {
  readonly name: string;
  /** The feed's own zone, for clients that show one (X-WR-TIMEZONE). */
  readonly timeZone: string;
  readonly events: readonly ICalEvent[];
  /** How often clients should refresh, in minutes (REFRESH-INTERVAL, RFC 7986). */
  readonly refreshMinutes?: number;
}

const PRODID = "-//XOS//Calendar Feed 4.0//EN";
const UID_DOMAIN = "xos";
const encoder = new TextEncoder();

/** Escapes a TEXT value (RFC 5545 3.3.11). */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/** Folds one content line at 75 octets, continuing with CRLF and a space (RFC 5545 3.1). */
export function foldLine(line: string): string {
  if (encoder.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = "";
  let size = 0;
  let limit = 75;
  for (const char of line) {
    const bytes = encoder.encode(char).length;
    if (size + bytes > limit) {
      parts.push(current);
      current = "";
      size = 0;
      // Continuation lines start with one space, which counts toward their 75 octets.
      limit = 74;
    }
    current += char;
    size += bytes;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** A UTC DATE-TIME: 20261021T130000Z. */
export function utcStamp(date: Date): string {
  return (
    `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

const formatters = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(zone: string): Intl.DateTimeFormat | null {
  if (!formatters.has(zone)) {
    try {
      formatters.set(
        zone,
        new Intl.DateTimeFormat("en-US", {
          timeZone: zone,
          hourCycle: "h23",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
      );
    } catch {
      formatters.set(zone, null);
    }
  }
  return formatters.get(zone) ?? null;
}

/** True when the platform's time zone data knows the IANA zone. */
export function isKnownZone(zone: string | null | undefined): zone is string {
  return typeof zone === "string" && zone !== "" && formatterFor(zone) !== null;
}

interface LocalParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function localParts(zone: string, instant: number): LocalParts {
  const formatter = formatterFor(zone);
  if (formatter === null) throw new Error(`Unknown time zone ${zone}`);
  const values: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(instant))) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return {
    year: values["year"] ?? 1970,
    month: values["month"] ?? 1,
    day: values["day"] ?? 1,
    hour: (values["hour"] ?? 0) % 24,
    minute: values["minute"] ?? 0,
    second: values["second"] ?? 0,
  };
}

/** The zone's UTC offset at an instant, in whole minutes. */
export function offsetMinutes(zone: string, instant: number): number {
  const p = localParts(zone, instant);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(instant / 1000) * 1000) / 60000);
}

function localStamp(parts: LocalParts): string {
  return (
    `${pad(parts.year, 4)}${pad(parts.month)}${pad(parts.day)}` +
    `T${pad(parts.hour)}${pad(parts.minute)}${pad(parts.second)}`
  );
}

/** Local DATE-TIME of an instant in a zone: 20261021T090000. */
export function zonedStamp(zone: string, date: Date): string {
  return localStamp(localParts(zone, date.getTime()));
}

function offsetText(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
}

const DAY = 86_400_000;

interface Transition {
  /** First instant of the new offset. */
  readonly at: number;
  readonly from: number;
  readonly to: number;
}

/** Offset changes of a zone between two instants, to the minute. */
export function zoneTransitions(zone: string, start: number, end: number): Transition[] {
  const found: Transition[] = [];
  let previous = offsetMinutes(zone, start);
  for (let t = start + DAY; t <= end + DAY; t += DAY) {
    const current = offsetMinutes(zone, t);
    if (current === previous) continue;
    // Narrow the change down to the minute within the day.
    let lo = t - DAY;
    let hi = t;
    while (hi - lo > 60_000) {
      const mid = lo + Math.floor((hi - lo) / 120_000) * 60_000;
      if (offsetMinutes(zone, mid) === previous) lo = mid;
      else hi = mid;
    }
    found.push({ at: hi, from: previous, to: current });
    previous = current;
  }
  return found;
}

/**
 * A VTIMEZONE for a zone, valid from `start` to `end`: one observance for the offset in force at
 * `start` (dated at the last change before it, within a year), then one per change in the span.
 */
export function vtimezone(zone: string, start: number, end: number): string[] {
  const lead = zoneTransitions(zone, start - 366 * DAY, start);
  const first = lead.at(-1);
  const transitions = [
    ...(first ? [first] : []),
    ...zoneTransitions(zone, start, end).filter((t) => t.at > start),
  ];
  const lines = ["BEGIN:VTIMEZONE", `TZID:${zone}`];
  if (transitions.length === 0) {
    const offset = offsetText(offsetMinutes(zone, start));
    lines.push(
      "BEGIN:STANDARD",
      "DTSTART:19700101T000000",
      `TZOFFSETFROM:${offset}`,
      `TZOFFSETTO:${offset}`,
      "END:STANDARD",
    );
  } else {
    for (const t of transitions) {
      const kind = t.to > t.from ? "DAYLIGHT" : "STANDARD";
      // DTSTART is the local time of the change, read in the offset in force before it.
      const before = new Date(t.at + t.from * 60_000);
      const onset = localStamp({
        year: before.getUTCFullYear(),
        month: before.getUTCMonth() + 1,
        day: before.getUTCDate(),
        hour: before.getUTCHours(),
        minute: before.getUTCMinutes(),
        second: before.getUTCSeconds(),
      });
      lines.push(
        `BEGIN:${kind}`,
        `DTSTART:${onset}`,
        `TZOFFSETFROM:${offsetText(t.from)}`,
        `TZOFFSETTO:${offsetText(t.to)}`,
        `END:${kind}`,
      );
    }
  }
  lines.push("END:VTIMEZONE");
  return lines;
}

function property(name: string, value: string): string {
  return foldLine(`${name}:${value}`);
}

function dateProperty(name: string, date: Date, zone: string | null): string {
  return zone === null
    ? property(name, utcStamp(date))
    : property(`${name};TZID=${zone}`, zonedStamp(zone, date));
}

/** Writes a VCALENDAR document for a calendar feed. */
export function writeICalendar(calendar: ICalCalendar): string {
  const zoneFor = (event: ICalEvent) => (isKnownZone(event.timeZone) ? event.timeZone : null);
  const spans = new Map<string, { start: number; end: number }>();
  for (const event of calendar.events) {
    const zone = zoneFor(event);
    if (zone === null) continue;
    const start = event.startsAt.getTime();
    const end = (event.endsAt ?? event.startsAt).getTime();
    const span = spans.get(zone);
    spans.set(zone, {
      start: Math.min(span?.start ?? start, start),
      end: Math.max(span?.end ?? end, end),
    });
  }
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${PRODID}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    property("NAME", escapeText(calendar.name)),
    property("X-WR-CALNAME", escapeText(calendar.name)),
  ];
  if (isKnownZone(calendar.timeZone)) lines.push(property("X-WR-TIMEZONE", calendar.timeZone));
  const refresh = Math.max(15, Math.round(calendar.refreshMinutes ?? 60));
  lines.push(`REFRESH-INTERVAL;VALUE=DURATION:PT${refresh}M`, `X-PUBLISHED-TTL:PT${refresh}M`);
  for (const [zone, span] of [...spans].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(...vtimezone(zone, span.start - DAY, span.end + DAY).map((l) => foldLine(l)));
  }
  for (const event of calendar.events) {
    const zone = zoneFor(event);
    lines.push(
      "BEGIN:VEVENT",
      property("UID", `${event.id}@${UID_DOMAIN}`),
      property("DTSTAMP", utcStamp(event.updatedAt)),
      property("CREATED", utcStamp(event.createdAt)),
      property("LAST-MODIFIED", utcStamp(event.updatedAt)),
      property("SEQUENCE", String(Math.max(0, Math.trunc(event.sequence)))),
      dateProperty("DTSTART", event.startsAt, zone),
    );
    if (event.endsAt !== null && event.endsAt.getTime() > event.startsAt.getTime()) {
      lines.push(dateProperty("DTEND", event.endsAt, zone));
    }
    lines.push(property("SUMMARY", escapeText(event.summary)));
    if (event.description) lines.push(property("DESCRIPTION", escapeText(event.description)));
    if (event.categories && event.categories.length > 0) {
      lines.push(property("CATEGORIES", event.categories.map(escapeText).join(",")));
    }
    if (event.url) lines.push(property("URL", event.url));
    lines.push(
      `STATUS:${event.status.toUpperCase()}`,
      `TRANSP:${event.transparent ? "TRANSPARENT" : "OPAQUE"}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.join("\r\n")}\r\n`;
}
