import { useState, type ReactElement } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Timeline,
  type TimelineChange,
  type TimelineLink,
  type TimelineProps,
} from "../src/index.ts";
import { pushSuccessors } from "../src/Charts/timeline-plan.ts";

/**
 * Drag to reschedule (Section 11.11, A133): drag a bar to move it or an end to resize it, or focus a
 * bar and use the arrow keys (Shift for the end), then Apply or press Enter. The preview shows the
 * successors the change pushes along the links and whether the critical path changes. The Load-In
 * Window is locked into a baseline, so a change that would push it cannot be applied.
 */
const meta: Meta = { title: "Data display/Timeline/Reschedule", parameters: { layout: "padded" } };
export default meta;

const days: TimelineProps["days"] = Array.from({ length: 21 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 10, 2 + i));
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
  };
});

const start: TimelineProps["rows"] = [
  { key: "NWL-140", title: "Load-in", state: "complete", start: 0, end: 2, locked: true },
  { key: "NWL-141", title: "Stage build", state: "active", start: 3, end: 6, dependsOn: 0 },
  { key: "NWL-142", title: "Rig the line array", state: "ready", start: 7, end: 8, dependsOn: 1 },
  { key: "NWL-143", title: "Lighting focus", state: "ready", start: 9, end: 10, dependsOn: 2 },
  { key: "NWL-144", title: "Merch booth build", state: "proposed", start: 4, end: 6 },
  {
    key: "NWL-145",
    title: "Load-In Window closes",
    state: "scheduled",
    start: 14,
    end: 14,
    milestone: true,
    locked: true,
    dependsOn: 3,
  },
];

const links: TimelineLink[] = [
  { from: 0, to: 1 },
  { from: 1, to: 2 },
  { from: 2, to: 3 },
  { from: 3, to: 5, lagDays: 2 },
];

function Reschedulable(): ReactElement {
  const [rows, setRows] = useState(start);
  // The page's part: apply the change and the pushes the preview showed (a server does this in Atlas).
  const apply = (change: TimelineChange) =>
    setRows((list) => {
      const after = pushSuccessors(list, links, change) ?? list;
      return list.map((r, i) => ({
        ...r,
        start: after[i]?.start ?? r.start,
        end: after[i]?.end ?? r.end,
      }));
    });
  return (
    <Timeline
      label="Main Stage"
      days={days}
      rows={rows}
      links={links}
      today={3}
      gates={[{ day: 7, label: "Gate 5" }]}
      onReschedule={apply}
    />
  );
}

export const DragToReschedule: StoryObj = {
  name: "Drag to reschedule",
  render: () => <Reschedulable />,
};
