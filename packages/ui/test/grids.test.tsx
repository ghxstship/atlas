import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  BidSheet,
  BudgetGrid,
  SpreadsheetGrid,
  columnTotal,
  glForCode,
  parseCell,
} from "../src/index.ts";
import type { GLAccount, GridColumn } from "../src/index.ts";
import { expectAccessible } from "./a11y.ts";

const columns: GridColumn[] = [
  { key: "id", label: "Rate Card", type: "code" },
  { key: "rate", label: "Standard Rate", type: "money", editable: true, total: true },
  { key: "ot", label: "OT", type: "multiplier", editable: true },
  {
    key: "gl",
    label: "GL Account",
    derive: (row) => (String(row["id"]).startsWith("LRC") ? "5900" : null),
  },
];
const rows = [
  { id: "LRC-001", rate: 650, ot: 1.5 },
  { id: "LRC-002", rate: null, ot: 2 },
];

describe("SpreadsheetGrid", () => {
  it("moves with arrows, edits with Enter, clears to Unpriced and keeps totals blank while a line is blank", async () => {
    const onChange = vi.fn();
    const { container } = render(
      <SpreadsheetGrid
        label="Rate cards"
        columns={columns}
        rows={rows}
        totalsLabel="Totals"
        onChange={onChange}
      />,
    );
    const grid = screen.getByRole("grid", { name: "Rate cards" });
    expect(within(grid).getByText("1.5x")).toBeTruthy();
    expect(within(grid).getByText("2.0x")).toBeTruthy();
    expect(within(grid).getAllByText("Unpriced").length).toBe(2);
    const first = within(grid).getAllByRole("gridcell")[0] as HTMLElement;
    act(() => first.focus());
    await userEvent.keyboard("{ArrowRight}{ArrowDown}{Enter}");
    const editor = within(grid).getByRole("textbox", { name: "Standard Rate" });
    await userEvent.clear(editor);
    await userEvent.type(editor, "700{Enter}");
    expect(onChange).toHaveBeenLastCalledWith([rows[0], { ...rows[1], rate: 700 }]);
    expect(within(grid).getByText("$1,350.00")).toBeTruthy();
    await userEvent.keyboard("{ArrowUp}{Delete}");
    expect(onChange.mock.lastCall?.[0][0].rate).toBeNull();
    await userEvent.keyboard("{ArrowRight}");
    await userEvent.keyboard("2");
    await userEvent.keyboard("x{Tab}");
    expect(onChange.mock.lastCall?.[0][0].ot).toBe(2);
    expect(document.activeElement?.getAttribute("aria-readonly")).toBe("true");
    expect(document.activeElement?.getAttribute("title")).toContain("Derived from canon");
    await userEvent.keyboard("{Enter}{Delete}");
    await userEvent.keyboard("{Home}{End}{Control>}{Home}{/Control}{Escape}");
    expect(within(grid).getByText("Totals")).toBeTruthy();
    await expectAccessible(container);
  });

  it("cancels an edit on Escape, edits on double click and fills a pasted range", async () => {
    const onChange = vi.fn();
    render(<SpreadsheetGrid label="Grid" columns={columns} rows={rows} onChange={onChange} />);
    const grid = screen.getByRole("grid");
    const rate = within(grid).getAllByRole("gridcell")[1] as HTMLElement;
    fireEvent.doubleClick(rate);
    const editor = within(grid).getByRole("textbox");
    await userEvent.type(editor, "9{Escape}");
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.paste(grid, { clipboardData: { getData: () => "100\t1.25x\n200\t\n" } });
    expect(onChange).toHaveBeenLastCalledWith([
      { id: "LRC-001", rate: 100, ot: 1.25 },
      { id: "LRC-002", rate: 200, ot: null },
    ]);
  });

  it("is unchanged without rowKey: new rows are ignored once it has rendered", () => {
    const { rerender } = render(<SpreadsheetGrid label="Grid" columns={columns} rows={rows} />);
    rerender(
      <SpreadsheetGrid label="Grid" columns={columns} rows={[{ id: "LRC-009", rate: 1, ot: 1 }]} />,
    );
    const grid = screen.getByRole("grid");
    expect(within(grid).getByText("LRC-001")).toBeTruthy();
    expect(within(grid).queryByText("LRC-009")).toBeNull();
  });

  describe("with rowKey", () => {
    const lineColumns: GridColumn[] = [
      { key: "id", label: "Line", type: "code" },
      { key: "description", label: "Description", editable: true },
      { key: "amount", label: "Amount", type: "money", total: true },
    ];
    const stage = { id: "a", description: "Stage", amount: 100 };
    const sound = { id: "b", description: "Sound", amount: 200 };
    const lines = [stage, sound];
    const grid = (shown: Record<string, string | number | null>[], extra = {}) => (
      <SpreadsheetGrid label="Lines" columns={lineColumns} rows={shown} rowKey="id" {...extra} />
    );
    const cellOf = (rowId: string, column: number) => {
      const row = within(screen.getByRole("grid"))
        .getAllByRole("row")
        .find((r) => within(r).queryByText(rowId));
      return within(row as HTMLElement).getAllByRole("gridcell")[column] as HTMLElement;
    };

    it("takes rows added, removed and changed elsewhere", () => {
      const { rerender } = render(grid(lines));
      rerender(
        grid([
          { id: "c", description: "Lights", amount: 50 },
          { id: "a", description: "Stage deck", amount: 100 },
        ]),
      );
      const table = screen.getByRole("grid");
      expect(within(table).getByText("Lights")).toBeTruthy();
      expect(within(table).getByText("Stage deck")).toBeTruthy();
      expect(within(table).queryByText("Sound")).toBeNull();
      expect(within(table).getByText("$150.00")).toBeTruthy();
    });

    it("keeps a value typed here when a refresh still carries the version from before the save", async () => {
      const onChange = vi.fn();
      const { rerender } = render(grid(lines, { onChange }));
      fireEvent.doubleClick(cellOf("a", 1));
      const editor = within(screen.getByRole("grid")).getByRole("textbox");
      await userEvent.clear(editor);
      await userEvent.type(editor, "Stage deck{Enter}");
      expect(onChange).toHaveBeenLastCalledWith([{ ...stage, description: "Stage deck" }, sound]);
      rerender(
        grid(
          lines.map((l) => ({ ...l })),
          { onChange },
        ),
      );
      expect(within(screen.getByRole("grid")).getByText("Stage deck")).toBeTruthy();
      rerender(grid([{ ...stage, description: "Stage riser" }, sound], { onChange }));
      expect(within(screen.getByRole("grid")).getByText("Stage riser")).toBeTruthy();
    });

    it("keeps an open cell's draft and selection on its row when rows shift, and reports editing", async () => {
      const onChange = vi.fn();
      const onEditingChange = vi.fn();
      const { rerender } = render(grid(lines, { onChange, onEditingChange }));
      fireEvent.doubleClick(cellOf("b", 1));
      expect(onEditingChange).toHaveBeenLastCalledWith("b");
      const editor = within(screen.getByRole("grid")).getByRole("textbox");
      await userEvent.clear(editor);
      await userEvent.type(editor, "Sound package");
      const shifted = [
        { id: "z", description: "Rigging", amount: 10 },
        { ...stage },
        { ...sound, description: "Sound (theirs)", amount: 250 },
      ];
      rerender(grid(shifted, { onChange, onEditingChange }));
      const still = within(screen.getByRole("grid")).getByRole("textbox") as HTMLInputElement;
      expect(still.value).toBe("Sound package");
      expect(cellOf("b", 1).getAttribute("aria-selected")).toBe("true");
      await userEvent.keyboard("{Enter}");
      expect(onEditingChange).toHaveBeenLastCalledWith(null);
      expect(onChange).toHaveBeenLastCalledWith([
        shifted[0],
        stage,
        { ...sound, description: "Sound package" },
      ]);
    });

    it("drops the open cell when its row is removed", () => {
      const onEditingChange = vi.fn();
      const { rerender } = render(grid(lines, { onEditingChange }));
      fireEvent.doubleClick(cellOf("b", 1));
      rerender(grid([stage], { onEditingChange }));
      expect(within(screen.getByRole("grid")).queryByRole("textbox")).toBeNull();
      expect(onEditingChange).toHaveBeenLastCalledWith(null);
    });
  });

  it("parses typed cells and totals with the silence rule", () => {
    expect(parseCell({ key: "a", label: "A", type: "money" }, " $1,200 ")).toBe(1200);
    expect(parseCell({ key: "a", label: "A", type: "multiplier" }, "1.5x")).toBe(1.5);
    expect(parseCell({ key: "a", label: "A", type: "number" }, "abc")).toBeNull();
    expect(parseCell({ key: "a", label: "A" }, " text ")).toBe("text");
    expect(columnTotal([{ a: 1 }, { a: 2 }], "a")).toBe(3);
    expect(columnTotal([{ a: 1 }, { a: null }], "a")).toBeNull();
    expect(columnTotal([], "a")).toBeNull();
  });
});

const accounts: GLAccount[] = [
  { code: "5500", name: "Expense · Production", classCode: "5000", type: "Expense" },
  { code: "8500", name: "Expense · Hospitality", classCode: "8000", type: "Expense" },
];

describe("BudgetGrid", () => {
  it("groups by derived GL account, switches grades and keeps unpriced totals blank", async () => {
    const onGradeChange = vi.fn();
    const { container } = render(
      <BudgetGrid
        label="Budget"
        accounts={accounts}
        scopeLabel="CSMIA26"
        grades={[
          { value: "base", label: "Base" },
          { value: "elevated", label: "Elevated" },
          { value: "premium", label: "Premium" },
        ]}
        onGradeChange={onGradeChange}
        lines={[
          {
            cc: "CC-1",
            urid: "8000.10.01",
            name: "Cultural Menu",
            type: "Scope",
            qty: 2,
            unit: "ea",
            base: null,
            elevated: null,
            premium: 900,
          },
          {
            cc: "CC-2",
            urid: "5000.01.02",
            name: "Line Array",
            qty: 1,
            base: 4200,
            elevated: 5200,
            premium: 6100,
          },
          {
            cc: "CC-3",
            urid: "7000.01.01",
            name: "Signage",
            qty: null,
            base: 300,
            elevated: 300,
            premium: 300,
          },
        ]}
      />,
    );
    const rowgroups = screen.getAllByRole("rowheader");
    expect(rowgroups.map((r) => r.textContent)).toEqual([
      "5500 Expense · Production",
      "8500 Expense · Hospitality",
      " Unmapped Account",
      "Total",
    ]);
    expect(screen.getAllByText("$4,200.00").length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("radio", { name: "Premium" }));
    expect(onGradeChange).toHaveBeenCalledWith("premium");
    expect(screen.getAllByText("$1,800.00").length).toBeGreaterThan(0);
    expect(glForCode("9000.50.01", accounts)).toBeNull();
    await expectAccessible(container);
  });
});

describe("BidSheet", () => {
  it("edits unit prices and derives extended amounts and the total", async () => {
    const onChange = vi.fn();
    const { container } = render(
      <BidSheet
        deadline="Oct 30"
        onChange={onChange}
        lines={[
          { line: "1", item: "Truss", unit: "ea", qty: 4, price: 100, ext: null },
          { line: "2", item: "Motors", unit: "ea", qty: 2, price: null, ext: null },
        ]}
      />,
    );
    expect(
      screen.getByText("Bids stay sealed until Oct 30. No bidder sees another bid."),
    ).toBeTruthy();
    expect(screen.getByText("$400.00")).toBeTruthy();
    const priceCell = screen.getAllByRole("gridcell")[10] as HTMLElement;
    act(() => priceCell.focus());
    fireEvent.click(priceCell);
    await userEvent.keyboard("{Enter}");
    await userEvent.type(screen.getByRole("textbox", { name: "Unit Price" }), "50{Enter}");
    expect(onChange.mock.lastCall?.[0][1]).toEqual({
      line: "2",
      item: "Motors",
      unit: "ea",
      qty: 2,
      price: 50,
      ext: 100,
    });
    expect(screen.getByText("$500.00")).toBeTruthy();
    await expectAccessible(container);
  });
});
