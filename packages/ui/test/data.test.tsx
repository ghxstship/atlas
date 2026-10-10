import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  ActivityFeedItem,
  Board,
  BulkActionBar,
  DataTable,
  RecordList,
  RecordRow,
  StatTile,
  StateChip,
  TreeView,
  XOSProvider,
} from "../src/index.ts";
import type { DataTableColumn } from "../src/index.ts";
import { expectAccessible } from "./a11y.ts";

const columns: DataTableColumn[] = [
  { key: "code", label: "Code", type: "code" },
  { key: "name", label: "Line" },
  { key: "qty", label: "Qty", type: "number" },
  { key: "rate", label: "Rate", type: "money" },
  { key: "state", label: "State", type: "state" },
  { key: "notes", label: "Notes", wrap: true },
];

const rows = [
  {
    code: "5000.01",
    name: "Line Array Package",
    qty: 2,
    rate: 4200,
    state: { state: "active", label: "Active" },
    notes: "Flown",
  },
  {
    code: "5000.02",
    name: "Monitor World",
    qty: null,
    rate: null,
    state: { state: "proposed", label: "Proposed" },
    notes: null,
  },
  { code: "5000.03", name: "Delay Towers", qty: 4, rate: 0, state: "bad", notes: "Ground" },
];

describe("DataTable", () => {
  it("renders a labeled grid with NULL-aware money and totals", async () => {
    const { container } = render(
      <DataTable
        caption="Audio"
        columns={columns}
        rows={rows}
        totals={{ rate: null }}
        density="compact"
        pinStart={["code"]}
      />,
    );
    const grid = screen.getByRole("grid");
    expect(screen.getByRole("region", { name: "Audio" })).toBeTruthy();
    expect(grid.getAttribute("aria-rowcount")).toBe("5");
    expect(within(grid).getAllByText("Unpriced")).toHaveLength(2);
    expect(within(grid).getByText("$0.00")).toBeTruthy();
    expect(within(grid).getByText("Total")).toBeTruthy();
    await expectAccessible(container);
  });

  it("moves through cells with the keyboard and activates a row with Enter", async () => {
    const onRowActivate = vi.fn();
    render(
      <DataTable columns={columns} rows={rows} onRowActivate={onRowActivate} totalsLabel="Sum" />,
    );
    const cells = screen.getAllByRole("gridcell");
    expect(cells[0]?.getAttribute("tabindex")).toBe("0");
    expect(cells[1]?.getAttribute("tabindex")).toBe("-1");
    act(() => cells[0]?.focus());
    await userEvent.keyboard("{ArrowRight}");
    expect(document.activeElement?.textContent).toBe("Line Array Package");
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement?.textContent).toBe("Monitor World");
    await userEvent.keyboard("{End}");
    expect(document.activeElement?.getAttribute("aria-colindex")).toBe("6");
    await userEvent.keyboard("{Control>}{Home}{/Control}");
    expect(document.activeElement?.textContent).toBe("5000.01");
    await userEvent.keyboard("{Control>}{End}{/Control}{Home}{PageUp}");
    expect(document.activeElement?.textContent).toBe("5000.01");
    await userEvent.keyboard("{PageDown}{ArrowLeft}{Enter}");
    expect(onRowActivate).toHaveBeenCalledWith(rows[2], 2);
    fireEvent.doubleClick(screen.getByText("Line Array Package"));
    expect(onRowActivate).toHaveBeenCalledWith(rows[0], 0);
  });

  it("resizes a column from its handle with arrow keys", async () => {
    render(<DataTable columns={columns.slice(0, 2)} rows={rows} pinEnd={["name"]} />);
    const handle = screen.getByRole("separator", { name: /Code/ });
    expect(handle.getAttribute("aria-valuenow")).toBe("128");
    handle.focus();
    await userEvent.keyboard("{ArrowRight}{ArrowRight}{ArrowLeft}");
    expect(handle.getAttribute("aria-valuenow")).toBe("144");
    fireEvent.doubleClick(handle);
    expect(handle.getAttribute("aria-valuenow")).toBe("128");
  });

  it("virtualizes 10,000 rows and keeps the row count for assistive technology", async () => {
    const oh = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
    const ow = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
    const many = Array.from({ length: 10000 }, (_, i) => ({ code: `R-${i}`, name: `Row ${i}` }));
    const { container } = render(
      <DataTable label="Many" columns={columns.slice(0, 2)} rows={many} resizable={false} />,
    );
    const rendered = container.querySelectorAll("tbody tr[aria-rowindex]");
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(100);
    expect(screen.getByRole("grid").getAttribute("aria-rowcount")).toBe("10001");
    await expectAccessible(container);
    oh.mockRestore();
    ow.mockRestore();
  });

  it("mirrors horizontal keys in right-to-left", async () => {
    render(
      <XOSProvider locale="ar-XB">
        <DataTable columns={columns.slice(0, 2)} rows={rows} />
      </XOSProvider>,
    );
    act(() => screen.getAllByRole("gridcell")[0]?.focus());
    await userEvent.keyboard("{ArrowLeft}");
    expect(document.activeElement?.textContent).toBe("Line Array Package");
  });
});

describe("RecordRow and RecordList", () => {
  it("moves between rows with arrows, J and K, selects with X and opens with Enter", async () => {
    const onSelect = vi.fn();
    const onOpen = vi.fn();
    const onAction = vi.fn();
    const { container } = render(
      <RecordList label="Tasks">
        <RecordRow
          state="active"
          stateLabel="Active"
          recordKey="NWL-1"
          kind="Task"
          title="Hang truss"
          chips={<StateChip state="active" label="Active" />}
          next="Nov 3"
          owner="Dana Ortiz"
          actionLabel="Start"
          actionKey="S"
          onAction={onAction}
          onSelect={onSelect}
          onOpen={onOpen}
          selected
        />
        <RecordRow state="blocked" stateLabel="Blocked" recordKey="NWL-2" title="Load-in" />
        <RecordRow state="complete" stateLabel="Complete" recordKey="NWL-3" title="Advance" />
      </RecordList>,
    );
    const grid = screen.getByRole("grid", { name: "Tasks" });
    const rowsEls = within(grid).getAllByRole("row");
    act(() => grid.focus());
    expect(document.activeElement).toBe(rowsEls[0]);
    await userEvent.keyboard("x");
    expect(onSelect).toHaveBeenCalled();
    await userEvent.keyboard("{Enter}");
    expect(onOpen).toHaveBeenCalled();
    await userEvent.keyboard("j");
    expect(document.activeElement).toBe(rowsEls[1]);
    await userEvent.keyboard("{ArrowDown}{End}");
    expect(document.activeElement).toBe(rowsEls[2]);
    await userEvent.keyboard("k{Home}");
    expect(document.activeElement).toBe(rowsEls[0]);
    await userEvent.click(screen.getByRole("button", { name: /Start/ }));
    expect(onAction).toHaveBeenCalled();
    await expectAccessible(container);
  });
});

const boardColumns = [
  {
    state: "ready" as const,
    label: "Ready",
    cards: [
      {
        key: "NWL-1",
        title: "Hang truss",
        meta: "Stage A",
        kind: "Task" as const,
        owner: "Dana Ortiz",
        due: "Nov 3",
      },
    ],
  },
  { state: "active" as const, label: "Active", cards: [{ key: "NWL-2", title: "Load-in" }] },
  { state: "complete" as const, label: "Complete", cards: [] },
];

describe("Board", () => {
  it("moves a card across columns from the keyboard and announces it", async () => {
    const onMove = vi.fn();
    const onAdd = vi.fn();
    const { container } = render(<Board columns={boardColumns} onMove={onMove} onAdd={onAdd} />);
    const card = screen.getByRole("button", { name: /Hang truss/ });
    act(() => card.focus());
    await userEvent.keyboard(" ");
    expect(card.getAttribute("aria-pressed")).toBe("true");
    await userEvent.keyboard("{ArrowRight}");
    await act(async () => new Promise((r) => requestAnimationFrame(() => r(undefined))));
    expect(
      within(screen.getByRole("region", { name: "Active" })).getByText("Hang truss"),
    ).toBeTruthy();
    const moved = screen.getByRole("button", { name: /Hang truss/ });
    act(() => moved.focus());
    await userEvent.keyboard(" ");
    expect(onMove).toHaveBeenCalledWith("NWL-1", "ready", "active");
    expect(screen.getByText("Hang truss, Active", { selector: "[aria-live]" })).toBeTruthy();
    await userEvent.click(
      within(screen.getByRole("region", { name: "Complete" })).getByRole("button", {
        name: /New Record/,
      }),
    );
    expect(onAdd).toHaveBeenCalledWith("complete");
    await expectAccessible(container);
  });

  it("puts a card back on Escape and opens cards in read-only boards", async () => {
    const onMove = vi.fn();
    const onOpen = vi.fn();
    const { unmount } = render(<Board columns={boardColumns} onMove={onMove} />);
    const card = screen.getByRole("button", { name: /Load-in/ });
    act(() => card.focus());
    await userEvent.keyboard(" {ArrowLeft}");
    await act(async () => new Promise((r) => requestAnimationFrame(() => r(undefined))));
    await userEvent.keyboard("{Escape}");
    expect(
      within(screen.getByRole("region", { name: "Active" })).getByText("Load-in"),
    ).toBeTruthy();
    expect(onMove).not.toHaveBeenCalled();
    unmount();
    render(<Board columns={boardColumns} readOnly onOpen={onOpen} />);
    expect(screen.queryByRole("button", { name: /New Record/ })).toBeNull();
    const ro = screen.getByRole("button", { name: /Load-in/ });
    act(() => ro.focus());
    await userEvent.keyboard("{Enter}");
    expect(onOpen).toHaveBeenCalledWith("NWL-2");
  });

  it("moves a card by drag and drop", () => {
    const onMove = vi.fn();
    render(<Board columns={boardColumns} onMove={onMove} />);
    const data = new Map<string, string>();
    const dataTransfer = {
      setData: (k: string, v: string) => data.set(k, v),
      getData: (k: string) => data.get(k) ?? "",
    };
    fireEvent.dragStart(screen.getByRole("button", { name: /Hang truss/ }), { dataTransfer });
    const target = screen.getByRole("region", { name: "Complete" });
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });
    expect(onMove).toHaveBeenCalledWith("NWL-1", "ready", "complete");
  });
});

describe("TreeView", () => {
  const nodes = [
    {
      label: "Northwind Live",
      icon: "Building2",
      children: [
        {
          label: "CSMIA26",
          meta: "Show",
          children: [{ label: "Main Stage" }, { label: "Plaza", selected: true }],
        },
        { label: "Arena", expanded: false, children: [{ label: "Bowl" }] },
      ],
    },
  ];

  it("follows the tree keyboard model", async () => {
    const onSelect = vi.fn();
    const { container } = render(<TreeView label="Scope" nodes={nodes} onSelect={onSelect} />);
    const plaza = screen.getByRole("treeitem", { name: /Plaza/ });
    expect(plaza.getAttribute("aria-selected")).toBe("true");
    expect(plaza.getAttribute("tabindex")).toBe("0");
    act(() => plaza.focus());
    await userEvent.keyboard("{ArrowLeft}");
    expect(document.activeElement?.textContent).toMatch(/^CSMIA26/);
    await userEvent.keyboard("{ArrowLeft}");
    expect(screen.getByRole("treeitem", { name: /CSMIA26/ }).getAttribute("aria-expanded")).toBe(
      "false",
    );
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    expect(document.activeElement?.textContent).toBe("Main Stage");
    await userEvent.keyboard("{End}");
    const arena = screen.getByRole("treeitem", { name: /Arena/ });
    expect(document.activeElement).toBe(arena);
    await userEvent.keyboard("{ArrowRight}");
    expect(arena.getAttribute("aria-expanded")).toBe("true");
    await userEvent.keyboard("{Home}{Enter}");
    expect(onSelect).toHaveBeenCalledWith(nodes[0]);
    await userEvent.click(screen.getByText("Bowl"));
    expect(onSelect).toHaveBeenLastCalledWith({ label: "Bowl" });
    await expectAccessible(container);
  });
});

describe("BulkActionBar, ActivityFeedItem and StatTile", () => {
  it("shows the count, at most five actions and clears on Esc", async () => {
    const onClear = vi.fn();
    const onSelect = vi.fn();
    const { container } = render(
      <BulkActionBar
        count={1204}
        onClear={onClear}
        actions={["Assign", "Move", "Tag", "Export", "Archive", "Delete"].map((label, i) => ({
          label,
          icon: "Check",
          ...(i === 0 ? { shortcut: "A", onSelect } : {}),
        }))}
      />,
    );
    expect(screen.getByText("1,204 selected")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    const assign = screen.getByRole("button", { name: /Assign/ });
    await userEvent.click(assign);
    expect(onSelect).toHaveBeenCalled();
    await userEvent.keyboard("{ArrowRight}");
    expect(document.activeElement?.textContent).toContain("Move");
    await userEvent.keyboard("{Escape}");
    expect(onClear).toHaveBeenCalled();
    await expectAccessible(container);
  });

  it("renders a feed item with glyph reactions", async () => {
    const onReact = vi.fn();
    const { container } = render(
      <ActivityFeedItem
        actor="Dana Ortiz"
        action="moved"
        target="NWL-1042"
        time="2 h"
        comment="Ready for review."
        reactions={[{ icon: "ThumbsUp", label: "Agree", count: 3 }]}
        onReact={onReact}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Agree 3" }));
    expect(onReact).toHaveBeenCalledWith("Agree");
    await expectAccessible(container);
  });

  it("shows direction as icon, sign and tone, and No value for blanks", async () => {
    const onDrill = vi.fn();
    const { container } = render(
      <div>
        <StatTile
          label="Open Gaps"
          value={12}
          delta={-3}
          goodWhen="down"
          deltaLabel="vs last week"
          caption="Gate 3"
        />
        <StatTile
          label="Spend"
          value={125000}
          format="money"
          delta={4}
          deltaUnit="%"
          goodWhen="down"
          onDrill={onDrill}
        />
        <StatTile label="Crew" value={null} delta={0} />
        <StatTile label="Budget" value={null} format="money" />
      </div>,
    );
    expect(screen.getByText("-3").parentElement?.className).toContain("text-success-text");
    expect(screen.getByText("+4%").parentElement?.className).toContain("text-danger-text");
    expect(screen.getByText("No value")).toBeTruthy();
    expect(screen.getByText("Unpriced")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "$125,000.00" }));
    expect(onDrill).toHaveBeenCalled();
    await expectAccessible(container);
  });
});
