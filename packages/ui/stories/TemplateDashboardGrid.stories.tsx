import { useState, type ReactElement } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Card,
  DateRangePicker,
  PageHeader,
  StatTile,
  TemplateDashboard,
  type DashboardSpans,
  type DashboardTile,
} from "../src/index.ts";

/**
 * The Section 11.6 Dashboard on production components: tiles on the 12-column grid with their spans,
 * the date range picker in the header row, and resizing by drag or by the arrow keys on each tile's
 * handle (Home and End jump to the limits). The saved spans print below the grid, as Atlas saves them
 * to the person's dashboard layout setting.
 */
const meta: Meta = { title: "Templates/TemplateDashboard grid", parameters: { layout: "padded" } };
export default meta;

const TILES: DashboardTile[] = [
  {
    id: "committed",
    label: "Committed",
    span: 3,
    content: <StatTile label="Committed" value={33284} format="money" />,
  },
  {
    id: "blockers",
    label: "Open blockers",
    span: 3,
    content: <StatTile label="Open blockers" value={3} />,
  },
  {
    id: "crew",
    label: "Crew filled",
    span: 3,
    content: <StatTile label="Crew filled" value={46} />,
  },
  { id: "due", label: "Due today", span: 3, content: <StatTile label="Due today" value={7} /> },
  {
    id: "readiness",
    label: "Gate readiness",
    span: 8,
    minSpan: 4,
    content: <Card>Gate readiness for the active projects.</Card>,
  },
  { id: "alerts", label: "Alerts", span: 4, content: <Card>Two permits expire this week.</Card> },
];

function Grid({ resizable }: { resizable: boolean }): ReactElement {
  const [saved, setSaved] = useState<DashboardSpans>({});
  return (
    <div className="flex flex-col gap-16">
      <TemplateDashboard
        header={<PageHeader title="Home" />}
        controls={<DateRangePicker label="Date range" start="2026-11-16" end="2026-11-22" />}
        tiles={TILES}
        spans={saved}
        label="Home tiles"
        {...(resizable
          ? {
              resize: {
                label: (tile: string) => `Resize ${tile}`,
                describe: (tile: string, span: number) => `${tile}, ${span} of 12 columns`,
                onChange: setSaved,
              },
            }
          : {})}
      />
      {resizable ? (
        <output className="font-mono text-text-12 text-text-secondary">
          {JSON.stringify(saved)}
        </output>
      ) : null}
    </div>
  );
}

export const Spans: StoryObj = { render: () => <Grid resizable={false} /> };

export const Resizable: StoryObj = { render: () => <Grid resizable /> };
