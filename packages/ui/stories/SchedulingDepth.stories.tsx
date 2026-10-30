import type { ReactElement } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Calendar,
  Heatmap,
  SpreadsheetGrid,
  Timeline,
  type GridColumn,
  type TimelineProps,
} from "../src/index.ts";
import { parseTimeShorthand } from "../src/Editing/quickAddCore.ts";

/**
 * Scheduling depth (B4, RRR-228): day types as text-labelled tags on the timeline and the calendar, production
 * segments on a portfolio row and the anchor's Offset column (G-38, G-44); the day grid's time shorthand, append row
 * and errors in place (G-41); and the workload heatmap, a native table with text in every cell (G-45).
 */
const meta: Meta = { title: "Data display/Scheduling depth", parameters: { layout: "padded" } };
export default meta;

const days: TimelineProps["days"] = Array.from({ length: 10 }, (_, i) => {
  const d = new Date(Date.UTC(2027, 10, 10 + i));
  const tags =
    i === 2
      ? [{ label: "Load In", category: 1 as const, icon: "Truck" }]
      : i === 3
        ? [{ label: "Show", category: 2 as const, icon: "Ticket" }]
        : i === 4
          ? [
              { label: "Load Out", category: 3 as const, icon: "Package" },
              { label: "Travel to Austin", category: 4 as const, icon: "Plane" },
            ]
          : undefined;
  return {
    dow: "SMTWTFS"[d.getUTCDay()] ?? "",
    date: d.getUTCDate(),
    weekend: d.getUTCDay() === 0 || d.getUTCDay() === 6,
    label: d.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    }),
    ...(tags ? { tags } : {}),
  };
});

export const TimelineDayTypes: StoryObj = {
  name: "Timeline with day types and the anchor",
  render: (): ReactElement => (
    <Timeline
      label="Demo Summer Series"
      days={days}
      anchorDay={3}
      gates={[{ day: 3, label: "Anchor" }]}
      rows={[
        { key: "NWS-12", title: "Hang the truss", state: "active", start: 1, end: 2 },
        {
          key: "NWS-13",
          title: "Doors Open",
          state: "scheduled",
          start: 3,
          end: 3,
          milestone: true,
        },
        {
          key: "NWS",
          title: "Demo Summer Series",
          state: "active",
          start: 0,
          end: 6,
          segments: [
            { label: "Load In", category: 1, icon: "Truck", start: 2, end: 2 },
            { label: "Show", category: 2, icon: "Ticket", start: 3, end: 3 },
            { label: "Load Out", category: 3, icon: "Package", start: 4, end: 4 },
          ],
        },
      ]}
    />
  ),
};

export const CalendarDayTypes: StoryObj = {
  name: "Calendar with day types",
  render: (): ReactElement => (
    <Calendar
      month="2027-11-01"
      today="2027-11-12"
      events={[{ date: "2027-11-13", label: "NWS-13 Doors Open", state: "scheduled" }]}
      days={[
        { date: "2027-11-12", tags: [{ label: "Load In", category: 1, icon: "Truck" }] },
        { date: "2027-11-13", tags: [{ label: "Show", category: 2, icon: "Ticket" }] },
        {
          date: "2027-11-14",
          tags: [
            { label: "Load Out", category: 3, icon: "Package" },
            { label: "Travel", category: 4, icon: "Plane" },
          ],
        },
      ]}
    />
  ),
};

const gridColumns: GridColumn[] = [
  {
    key: "time",
    label: "Time",
    type: "time",
    editable: true,
    width: 140,
    parse: (text) => {
      const s = parseTimeShorthand(text);
      return s
        ? `${s.start}${s.end ? `–${s.end}${s.endDayOffset ? " +1" : ""}` : ""}`
        : text.trim() || null;
    },
  },
  { key: "title", label: "Title", editable: true, width: 280 },
  { key: "kind", label: "Kind", editable: true, width: 120 },
  { key: "owner", label: "Owner", editable: true, width: 160 },
  { key: "tbc", label: "TBC", editable: true, width: 64 },
];

export const DayGrid: StoryObj = {
  name: "Spreadsheet grid with an append row",
  render: (): ReactElement => (
    <SpreadsheetGrid
      label="Records on November 13"
      columns={gridColumns}
      rows={[
        {
          time: "08:00–10:30",
          title: "Hang the truss",
          kind: "Task",
          owner: "Frank Adeyemi",
          tbc: null,
        },
        { time: "19:00", title: "Doors Open", kind: "Milestone", owner: null, tbc: null },
        {
          time: "22:30–00:30 +1",
          title: "Installing the truss",
          kind: "Task",
          owner: null,
          tbc: "TBC",
        },
      ]}
      appendRow
      errors={{ "2:title": "A Task title starts with an imperative verb, not “Installing”." }}
    />
  ),
};

export const WorkloadHeatmap: StoryObj = {
  name: "Heatmap",
  render: (): ReactElement => (
    <Heatmap
      label="Hours per person, November 10 to 16"
      rowHeader="Person"
      rows={[
        { key: "frank", label: "Frank Adeyemi" },
        { key: "dana", label: "Dana Ortiz" },
      ]}
      columns={["Wed 10", "Thu 11", "Fri 12", "Sat 13", "Sun 14"].map((label, i) => ({
        key: String(i),
        label,
        fullLabel: `November ${10 + i}`,
      }))}
      cells={{
        "frank:0": { text: "4 h", step: 2 },
        "frank:1": { text: "8 h", step: 3 },
        "frank:2": { text: "11.5 h", step: 4, over: "Over 10 h" },
        "dana:2": { text: "2 h", step: 1 },
        "dana:3": { text: "10 h", step: 4 },
      }}
      onCellActivate={() => undefined}
    />
  ),
};
