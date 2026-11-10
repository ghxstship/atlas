import { useMemo, useState, type ReactElement } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { DataTable, type DataTableColumn } from "../src/index.ts";

/**
 * Section 11.2: a list of 10,000 rows scrolls at 60 fps. test/visual/frame-timing.spec.ts scrolls
 * this table and measures its frames; the rows are built once, as a page holds them after a fetch.
 */
const meta: Meta = { title: "Performance/DataTable", parameters: { layout: "padded" } };
export default meta;

const STATES = [
  { state: "active", label: "Active" },
  { state: "in-review", label: "In Review" },
  { state: "blocked", label: "Blocked" },
  { state: "complete", label: "Complete" },
] as const;

const ITEMS = ["Stage Deck rental", "Line Array", "Truss Box", "Coffee Service", "Generator"];
const DEPARTMENTS = ["Production", "Audio", "Lighting", "Catering", "Power"];

const ROW_COUNT = 10_000;

const columns: DataTableColumn[] = [
  { key: "key", label: "Key", type: "code" },
  { key: "title", label: "Title" },
  { key: "department", label: "Department" },
  { key: "state", label: "State", type: "state" },
  { key: "quantity", label: "Quantity", type: "number" },
  { key: "amount", label: "Amount", type: "money" },
];

function rows(): Record<string, unknown>[] {
  return Array.from({ length: ROW_COUNT }, (_, i) => ({
    id: `row-${i}`,
    key: `NWL-${1000 + i}`,
    title: `${ITEMS[i % ITEMS.length]} ${Math.floor(i / ITEMS.length) + 1}`,
    department: DEPARTMENTS[(i * 7) % DEPARTMENTS.length],
    state: STATES[i % STATES.length],
    quantity: (i * 13) % 40,
    amount: i % 11 === 0 ? null : ((i * 7919) % 500_000) / 100,
  }));
}

function TenThousand(): ReactElement {
  const data = useMemo(rows, []);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  return (
    <DataTable
      caption="Purchase order lines"
      columns={columns}
      rows={data}
      selection={{ selected, onChange: setSelected }}
      cardFields={false}
    />
  );
}

export const TenThousandRows: StoryObj = {
  name: "10,000 rows",
  render: () => <TenThousand />,
};
