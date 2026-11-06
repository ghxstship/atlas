import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Calendar, Heatmap, SpreadsheetGrid, Timeline } from "../src/index.ts";
import type { GridColumn } from "../src/index.ts";
import { parseDuration, parseTimeShorthand } from "../src/Editing/quickAddCore.ts";
import { expectAccessible } from "./a11y.ts";

/**
 * B4 scheduling depth (G-38, G-41, G-44, G-45): the grid's time shorthand in en and es, SpreadsheetGrid's append
 * row and in-place errors, Timeline day-type tags, segments and anchor offsets, Calendar day tags, and the Heatmap's
 * table semantics.
 */

describe("time shorthand", () => {
  it.each([
    ["8", "08:00"],
    ["8a", "08:00"],
    ["8am", "08:00"],
    ["830p", "20:30"],
    ["8:30 pm", "20:30"],
    ["20:30", "20:30"],
    ["noon", "12:00"],
    ["midnight", "00:00"],
    ["12am", "00:00"],
    ["12p", "12:00"],
  ])("reads %s as %s (en)", (text, start) => {
    expect(parseTimeShorthand(text)).toEqual({ start, end: null, endDayOffset: 0 });
  });

  it.each([
    ["8 a. m.", "08:00"],
    ["8:30 p. m.", "20:30"],
    ["20 h", "20:00"],
    ["mediodía", "12:00"],
    ["medianoche", "00:00"],
  ])("reads %s as %s (es)", (text, start) => {
    expect(parseTimeShorthand(text, { locale: "es-US" })).toEqual({
      start,
      end: null,
      endDayOffset: 0,
    });
  });

  it("reads ranges, carrying the end's meridiem back when that keeps the start first", () => {
    expect(parseTimeShorthand("8a-10:30a")).toEqual({
      start: "08:00",
      end: "10:30",
      endDayOffset: 0,
    });
    expect(parseTimeShorthand("8a-5p")).toEqual({ start: "08:00", end: "17:00", endDayOffset: 0 });
    expect(parseTimeShorthand("8-11:30p")).toEqual({
      start: "20:00",
      end: "23:30",
      endDayOffset: 0,
    });
    expect(parseTimeShorthand("10-2p")).toEqual({ start: "10:00", end: "14:00", endDayOffset: 0 });
    expect(parseTimeShorthand("8 a 10", { locale: "es-US" })).toEqual({
      start: "08:00",
      end: "10:00",
      endDayOffset: 0,
    });
  });

  it("rolls an end before the start to the next day", () => {
    expect(parseTimeShorthand("10p-2a")).toEqual({ start: "22:00", end: "02:00", endDayOffset: 1 });
    expect(parseTimeShorthand("22-2")).toEqual({ start: "22:00", end: "02:00", endDayOffset: 1 });
  });

  it("refuses what is not shorthand", () => {
    for (const text of ["", "tomorrow", "25:00", "13pm", "8:75", "8-9-10"])
      expect(parseTimeShorthand(text)).toBeNull();
  });

  it("reads lengths", () => {
    expect(
      ["45", "45m", "45 min", "1h", "1h30", "1:30", "90 min", "1.5h", "2 horas"].map(parseDuration),
    ).toEqual([45, 45, 45, 60, 90, 90, 90, 90, 120]);
    expect(parseDuration("soon")).toBeNull();
  });
});

describe("SpreadsheetGrid append row and errors", () => {
  const columns: GridColumn[] = [
    {
      key: "time",
      label: "Time",
      type: "time",
      editable: true,
      parse: (text) => {
        const s = parseTimeShorthand(text);
        return s ? `${s.start}${s.end ? `–${s.end}` : ""}` : text.trim() || null;
      },
    },
    { key: "title", label: "Title", editable: true },
  ];

  it("adds a row when the blank row is typed into, and a column's parse reads its shorthand", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <SpreadsheetGrid
        label="Day grid"
        columns={columns}
        rows={[{ time: "08:00", title: "Rig the follow spots" }]}
        appendRow
        onChange={onChange}
      />,
    );
    const grid = screen.getByRole("grid", { name: "Day grid" });
    expect(within(grid).getAllByRole("row")).toHaveLength(4);
    const blank = within(grid).getAllByRole("gridcell")[2];
    if (!blank) throw new Error("no blank cell");
    await user.click(blank);
    await user.keyboard("8a-10:30a{Enter}");
    expect(onChange).toHaveBeenLastCalledWith([
      { time: "08:00", title: "Rig the follow spots" },
      { time: "08:00–10:30", title: null },
    ]);
  });

  it("Enter commits and moves down, and Tab moves across", async () => {
    const user = userEvent.setup();
    render(
      <SpreadsheetGrid
        label="Day grid"
        columns={columns}
        rows={[
          { time: null, title: "A" },
          { time: null, title: "B" },
        ]}
      />,
    );
    const cells = screen.getAllByRole("gridcell");
    await user.click(cells[0] as HTMLElement);
    await user.keyboard("{Enter}9a{Enter}");
    expect(cells[2]?.getAttribute("aria-selected")).toBe("true");
    await user.keyboard("{Tab}");
    expect(cells[3]?.getAttribute("aria-selected")).toBe("true");
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(cells[2]?.getAttribute("aria-selected")).toBe("true");
  });

  it("marks a refused cell invalid and names its message", async () => {
    const { container } = render(
      <SpreadsheetGrid
        label="Day grid"
        columns={columns}
        rows={[{ time: "08:00", title: "Installing the truss" }]}
        errors={{ "0:title": "A Task title starts with an imperative verb." }}
      />,
    );
    const cell = screen.getAllByRole("gridcell")[1];
    expect(cell?.getAttribute("aria-invalid")).toBe("true");
    const described = cell?.getAttribute("aria-describedby") ?? "";
    expect(container.querySelector(`[id="${described}"]`)?.textContent).toContain(
      "A Task title starts with an imperative verb.",
    );
    await expectAccessible(container);
  });
});

describe("Timeline tags, segments and offsets", () => {
  const days = [
    {
      dow: "Th",
      date: 12,
      label: "Thursday, November 12",
      tags: [{ label: "Load In", category: 1 as const, icon: "Truck" }],
    },
    {
      dow: "Fr",
      date: 13,
      label: "Friday, November 13",
      tags: [{ label: "Show", category: 2 as const, icon: "Ticket" }],
    },
    { dow: "Sa", date: 14, label: "Saturday, November 14" },
  ];

  it("names each day's types and each row's segments in the table, and reads offsets against the anchor", async () => {
    const { container } = render(
      <Timeline
        label="Schedule"
        days={days}
        anchorDay={1}
        rows={[
          { key: "NWS-1", title: "Hang the truss", state: "active", start: 0, end: 0 },
          {
            key: "NWS",
            title: "Demo Summer Series",
            state: "active",
            start: 0,
            end: 2,
            segments: [{ label: "Show", category: 2, start: 1, end: 1 }],
            badge: { label: "2 clashes", tone: "warning" },
          },
        ]}
      />,
    );
    const table = within(container).getByRole("table", { name: "Schedule" });
    expect(within(table).getAllByText("Thursday, November 12 (Load In)").length).toBeGreaterThan(0);
    expect(
      within(table).getByText(/Show Friday, November 13 \(Show\) to Friday, November 13 \(Show\)/),
    ).toBeTruthy();
    expect(within(table).getByRole("columnheader", { name: "Offset" })).toBeTruthy();
    expect(within(table).getAllByText("1 day before the anchor").length).toBeGreaterThan(0);
    expect(container.querySelectorAll("[title='Load In']").length).toBeGreaterThan(0);
    // A row's badge sits after its title in the drawing and is named in its table cell.
    expect(within(table).getByText(/Demo Summer Series .*\(2 clashes\)/)).toBeTruthy();
    expect(within(container).getAllByText("2 clashes").length).toBeGreaterThan(0);
    await expectAccessible(container);
  });
});

describe("Calendar day tags", () => {
  it("draws a day's types as text in its cell", async () => {
    const { container } = render(
      <Calendar
        month="2027-11-01"
        events={[]}
        days={[{ date: "2027-11-13", tags: [{ label: "Show", category: 2, icon: "Ticket" }] }]}
      />,
    );
    expect(within(container).getByRole("list", { name: "Day types" }).textContent).toContain(
      "Show",
    );
    await expectAccessible(container);
  });
});

describe("Heatmap", () => {
  it("is a native table whose cells show text, carry the over sentence and open their detail", async () => {
    const onCellActivate = vi.fn();
    const { container } = render(
      <Heatmap
        label="Workload"
        rowHeader="Person"
        rows={[{ key: "p1", label: "Frank Adeyemi" }]}
        columns={[
          { key: "2027-06-05", label: "Sat 5", fullLabel: "Saturday, June 5" },
          { key: "2027-06-06", label: "Sun 6", fullLabel: "Sunday, June 6" },
        ]}
        cells={{
          "p1:2027-06-05": { text: "11.5 h", step: 4, over: "Over 10 h" },
          "p1:2027-06-06": { text: "1 h", step: 1 },
        }}
        onCellActivate={onCellActivate}
      />,
    );
    const table = within(container).getByRole("table", { name: "Workload" });
    expect(within(table).getByRole("rowheader", { name: "Frank Adeyemi" })).toBeTruthy();
    expect(within(table).getAllByRole("columnheader")).toHaveLength(3);
    const over = within(table).getByRole("button", { name: /Saturday, June 5: 11.5 h, Over 10 h/ });
    fireEvent.click(over);
    expect(onCellActivate).toHaveBeenCalledWith("p1", "2027-06-05");
    expect(within(table).getByText("1 h")).toBeTruthy();
    await expectAccessible(container);
  });
});
