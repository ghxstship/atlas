import { describe, expect, it } from "vitest";
import {
  escapeText,
  foldLine,
  isKnownZone,
  offsetMinutes,
  utcStamp,
  writeICalendar,
  zonedStamp,
  zoneTransitions,
  type ICalEvent,
} from "../src/ical.ts";

/**
 * The calendar feed writer against RFC 5545. The parser below is deliberately strict and
 * independent of the writer: it checks the line rules (CRLF, 75-octet folding that never splits a
 * character), the component structure and required properties, unescapes TEXT, and turns every
 * TZID-qualified local time back into an instant through the VTIMEZONE observances in the file
 * itself, so a wrong offset or onset fails the round trip.
 */

interface Property {
  readonly name: string;
  readonly params: Record<string, string>;
  readonly value: string;
}

interface Component {
  readonly name: string;
  readonly properties: Property[];
  readonly components: Component[];
}

const octets = (s: string) => new TextEncoder().encode(s).length;

function parse(text: string): Component {
  expect(text.endsWith("\r\n"), "the file ends with CRLF").toBe(true);
  const physical = text.slice(0, -2).split("\r\n");
  for (const line of physical) {
    expect(line.includes("\n") || line.includes("\r"), `bare line break in ${line}`).toBe(false);
    expect(octets(line), `line over 75 octets: ${line}`).toBeLessThanOrEqual(75);
    expect(line.includes("�"), "a fold split a character").toBe(false);
  }
  const logical: string[] = [];
  for (const line of physical) {
    if (line.startsWith(" ") || line.startsWith("\t")) {
      expect(logical.length, "a continuation line follows a content line").toBeGreaterThan(0);
      logical[logical.length - 1] += line.slice(1);
    } else logical.push(line);
  }
  const root: Component = { name: "", properties: [], components: [] };
  const stack: Component[] = [root];
  for (const line of logical) {
    const colon = line.search(/:(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    expect(colon, `no colon in ${line}`).toBeGreaterThan(0);
    const [name, ...rawParams] = line.slice(0, colon).split(";");
    const value = line.slice(colon + 1);
    expect(name, line).toMatch(/^[A-Z][A-Z0-9-]*$/);
    const params: Record<string, string> = {};
    for (const p of rawParams) {
      const [k, v] = p.split("=");
      expect(k, line).toMatch(/^[A-Z][A-Z0-9-]*$/);
      params[k as string] = v ?? "";
    }
    const top = stack[stack.length - 1] as Component;
    if (name === "BEGIN") {
      const child: Component = { name: value, properties: [], components: [] };
      top.components.push(child);
      stack.push(child);
    } else if (name === "END") {
      expect(top.name, `END:${value} closes ${top.name}`).toBe(value);
      stack.pop();
    } else top.properties.push({ name: name as string, params, value });
  }
  expect(stack.length, "every BEGIN has its END").toBe(1);
  expect(root.components.length).toBe(1);
  return root.components[0] as Component;
}

const one = (c: Component, name: string) => {
  const found = c.properties.filter((p) => p.name === name);
  expect(found.length, `${c.name} has one ${name}`).toBe(1);
  return found[0] as Property;
};

function unescape(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_m, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

function stampParts(value: string) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
  expect(m, `DATE-TIME ${value}`).not.toBeNull();
  const [y, mo, d, h, mi, s] = (m as RegExpExecArray).slice(1, 7).map(Number) as number[];
  return {
    wall: Date.UTC(y as number, (mo as number) - 1, d, h, mi, s),
    utc: (m as RegExpExecArray)[7] === "Z",
  };
}

function offsetOf(text: string): number {
  const m = /^([+-])(\d{2})(\d{2})$/.exec(text);
  expect(m, `UTC offset ${text}`).not.toBeNull();
  const [, sign, h, mi] = (m as RegExpExecArray).map(String);
  return (sign === "-" ? -1 : 1) * (Number(h) * 60 + Number(mi));
}

/** The instant a TZID-qualified local time names, by the file's own VTIMEZONE for that zone. */
function resolve(calendar: Component, property: Property): number {
  const { wall, utc } = stampParts(property.value);
  if (utc) return wall;
  const tzid = property.params["TZID"];
  expect(tzid, "a local time names its zone").toBeDefined();
  const zone = calendar.components.find(
    (c) => c.name === "VTIMEZONE" && one(c, "TZID").value === tzid,
  );
  expect(zone, `VTIMEZONE ${tzid}`).toBeDefined();
  const observances = (zone as Component).components
    .map((o) => {
      expect(["STANDARD", "DAYLIGHT"]).toContain(o.name);
      return {
        onset: stampParts(one(o, "DTSTART").value).wall,
        from: offsetOf(one(o, "TZOFFSETFROM").value),
        to: offsetOf(one(o, "TZOFFSETTO").value),
      };
    })
    .sort((a, b) => a.onset - b.onset);
  // The offset in force at an instant: the last observance whose onset (local time read in its
  // TZOFFSETFROM) has passed. A local time names the instants whose offset in force agrees with
  // it; when it names two (the hour repeated when clocks go back), RFC 5545 3.3.5 takes the first.
  const inForce = (instant: number) => {
    let offset = (observances[0] as { from: number }).from;
    for (const o of observances) if (instant >= o.onset - o.from * 60_000) offset = o.to;
    return offset;
  };
  const candidates = [...new Set(observances.flatMap((o) => [o.from, o.to]))]
    .map((offset) => wall - offset * 60_000)
    .filter((instant) => wall - inForce(instant) * 60_000 === instant);
  expect(candidates.length, `${property.value} exists in ${tzid}`).toBeGreaterThan(0);
  return Math.min(...candidates);
}

const base = {
  sequence: 0,
  createdAt: new Date("2026-10-01T12:00:00Z"),
  updatedAt: new Date("2026-10-02T08:30:00Z"),
};

function event(overrides: Partial<ICalEvent> & Pick<ICalEvent, "id" | "startsAt">): ICalEvent {
  return {
    summary: "Stagehand · Northwind Summer Series",
    endsAt: null,
    timeZone: "America/New_York",
    status: "confirmed",
    ...base,
    ...overrides,
  };
}

const EVENTS: ICalEvent[] = [
  event({
    id: "0192a000-0000-7000-8000-000000000001",
    startsAt: new Date("2027-03-14T06:30:00Z"),
    endsAt: new Date("2027-03-14T15:00:00Z"),
    description: "Northwind Summer Series\nMain Stage",
    url: "https://atlas.example.test/northwind/my-work",
  }),
  event({
    id: "0192a000-0000-7000-8000-000000000002",
    summary: "Rigging plot; v4, final \\ signed",
    startsAt: new Date("2027-11-07T05:30:00Z"),
    endsAt: new Date("2027-11-07T07:30:00Z"),
    status: "cancelled",
    sequence: 86_400,
  }),
  event({
    id: "0192a000-0000-7000-8000-000000000003",
    summary: "Sonido y luces del escenario principal, revisión técnica completa 🎛️ con el equipo",
    startsAt: new Date("2027-04-05T14:45:00Z"),
    timeZone: "Australia/Lord_Howe",
    transparent: true,
  }),
  event({
    id: "0192a000-0000-7000-8000-000000000004",
    startsAt: new Date("2027-01-10T04:00:00Z"),
    endsAt: new Date("2027-01-10T12:00:00Z"),
    timeZone: "Asia/Kolkata",
    status: "tentative",
  }),
  event({
    id: "0192a000-0000-7000-8000-000000000005",
    startsAt: new Date("2027-02-01T18:00:00Z"),
    endsAt: new Date("2027-02-01T18:00:00Z"),
    timeZone: "Mars/Olympus_Mons",
  }),
];

describe("writeICalendar", () => {
  const text = writeICalendar({
    name: "My schedule at Northwind Live, the long name that folds",
    timeZone: "America/New_York",
    events: EVENTS,
  });
  const calendar = parse(text);

  it("writes one VCALENDAR with the required properties", () => {
    expect(calendar.name).toBe("VCALENDAR");
    expect(one(calendar, "VERSION").value).toBe("2.0");
    expect(one(calendar, "PRODID").value).toMatch(/^-\/\/XOS\/\//);
    expect(one(calendar, "METHOD").value).toBe("PUBLISH");
    expect(unescape(one(calendar, "X-WR-CALNAME").value)).toBe(
      "My schedule at Northwind Live, the long name that folds",
    );
    expect(one(calendar, "X-WR-TIMEZONE").value).toBe("America/New_York");
    expect(one(calendar, "REFRESH-INTERVAL").params["VALUE"]).toBe("DURATION");
  });

  it("gives every event a stable UID, a UTC DTSTAMP, a SEQUENCE and a STATUS", () => {
    const events = calendar.components.filter((c) => c.name === "VEVENT");
    expect(events).toHaveLength(EVENTS.length);
    events.forEach((e, i) => {
      expect(one(e, "UID").value).toBe(`${(EVENTS[i] as ICalEvent).id}@xos`);
      expect(stampParts(one(e, "DTSTAMP").value).utc).toBe(true);
      expect(one(e, "SEQUENCE").value).toMatch(/^\d+$/);
      expect(["CONFIRMED", "TENTATIVE", "CANCELLED"]).toContain(one(e, "STATUS").value);
      one(e, "DTSTART");
    });
    expect(one(events[1] as Component, "STATUS").value).toBe("CANCELLED");
    expect(one(events[1] as Component, "SEQUENCE").value).toBe("86400");
    expect(one(events[2] as Component, "TRANSP").value).toBe("TRANSPARENT");
  });

  it("round-trips every time through the file's own VTIMEZONE, across DST changes", () => {
    const events = calendar.components.filter((c) => c.name === "VEVENT");
    events.forEach((e, i) => {
      const source = EVENTS[i] as ICalEvent;
      expect(resolve(calendar, one(e, "DTSTART")), source.id).toBe(source.startsAt.getTime());
      const end = e.properties.find((p) => p.name === "DTEND");
      if (source.endsAt && source.endsAt > source.startsAt) {
        expect(resolve(calendar, end as Property), source.id).toBe(source.endsAt.getTime());
      } else expect(end, "a point in time has no DTEND").toBeUndefined();
    });
  });

  it("keeps each event's own zone and falls back to UTC for a zone nobody knows", () => {
    const events = calendar.components.filter((c) => c.name === "VEVENT");
    expect(one(events[0] as Component, "DTSTART").params["TZID"]).toBe("America/New_York");
    expect(one(events[2] as Component, "DTSTART").params["TZID"]).toBe("Australia/Lord_Howe");
    expect(one(events[4] as Component, "DTSTART").value).toBe("20270201T180000Z");
    const zones = calendar.components
      .filter((c) => c.name === "VTIMEZONE")
      .map((z) => one(z, "TZID").value);
    expect(zones).toEqual(["America/New_York", "Asia/Kolkata", "Australia/Lord_Howe"]);
  });

  it("escapes and folds text without splitting a character", () => {
    const events = calendar.components.filter((c) => c.name === "VEVENT");
    expect(unescape(one(events[1] as Component, "SUMMARY").value)).toBe(
      "Rigging plot; v4, final \\ signed",
    );
    expect(unescape(one(events[2] as Component, "SUMMARY").value)).toBe(
      (EVENTS[2] as ICalEvent).summary,
    );
    expect(unescape(one(events[0] as Component, "DESCRIPTION").value)).toBe(
      "Northwind Summer Series\nMain Stage",
    );
    expect(one(events[0] as Component, "URL").value).toBe(
      "https://atlas.example.test/northwind/my-work",
    );
  });
});

describe("iCalendar parts", () => {
  it("escapes TEXT", () => {
    expect(escapeText("a;b,c\\d\ne\r\nf")).toBe("a\\;b\\,c\\\\d\\ne\\nf");
  });

  it("folds only past 75 octets, continuing with one space", () => {
    expect(foldLine("A".repeat(75))).toBe("A".repeat(75));
    const folded = foldLine(`SUMMARY:${"é".repeat(60)}`);
    for (const line of folded.split("\r\n")) expect(octets(line)).toBeLessThanOrEqual(75);
    expect(
      folded
        .split("\r\n")
        .slice(1)
        .every((l) => l.startsWith(" ")),
    ).toBe(true);
    expect(folded.replace(/\r\n /g, "")).toBe(`SUMMARY:${"é".repeat(60)}`);
  });

  it("formats UTC and zoned times", () => {
    const at = new Date("2027-07-04T16:05:09Z");
    expect(utcStamp(at)).toBe("20270704T160509Z");
    expect(zonedStamp("America/Los_Angeles", at)).toBe("20270704T090509");
    expect(offsetMinutes("Asia/Kathmandu", at.getTime())).toBe(345);
  });

  it("finds a zone's offset changes to the minute", () => {
    const changes = zoneTransitions(
      "Europe/Madrid",
      Date.parse("2027-01-01T00:00:00Z"),
      Date.parse("2027-12-31T00:00:00Z"),
    );
    expect(changes.map((c) => [new Date(c.at).toISOString(), c.from, c.to])).toEqual([
      ["2027-03-28T01:00:00.000Z", 60, 120],
      ["2027-10-31T01:00:00.000Z", 120, 60],
    ]);
  });

  it("knows real zones only", () => {
    expect(isKnownZone("America/Chicago")).toBe(true);
    expect(isKnownZone("Mars/Olympus_Mons")).toBe(false);
    expect(isKnownZone(null)).toBe(false);
  });

  it("writes a fixed-offset zone and an empty calendar", () => {
    const text = writeICalendar({ name: "Empty", timeZone: "Nowhere/Unknown", events: [] });
    const calendar = parse(text);
    expect(calendar.components).toHaveLength(0);
    expect(calendar.properties.some((p) => p.name === "X-WR-TIMEZONE")).toBe(false);
    const utc = parse(
      writeICalendar({
        name: "UTC",
        timeZone: "UTC",
        events: [event({ id: "u", startsAt: new Date("2027-05-01T10:00:00Z"), timeZone: "UTC" })],
      }),
    );
    const zone = utc.components.find((c) => c.name === "VTIMEZONE") as Component;
    expect(zone.components.map((o) => one(o, "TZOFFSETTO").value)).toEqual(["+0000"]);
  });
});
