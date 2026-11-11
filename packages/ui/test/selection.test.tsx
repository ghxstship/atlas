import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  Board,
  Calendar,
  ContextMenu,
  DataTable,
  RecordList,
  RecordRow,
  type DataTableColumn,
  type ItemSelection,
} from "../src/index.ts";
import { expectAccessible } from "./a11y.ts";

const columns: DataTableColumn[] = [
  { key: "key", label: "Key", type: "code" },
  { key: "title", label: "Title" },
  { key: "state", label: "State", type: "state" },
];

const rows = ["Hang the banner", "Sweep the deck", "Test the radios", "Book the band"].map(
  (title, i) => ({
    id: `r${i + 1}`,
    key: `NWL-${i + 1}`,
    title,
    state: { state: "active", label: "Active" },
  }),
);

function Selectable({
  onContext,
  initial = [],
}: {
  onContext?: (id: string, at: { x: number; y: number } | null) => void;
  initial?: string[];
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set(initial));
  return (
    <>
      <div data-testid="selected">{[...selected].sort().join(",")}</div>
      <DataTable
        caption="Records"
        columns={columns}
        rows={rows}
        selection={{ selected, onChange: setSelected }}
        {...(onContext
          ? { onRowContextMenu: (row, _i, at) => onContext(String(row["id"]), at) }
          : {})}
      />
    </>
  );
}

const selected = () => screen.getByTestId("selected").textContent;
const cell = (row: number, name: string) =>
  within(screen.getAllByRole("row")[row + 1] as HTMLElement).getByText(name);

describe("DataTable selection", () => {
  it("names every checkbox and selects with a click", () => {
    render(<Selectable />);
    const grid = screen.getByRole("grid");
    expect(grid.getAttribute("aria-multiselectable")).toBe("true");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Hang the banner" }));
    expect(selected()).toBe("r1");
    expect(screen.getAllByRole("row")[1]?.getAttribute("aria-selected")).toBe("true");
    expect(screen.getAllByRole("row")[2]?.getAttribute("aria-selected")).toBe("false");
    expect(screen.getByRole("status").textContent).toBe("1 selected");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Hang the banner" }));
    expect(selected()).toBe("");
  });

  it("selects a range with Shift+click and toggles a row with Cmd or Ctrl+click", () => {
    render(<Selectable />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Sweep the deck" }));
    fireEvent.click(cell(3, "Book the band"), { shiftKey: true });
    expect(selected()).toBe("r2,r3,r4");
    fireEvent.click(cell(2, "Test the radios"), { metaKey: true });
    expect(selected()).toBe("r2,r4");
    fireEvent.click(cell(0, "Hang the banner"), { ctrlKey: true });
    expect(selected()).toBe("r1,r2,r4");
    fireEvent.click(cell(1, "Sweep the deck"));
    expect(selected()).toBe("r1,r2,r4");
  });

  it("selects from the keyboard: X, Shift+X, Space on the box, Cmd+A and Esc", () => {
    render(<Selectable />);
    const title = cell(0, "Hang the banner");
    fireEvent.focus(title);
    fireEvent.keyDown(title, { key: "x" });
    expect(selected()).toBe("r1");
    fireEvent.keyDown(cell(2, "Test the radios"), { key: "X", shiftKey: true });
    expect(selected()).toBe("r1,r2,r3");
    const box = screen.getAllByRole("gridcell")[0] as HTMLElement;
    fireEvent.keyDown(box, { key: " " });
    expect(selected()).toBe("r2,r3");
    fireEvent.keyDown(title, { key: "a", metaKey: true });
    expect(selected()).toBe("r1,r2,r3,r4");
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    const outside = vi.fn();
    document.addEventListener("keydown", outside);
    act(() => {
      title.dispatchEvent(escape);
    });
    document.removeEventListener("keydown", outside);
    expect(selected()).toBe("");
    expect(outside).not.toHaveBeenCalled();
  });

  it("moves between rows with J and K as with the arrow keys", () => {
    render(<Selectable />);
    const first = cell(0, "Hang the banner");
    act(() => first.focus());
    fireEvent.keyDown(first, { key: "j" });
    expect(document.activeElement).toBe(cell(1, "Sweep the deck"));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "j" });
    expect(document.activeElement).toBe(cell(2, "Test the radios"));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "k" });
    expect(document.activeElement).toBe(cell(1, "Sweep the deck"));
    // A modified J is someone else's shortcut.
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "j", metaKey: true });
    expect(document.activeElement).toBe(cell(1, "Sweep the deck"));
    // Every row names itself for hover cards.
    expect(screen.getAllByRole("row")[2]?.getAttribute("data-item")).toBe("r2");
  });

  it("leaves X, J and K alone when single-key shortcuts are off", () => {
    document.documentElement.dataset["shortcuts"] = "off";
    try {
      render(<Selectable />);
      const first = cell(0, "Hang the banner");
      act(() => first.focus());
      fireEvent.keyDown(first, { key: "x" });
      expect(selected()).toBe("");
      fireEvent.keyDown(first, { key: "j" });
      expect(document.activeElement).toBe(first);
      fireEvent.keyDown(first, { key: "ArrowDown" });
      expect(document.activeElement).toBe(cell(1, "Sweep the deck"));
    } finally {
      delete document.documentElement.dataset["shortcuts"];
    }
  });

  it("selects and clears every row from the header box, which shows a partial selection", () => {
    render(<Selectable initial={["r2"]} />);
    const all = screen.getByRole("checkbox", { name: "Select all rows" }) as HTMLInputElement;
    expect(all.indeterminate).toBe(true);
    fireEvent.click(all);
    expect(selected()).toBe("r1,r2,r3,r4");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all rows" }));
    expect(selected()).toBe("");
  });

  it("opens the row menu on right-click, Shift+F10 and the Context Menu key", () => {
    const onContext = vi.fn();
    render(<Selectable onContext={onContext} />);
    fireEvent.contextMenu(cell(1, "Sweep the deck"), { clientX: 40, clientY: 80 });
    expect(onContext).toHaveBeenLastCalledWith("r2", { x: 40, y: 80 });
    fireEvent.keyDown(cell(2, "Test the radios"), { key: "F10", shiftKey: true });
    expect(onContext).toHaveBeenLastCalledWith("r3", null);
    fireEvent.keyDown(cell(3, "Book the band"), { key: "ContextMenu" });
    expect(onContext).toHaveBeenLastCalledWith("r4", null);
  });

  it("is accessible with a selection", async () => {
    const { container } = render(<Selectable initial={["r1", "r3"]} />);
    await expectAccessible(container);
  });
});

/** A selection the test keeps, shown as sorted ids, and the menu calls it saw. */
function useKept(initial: string[] = []): [ItemSelection, string] {
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set(initial));
  return [{ selected: kept, onChange: setKept }, [...kept].sort().join(",")];
}

function SelectableList({
  onContext,
  initial,
}: {
  onContext?: (id: string, at: { x: number; y: number } | null) => void;
  initial?: string[];
}) {
  const [selection, shown] = useKept(initial);
  return (
    <>
      <div data-testid="selected">{shown}</div>
      <RecordList
        label="Records"
        selection={selection}
        {...(onContext ? { onItemContextMenu: (id, at) => onContext(id, at) } : {})}
      >
        {rows.map((r) => (
          <RecordRow
            key={r.id}
            id={r.id}
            state="active"
            stateLabel="Active"
            recordKey={r.key}
            title={r.title}
            owner="Dana Ortiz"
          />
        ))}
      </RecordList>
    </>
  );
}

const listRow = (name: string) => screen.getByRole("row", { name: new RegExp(name) });

describe("RecordList selection", () => {
  it("leads each row with a named checkbox and selects with a click", () => {
    render(<SelectableList />);
    const grid = screen.getByRole("grid", { name: "Records" });
    expect(grid.getAttribute("aria-multiselectable")).toBe("true");
    expect(
      within(within(grid).getAllByRole("row")[0] as HTMLElement)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Select", "State", "Key", "Record", "Labels", "Next date", "Owner", "Action"]);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Sweep the deck" }));
    expect(selected()).toBe("r2");
    expect(listRow("Sweep the deck").getAttribute("aria-selected")).toBe("true");
    expect(listRow("Hang the banner").getAttribute("aria-selected")).toBe("false");
    expect(screen.getByRole("status").textContent).toBe("1 selected");
    // The key, title and owner cells and the row name themselves for hover cards.
    const row = listRow("Sweep the deck");
    expect(row.getAttribute("data-item")).toBe("r2");
    expect(row.querySelector('[data-column="key"]')?.textContent).toBe("NWL-2");
    expect(row.querySelector('[data-column="title"]')?.textContent).toBe("Sweep the deck");
    expect(row.querySelector('[data-column="owner"]')).not.toBeNull();
  });

  it("selects with X and Shift+X, Cmd or Ctrl+A, and clears on Esc", () => {
    render(<SelectableList />);
    const grid = screen.getByRole("grid", { name: "Records" });
    act(() => grid.focus());
    const first = listRow("Hang the banner");
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "x" });
    expect(selected()).toBe("r1");
    fireEvent.keyDown(first, { key: "j" });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "j" });
    expect(document.activeElement).toBe(listRow("Test the radios"));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "X", shiftKey: true });
    expect(selected()).toBe("r1,r2,r3");
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "x" });
    expect(selected()).toBe("r1,r2");
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "a", ctrlKey: true });
    expect(selected()).toBe("r1,r2,r3,r4");
    const outside = vi.fn();
    document.addEventListener("keydown", outside);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    document.removeEventListener("keydown", outside);
    expect(selected()).toBe("");
    expect(outside).not.toHaveBeenCalled();
  });

  it("toggles with Cmd or Ctrl+click and selects a range with Shift+click", () => {
    render(<SelectableList />);
    fireEvent.click(within(listRow("Sweep the deck")).getByText("Sweep the deck"), {
      metaKey: true,
    });
    expect(selected()).toBe("r2");
    fireEvent.click(within(listRow("Book the band")).getByText("NWL-4"), { shiftKey: true });
    expect(selected()).toBe("r2,r3,r4");
    fireEvent.click(within(listRow("Test the radios")).getByText("NWL-3"), { ctrlKey: true });
    expect(selected()).toBe("r2,r4");
    // A plain click selects nothing.
    fireEvent.click(within(listRow("Hang the banner")).getByText("NWL-1"));
    expect(selected()).toBe("r2,r4");
  });

  it("leaves X alone when single-key shortcuts are off", () => {
    document.documentElement.dataset["shortcuts"] = "off";
    try {
      render(<SelectableList />);
      act(() => screen.getByRole("grid", { name: "Records" }).focus());
      fireEvent.keyDown(listRow("Hang the banner"), { key: "x" });
      expect(selected()).toBe("");
    } finally {
      delete document.documentElement.dataset["shortcuts"];
    }
  });

  it("opens a row's menu on right-click, Shift+F10 and the Context Menu key", () => {
    const onContext = vi.fn();
    render(<SelectableList onContext={onContext} />);
    fireEvent.contextMenu(within(listRow("Sweep the deck")).getByText("Sweep the deck"), {
      clientX: 40,
      clientY: 80,
    });
    expect(onContext).toHaveBeenLastCalledWith("r2", { x: 40, y: 80 });
    act(() => screen.getByRole("grid", { name: "Records" }).focus());
    fireEvent.keyDown(listRow("Hang the banner"), { key: "F10", shiftKey: true });
    expect(onContext).toHaveBeenLastCalledWith("r1", null);
    fireEvent.keyDown(listRow("Hang the banner"), { key: "ContextMenu" });
    expect(onContext).toHaveBeenCalledTimes(3);
  });

  it("is accessible with a selection", async () => {
    const { container } = render(<SelectableList initial={["r1", "r3"]} />);
    await expectAccessible(container);
  });
});

const cards = [
  {
    state: "ready" as const,
    label: "Ready",
    cards: rows.slice(0, 2).map((r) => ({ id: r.id, key: r.key, title: r.title })),
  },
  {
    state: "active" as const,
    label: "Active",
    cards: rows.slice(2).map((r) => ({ id: r.id, key: r.key, title: r.title })),
  },
];

function SelectableBoard({
  onContext,
  initial,
  readOnly = true,
}: {
  onContext?: (id: string, at: { x: number; y: number } | null) => void;
  initial?: string[];
  readOnly?: boolean;
}) {
  const [selection, shown] = useKept(initial);
  return (
    <>
      <div data-testid="selected">{shown}</div>
      <Board
        columns={cards}
        readOnly={readOnly}
        selection={selection}
        {...(onContext ? { onItemContextMenu: (id, at) => onContext(id, at) } : {})}
      />
    </>
  );
}

const card = (name: string) => screen.getByRole("button", { name: new RegExp(name) });

describe("Board selection", () => {
  it("selects cards with X and Shift+X down each column, Cmd or Ctrl+A and Esc", () => {
    render(<SelectableBoard />);
    fireEvent.keyDown(card("Hang the banner"), { key: "x" });
    expect(selected()).toBe("r1");
    expect(card("Hang the banner").textContent).toContain("Selected");
    expect(screen.getByRole("status").textContent).toBe("1 selected");
    fireEvent.keyDown(card("Test the radios"), { key: "X", shiftKey: true });
    expect(selected()).toBe("r1,r2,r3");
    fireEvent.keyDown(card("Book the band"), { key: "a", metaKey: true });
    expect(selected()).toBe("r1,r2,r3,r4");
    fireEvent.keyDown(card("Book the band"), { key: "Escape" });
    expect(selected()).toBe("");
    // Every card names itself, its key and its title for hover cards.
    const c = card("Sweep the deck");
    expect(c.getAttribute("data-item")).toBe("r2");
    expect(c.querySelector('[data-column="key"]')?.textContent).toBe("NWL-2");
  });

  it("toggles with Cmd or Ctrl+click and selects a range with Shift+click", () => {
    render(<SelectableBoard />);
    fireEvent.click(card("Sweep the deck"), { ctrlKey: true });
    fireEvent.click(card("Book the band"), { shiftKey: true });
    expect(selected()).toBe("r2,r3,r4");
    fireEvent.click(card("Test the radios"), { metaKey: true });
    expect(selected()).toBe("r2,r4");
  });

  it("puts a held card back on Esc before it clears the selection", async () => {
    render(<SelectableBoard readOnly={false} initial={["r1"]} />);
    const held = card("Sweep the deck");
    act(() => held.focus());
    fireEvent.keyDown(held, { key: " " });
    expect(held.getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyDown(held, { key: "x" });
    expect(selected()).toBe("r1");
    fireEvent.keyDown(held, { key: "Escape" });
    expect(held.getAttribute("aria-pressed")).toBeNull();
    expect(selected()).toBe("r1");
    fireEvent.keyDown(card("Sweep the deck"), { key: "Escape" });
    expect(selected()).toBe("");
  });

  it("opens a card's menu on right-click and Shift+F10", () => {
    const onContext = vi.fn();
    render(<SelectableBoard onContext={onContext} />);
    fireEvent.contextMenu(card("Test the radios"), { clientX: 4, clientY: 8 });
    expect(onContext).toHaveBeenLastCalledWith("r3", { x: 4, y: 8 });
    fireEvent.keyDown(card("Hang the banner"), { key: "F10", shiftKey: true });
    expect(onContext).toHaveBeenLastCalledWith("r1", null);
  });

  it("is accessible with a selection", async () => {
    const { container } = render(<SelectableBoard initial={["r2"]} />);
    await expectAccessible(container);
  });
});

function SelectableCalendar({
  onContext,
  onEventSelect,
}: {
  onContext?: (id: string, at: { x: number; y: number } | null) => void;
  onEventSelect?: (label: string) => void;
}) {
  const [selection, shown] = useKept();
  return (
    <>
      <div data-testid="selected">{shown}</div>
      <Calendar
        month="2026-11-01"
        events={[
          { id: "r1", date: "2026-11-03", label: "NWL-1 Hang the banner", state: "active" },
          { id: "r2", date: "2026-11-04", label: "NWL-2 Sweep the deck", state: "ready" },
          { id: "r3", date: "2026-11-05", label: "NWL-3 Test the radios", state: "ready" },
        ]}
        selection={selection}
        {...(onEventSelect ? { onEventSelect: (e) => onEventSelect(e.label) } : {})}
        {...(onContext ? { onItemContextMenu: (id, at) => onContext(id, at) } : {})}
      />
    </>
  );
}

describe("Calendar selection", () => {
  it("selects events with X, Shift+X and Cmd or Ctrl+click, and a plain click opens one", () => {
    const opened = vi.fn();
    render(<SelectableCalendar onEventSelect={opened} />);
    const event = (name: string) => screen.getByRole("button", { name: new RegExp(name) });
    fireEvent.keyDown(event("Hang the banner"), { key: "x" });
    fireEvent.keyDown(event("Test the radios"), { key: "x", shiftKey: true });
    expect(selected()).toBe("r1,r2,r3");
    expect(event("Sweep the deck").textContent).toContain("Selected");
    fireEvent.click(event("Sweep the deck"), { metaKey: true });
    expect(selected()).toBe("r1,r3");
    expect(opened).not.toHaveBeenCalled();
    fireEvent.click(event("Sweep the deck"));
    expect(opened).toHaveBeenCalledWith("NWL-2 Sweep the deck");
    expect(event("Sweep the deck").getAttribute("data-item")).toBe("r2");
  });

  it("opens an event's menu on right-click and the Context Menu key", () => {
    const onContext = vi.fn();
    render(<SelectableCalendar onContext={onContext} />);
    const event = screen.getByRole("button", { name: /Sweep the deck/ });
    fireEvent.contextMenu(event, { clientX: 1, clientY: 2 });
    expect(onContext).toHaveBeenLastCalledWith("r2", { x: 1, y: 2 });
    fireEvent.keyDown(event, { key: "ContextMenu" });
    expect(onContext).toHaveBeenLastCalledWith("r2", null);
  });
});

describe("ContextMenu at a point", () => {
  it("opens at the point with the row's actions and closes on Esc", async () => {
    const cell = document.createElement("button");
    cell.textContent = "NWL-1";
    document.body.append(cell);
    const onClose = vi.fn();
    render(
      <ContextMenu
        label="Actions for NWL-1"
        at={{ x: 40, y: 80 }}
        returnFocus={cell}
        onClose={onClose}
        items={[{ label: "Open" }, { separator: true }, { label: "Copy link" }]}
      />,
    );
    const menu = await screen.findByRole("menu", { name: "Actions for NWL-1" });
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual(["Open", "Copy link"]);
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    cell.remove();
  });
});
