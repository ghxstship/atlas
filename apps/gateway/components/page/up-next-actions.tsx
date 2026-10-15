"use client";

import { Button, buttonClass } from "@xos/ui";
import type { Route } from "next";
import NextLink from "next/link";

/** An iCalendar event for one dated item (RFC 5545), so it can be added to any calendar in one tap. */
export function icsFor(input: {
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly location: string | null;
  readonly uid: string;
}): string {
  const stamp = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const escape = (text: string) => text.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, "\\n");
  const end = input.endsAt ?? new Date(new Date(input.startsAt).getTime() + 3_600_000).toISOString();
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//XOS//Gateway//EN",
    "BEGIN:VEVENT",
    `UID:${input.uid}`,
    `DTSTAMP:${stamp(new Date().toISOString())}`,
    `DTSTART:${stamp(input.startsAt)}`,
    `DTEND:${stamp(end)}`,
    `SUMMARY:${escape(input.title)}`,
    ...(input.location ? [`LOCATION:${escape(input.location)}`] : []),
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

/** The Up Next card's actions: open the engagement, and add the item to the calendar. */
export function UpNextActions(props: {
  title: string;
  startsAt: string | null;
  endsAt: string | null;
  location: string | null;
  openHref: string;
  labels: { open: string; calendar: string };
}) {
  const { startsAt } = props;
  return (
    <div className="flex flex-wrap items-center gap-8">
      <NextLink href={props.openHref as Route} className={buttonClass("primary", "md")}>
        {props.labels.open}
      </NextLink>
      {startsAt ? (
        <Button
          icon="CalendarPlus"
          onClick={() => {
            const ics = icsFor({
              title: props.title,
              startsAt,
              endsAt: props.endsAt,
              location: props.location,
              uid: `${startsAt}-${props.title}`.replace(/[^A-Za-z0-9-]/g, ""),
            });
            const url = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
            const a = document.createElement("a");
            a.href = url;
            a.download = `${props.title.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase() || "event"}.ics`;
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          {props.labels.calendar}
        </Button>
      ) : null}
    </div>
  );
}
