import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { DataTable, type DataTableColumn } from "../src/index.ts";
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

  it("leaves X alone when single-key shortcuts are off", () => {
    document.documentElement.dataset["shortcuts"] = "off";
    try {
      render(<Selectable />);
      fireEvent.keyDown(cell(0, "Hang the banner"), { key: "x" });
      expect(selected()).toBe("");
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
