import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  Combobox,
  DatePicker,
  DateRangePicker,
  FileDrop,
  MultiSelect,
  Slider,
  TimePicker,
  rankOptions,
} from "../src/index.ts";
import { expectAccessible } from "./a11y.ts";

const departments = [
  { value: "1000", label: "Creative", code: "1000" },
  { value: "5000", label: "Production", code: "5000", icon: "SlidersHorizontal" },
  { value: "6000", label: "Operations", code: "6000" },
];

describe("Combobox", () => {
  it("filters, moves with arrows, picks with Enter and closes on Escape", async () => {
    const onChange = vi.fn();
    const { container } = render(
      <Combobox
        label="Department"
        help="Pick the owning class."
        placeholder="Search"
        options={departments}
        onChange={onChange}
      />,
    );
    const input = screen.getByRole("combobox", { name: "Department" });
    expect(input.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(input);
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByRole("option")).toHaveLength(3);
    await userEvent.type(input, "oper");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    await userEvent.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("6000");
    expect(input).toMatchObject({ placeholder: "Operations" });
    await userEvent.keyboard("{ArrowDown}");
    expect(input.getAttribute("aria-activedescendant")).toMatch(/-opt-0$/);
    await userEvent.keyboard("{ArrowDown}{End}{Home}{ArrowUp}");
    await expectAccessible(document.body);
    await userEvent.keyboard("{Escape}");
    expect(input.getAttribute("aria-expanded")).toBe("false");
    void container;
  });

  it("says when nothing matches and picks by pointer", async () => {
    const onChange = vi.fn();
    render(
      <Combobox
        label="Dept"
        options={departments}
        noMatch="Try a code."
        onChange={onChange}
        defaultOpen
      />,
    );
    const input = screen.getByRole("combobox");
    await userEvent.type(input, "zzz");
    expect(screen.getByText("Try a code.")).toBeTruthy();
    await userEvent.clear(input);
    fireEvent.mouseDown(screen.getByRole("option", { name: /Production/ }));
    expect(onChange).toHaveBeenCalledWith("5000");
  });

  it("ranks fuzzy matches with the code", () => {
    expect(rankOptions(departments, "5000").map((o) => o.value)).toEqual(["5000"]);
    expect(rankOptions(departments, "")).toBe(departments);
  });
});

describe("MultiSelect", () => {
  it("toggles picks, removes chips and removes the last with Backspace", async () => {
    const onChange = vi.fn();
    render(
      <MultiSelect
        label="Departments"
        help="One or more."
        options={departments}
        value={["1000"]}
        onChange={onChange}
      />,
    );
    const input = screen.getByRole("combobox", { name: "Departments" });
    await userEvent.click(input);
    expect(screen.getByRole("listbox").getAttribute("aria-multiselectable")).toBe("true");
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenLastCalledWith(["1000", "5000"]);
    await expectAccessible(document.body);
    await userEvent.keyboard("{Backspace}");
    expect(onChange).toHaveBeenLastCalledWith(["1000"]);
    await userEvent.click(screen.getByRole("button", { name: "Remove Creative" }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });
});

describe("Slider", () => {
  it("moves with arrow keys and shows the value with its unit", async () => {
    const onChange = vi.fn();
    const { container } = render(
      <Slider label="Crew size" min={0} max={20} value={4} unit="people" onChange={onChange} />,
    );
    const thumb = screen.getByRole("slider", { name: "Crew size" });
    act(() => thumb.focus());
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    expect(onChange).toHaveBeenLastCalledWith(6);
    expect(screen.getByText("6 people")).toBeTruthy();
    expect(thumb.getAttribute("aria-valuetext")).toBe("6 people");
    await userEvent.keyboard("{End}");
    expect(onChange).toHaveBeenLastCalledWith(20);
    await expectAccessible(container);
  });

  it("shows a bare number without a unit", () => {
    render(<Slider label="Level" min={0} max={10} value={3} />);
    expect(screen.getByText("3")).toBeTruthy();
  });
});

describe("DatePicker and DateRangePicker", () => {
  it("opens a date grid, moves by day, week and month, and picks with Enter", async () => {
    const onChange = vi.fn();
    render(
      <DatePicker label="Load-in" value="2026-10-30" today="2026-10-09" onChange={onChange} />,
    );
    const trigger = screen.getByRole("button", { name: /Load-in|Oct 30, 2026/ });
    expect(trigger.textContent).toContain("Oct 30, 2026");
    await userEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Choose date" });
    const grid = within(dialog).getByRole("grid", { name: "October 2026" });
    expect(document.activeElement?.textContent).toBe("30");
    await userEvent.keyboard("{ArrowRight}");
    expect(document.activeElement?.textContent).toBe("31");
    await userEvent.keyboard("{ArrowDown}");
    expect(within(dialog).getByRole("grid", { name: "November 2026" })).toBeTruthy();
    expect(document.activeElement?.textContent).toBe("7");
    await userEvent.keyboard("{ArrowUp}{ArrowLeft}{Home}");
    expect(document.activeElement?.textContent).toBe("25");
    await userEvent.keyboard(
      "{End}{PageDown}{PageUp}{Shift>}{PageDown}{/Shift}{Shift>}{PageUp}{/Shift}",
    );
    expect(document.activeElement?.textContent).toBe("30");
    await expectAccessible(document.body);
    await userEvent.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("2026-10-30");
    expect(screen.queryByRole("dialog")).toBeNull();
    void grid;
  });

  it("navigates months with the header buttons and marks today", async () => {
    render(<DatePicker label="Due" month="2026-10-01" today="2026-10-09" defaultOpen />);
    expect(screen.getByText("9").getAttribute("aria-current")).toBe("date");
    await userEvent.click(screen.getByRole("button", { name: "Next month" }));
    expect(screen.getByRole("grid", { name: "November 2026" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Previous month" }));
    expect(screen.getByRole("grid", { name: "October 2026" })).toBeTruthy();
  });

  it("picks a range in either order and shows its length", async () => {
    const onChange = vi.fn();
    render(
      <DateRangePicker label="Show days" start="2026-11-03" end="2026-11-05" onChange={onChange} />,
    );
    const trigger = screen.getByRole("button", { name: /Show days|Nov/ });
    expect(trigger.textContent).toContain("Nov 3, 2026 to Nov 5, 2026");
    expect(trigger.textContent).toContain("3 days");
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole("button", { name: "10" }));
    await userEvent.click(screen.getByRole("button", { name: "8" }));
    expect(onChange).toHaveBeenCalledWith(["2026-11-08", "2026-11-10"]);
    await userEvent.click(screen.getByRole("button", { name: /Show days/ }));
    await userEvent.click(screen.getByRole("button", { name: "12" }));
    await expectAccessible(document.body);
    await userEvent.click(screen.getByRole("button", { name: "14" }));
    expect(onChange).toHaveBeenLastCalledWith(["2026-11-12", "2026-11-14"]);
  });
});

describe("TimePicker and FileDrop", () => {
  it("lists times in the locale format with the venue zone", async () => {
    const onChange = vi.fn();
    const { container } = render(
      <TimePicker
        label="Call time"
        value="06:30"
        step={30}
        timeZone="America/New_York"
        zoneLabel="ET"
        onChange={onChange}
      />,
    );
    const select = screen.getByLabelText("Call time") as HTMLSelectElement;
    expect(select.value).toBe("06:30");
    expect(within(select).getAllByRole("option")).toHaveLength(48);
    expect(within(select).getByRole("option", { name: "6:30 AM" })).toBeTruthy();
    expect(screen.getByText("ET").getAttribute("title")).toBe("America/New_York");
    await userEvent.selectOptions(select, "07:00");
    expect(onChange).toHaveBeenCalled();
    await expectAccessible(container);
  });

  it("adds files by browse or drop and lists them", async () => {
    const onFiles = vi.fn();
    const { container } = render(
      <FileDrop
        label="Certificates"
        hint="PDF up to 10 MB."
        accept=".pdf"
        files={[{ name: "w9.pdf", size: 2048 }]}
        onFiles={onFiles}
      />,
    );
    expect(screen.getByText("2 KB")).toBeTruthy();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(
      input,
      new File(["x".repeat(4096)], "coi.pdf", { type: "application/pdf" }),
    );
    expect(onFiles).toHaveBeenCalled();
    expect(screen.getByText("coi.pdf")).toBeTruthy();
    const zone = input.closest("label") as HTMLElement;
    fireEvent.dragOver(zone);
    fireEvent.dragLeave(zone);
    fireEvent.drop(zone, { dataTransfer: { files: [new File(["y"], "osha.pdf")] } });
    expect(screen.getByText("osha.pdf")).toBeTruthy();
    fireEvent.drop(zone, { dataTransfer: { files: [] } });
    await expectAccessible(container);
  });
});
