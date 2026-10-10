import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ratio } from "@xos/tokens/contrast";
import {
  ColorPicker,
  DiffViewer,
  FilterBuilder,
  QuickAdd,
  contrastRatio,
  parseQuickAdd,
} from "../src/index.ts";
import { expectAccessible } from "./a11y.ts";

const monday = new Date(2026, 9, 5, 9, 0);

describe("parseQuickAdd", () => {
  it("pulls people, tags, kinds, scopes and dates out of the title", () => {
    const parsed = parseQuickAdd(
      "Hang truss @dana #rigging /Task ~stage-a tomorrow at 3pm",
      monday,
    );
    expect(parsed.title).toBe("Hang truss");
    expect(parsed.tokens.map((t) => t.type)).toEqual(["person", "tag", "kind", "scope", "date"]);
    expect(parsed.tokens.find((t) => t.type === "date")?.iso).toBe("2026-10-06");
    expect(parseQuickAdd("Advance call next Friday", monday).tokens[0]?.iso).toBe("2026-10-16");
    expect(parseQuickAdd("Plain title", monday)).toEqual({ title: "Plain title", tokens: [] });
  });
});

describe("contrastRatio", () => {
  it("matches the @xos/tokens contrast gate", () => {
    for (const [a, b] of [
      ["#FFFFFF", "#000000"],
      ["#4F57D9", "#FFFFFF"],
      ["#abc", "#123456"],
    ] as const) {
      expect(contrastRatio(a, b)).toBeCloseTo(ratio(a, b), 10);
    }
  });
});

describe("FilterBuilder", () => {
  it("edits, removes, clears and saves filters", async () => {
    const onChange = vi.fn();
    const onSave = vi.fn();
    const onEdit = vi.fn();
    const onAdd = vi.fn();
    const filters = [
      { field: "State", op: "is", value: "Blocked" },
      { field: "Owner", op: "is", value: "Dana" },
    ];
    const { container } = render(
      <FilterBuilder
        filters={filters}
        saveLabel="Save View"
        onChange={onChange}
        onSave={onSave}
        onEdit={onEdit}
        onAdd={onAdd}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /State is Blocked/ }));
    expect(onEdit).toHaveBeenCalledWith(filters[0], 0);
    await userEvent.click(screen.getByRole("button", { name: "Remove filter Owner" }));
    expect(onChange).toHaveBeenLastCalledWith([filters[0]]);
    await userEvent.click(screen.getByRole("button", { name: "Save View" }));
    expect(onSave).toHaveBeenCalledWith([filters[0]]);
    await userEvent.click(screen.getByRole("button", { name: /Add Filter/ }));
    expect(onAdd).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onChange).toHaveBeenLastCalledWith([]);
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
    await expectAccessible(container);
  });
});

describe("QuickAdd", () => {
  it("shows chips as you type and submits on Enter", async () => {
    const onSubmit = vi.fn();
    const { container } = render(
      <QuickAdd placeholder="Add a task" referenceDate={monday} onSubmit={onSubmit} />,
    );
    const input = screen.getByRole("textbox", { name: "Quick add" });
    await userEvent.type(input, "@dana /Task");
    expect(screen.getByText("Untitled")).toBeTruthy();
    await userEvent.clear(input);
    await userEvent.type(input, "Check rigging /Inspection tomorrow{Enter}");
    expect(onSubmit).toHaveBeenCalledWith({
      title: "Check rigging",
      tokens: [
        { type: "kind", value: "Inspection", icon: "Shapes" },
        { type: "date", value: "tomorrow", icon: "Calendar", iso: "2026-10-06" },
      ],
    });
    expect((input as HTMLInputElement).value).toBe("");
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await expectAccessible(container);
  });
});

describe("ColorPicker", () => {
  const checks = [
    { label: "Text on accent", fg: "#FFFFFF" },
    { label: "Accent on canvas", bg: "#0E0F11", fgIsValue: true, min: 3 },
  ];

  it("checks contrast live and blocks a failing color", async () => {
    const onChange = vi.fn();
    const { container } = render(
      <ColorPicker label="Accent" value="#4F57D9" checks={checks} onChange={onChange} />,
    );
    expect(screen.getAllByText("Passes AA").length).toBeGreaterThan(0);
    const hex = screen.getByRole("textbox", { name: "Accent hex value" });
    await userEvent.clear(hex);
    await userEvent.type(hex, "#EEE");
    expect(onChange).toHaveBeenLastCalledWith("#EEE", false);
    expect(screen.getByText("This color can't be saved until every check passes.")).toBeTruthy();
    await userEvent.clear(hex);
    await userEvent.type(hex, "#12");
    expect(screen.getByText("Enter a hex color such as #4F57D9.")).toBeTruthy();
    expect(hex.getAttribute("aria-invalid")).toBe("true");
    fireEvent.input(container.querySelector('input[type="color"]') as HTMLInputElement, {
      target: { value: "#2f6feb" },
    });
    expect(onChange).toHaveBeenLastCalledWith("#2F6FEB", true);
    await expectAccessible(container);
  });
});

describe("DiffViewer", () => {
  it("marks before and after with strike and underline", async () => {
    const { container } = render(
      <DiffViewer caption="Changes" rows={[{ field: "Rate", before: "$420", after: "$450" }]} />,
    );
    expect(screen.getByText("$420").tagName).toBe("DEL");
    expect(screen.getByText("$450").tagName).toBe("INS");
    await expectAccessible(container);
  });
});
