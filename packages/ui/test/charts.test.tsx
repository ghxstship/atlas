import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  Calendar,
  Card,
  Chart,
  Gallery,
  OrgChart,
  ResourceSchedule,
  Sparkline,
  StatTile,
  Timeline,
  foldSeries,
} from "../src/index.ts";
import { expectAccessible } from "./a11y.ts";

describe("Gallery and Calendar", () => {
  it("lists cards on an auto-filling grid", async () => {
    const { container } = render(
      <Gallery label="Opportunities" min={280}>
        <Card key="a">A</Card> <Card key="b">B</Card>
      </Gallery>,
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("list").getAttribute("style")).toContain("calc(var(--space-4) * 70)");
    await expectAccessible(container);
  });

  it("shows events by month, folds extras and switches to agenda", async () => {
    const onEventSelect = vi.fn();
    const events = [
      { date: "2026-11-03", label: "Load-in", state: "scheduled" as const },
      { date: "2026-11-03", label: "Sound check", state: "ready" as const },
      { date: "2026-11-03", label: "Doors", state: "ready" as const },
      { date: "2026-11-03", label: "Show", state: "proposed" as const },
      { date: "2026-11-01", label: "Advance due", state: "complete" as const },
    ];
    const { container } = render(
      <Calendar
        month="2026-11-01"
        today="2026-11-03"
        events={events}
        onEventSelect={onEventSelect}
      />,
    );
    expect(screen.getByRole("table", { name: "November 2026" })).toBeTruthy();
    expect(screen.getByText("+1 more")).toBeTruthy();
    expect(screen.getByText("3").getAttribute("aria-current")).toBe("date");
    await userEvent.click(screen.getByRole("button", { name: /Load-in/ }));
    expect(onEventSelect).toHaveBeenCalledWith(events[0]);
    await expectAccessible(container);
    await userEvent.click(screen.getByRole("radio", { name: "Agenda" }));
    const items = screen.getAllByRole("listitem");
    expect(items[0]?.textContent).toContain("Advance due");
    expect(items).toHaveLength(5);
  });
});

describe("Timeline", () => {
  it("draws bars and gives a table alternative", async () => {
    const days = Array.from({ length: 10 }, (_, i) => ({
      dow: "Mo",
      date: i + 1,
      weekend: i % 7 > 4,
    }));
    const { container } = render(
      <Timeline
        label="Build schedule"
        days={days}
        today={3}
        gates={[{ day: 5, label: "Gate 5" }]}
        rows={[
          {
            key: "B-1",
            title: "Truss",
            state: "active",
            start: 0,
            end: 3,
            progress: 40,
            baselineStart: 0,
            baselineEnd: 2,
          },
          {
            key: "B-2",
            title: "Rig",
            state: "blocked",
            start: 4,
            end: 6,
            dependsOn: 0,
            critical: true,
          },
          {
            key: "B-3",
            title: "Sign-off",
            state: "ready",
            start: 7,
            end: 7,
            milestone: true,
            dependsOn: 1,
          },
          { key: "B-4", title: "Strike", state: "proposed", start: 8, end: 9 },
        ]}
      />,
    );
    const table = within(container).getByRole("table", { name: "Build schedule" });
    expect(within(table).getByText("Rig (critical path)")).toBeTruthy();
    expect(within(table).getByText("Sign-off (milestone)")).toBeTruthy();
    // States read as labels, never as the raw state code.
    expect(within(table).getByText("Blocked")).toBeTruthy();
    expect(within(table).queryByText("blocked")).toBeNull();
    expect(container.querySelectorAll("svg path[marker-end]")).toHaveLength(2);
    await expectAccessible(container);
  });

  it("lets the keyboard reach a day grid wider than the screen (A23-015)", async () => {
    const width = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(900);
    const client = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300);
    const days = Array.from({ length: 30 }, (_, i) => ({ dow: "Mo", date: i + 1 }));
    const { container } = render(
      <Timeline
        label="Load-in"
        days={days}
        rows={[{ key: "L-1", title: "Truss", state: "active", start: 0, end: 29 }]}
      />,
    );
    const region = screen.getByRole("region", { name: "Load-in, days" });
    expect(region.getAttribute("tabindex")).toBe("0");
    expect(region.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
    await expectAccessible(container);
    width.mockRestore();
    client.mockRestore();
  });
});

describe("ResourceSchedule and OrgChart", () => {
  it("flags double bookings in place", async () => {
    const { container } = render(
      <ResourceSchedule
        label="Crew"
        days={[
          { key: "mon", dow: "Mon", date: 3 },
          { key: "sat", dow: "Sat", date: 8, weekend: true },
        ]}
        people={[
          {
            name: "Ana Ruiz",
            role: "A1",
            shifts: [
              { day: "mon", time: "07:00", state: "scheduled" },
              { day: "mon", time: "18:00", state: "scheduled" },
            ],
          },
          { name: "Ben Cole", role: "Rigger" },
        ]}
      />,
    );
    expect(screen.getByText("Double-booked")).toBeTruthy();
    await expectAccessible(container);
  });

  it("draws reporting lines and keeps vacant positions", async () => {
    const { container } = render(
      <OrgChart
        label="Production"
        root={{
          name: "Dana Ortiz",
          role: "Producer",
          code: "5000.10",
          reports: [
            { name: null, role: "A1" },
            { name: "Ana Ruiz", role: "Stage Manager" },
          ],
        }}
      />,
    );
    expect(screen.getByText("Vacant")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Production" })).toBeTruthy();
    await expectAccessible(container);
  });
});

describe("Chart", () => {
  const categories = ["Jan", "Feb", "Mar"];

  it("draws bars with a legend, focusable marks and a tooltip, and a table view", async () => {
    const { container } = render(
      <Chart
        type="bar"
        title="Spend by month"
        subtitle="USD"
        categoryLabel="Month"
        format="money"
        categories={categories}
        series={[
          { name: "Audio", values: [1200, null, 900] },
          { name: "Lighting", values: [800, 600, 0] },
        ]}
      />,
    );
    expect(screen.getByRole("list", { name: "Legend" })).toBeTruthy();
    const mark = screen.getByRole("img", { name: "Audio, Jan: $1,200.00" });
    act(() => mark.focus());
    expect(screen.getByRole("status").textContent).toContain("Audio");
    act(() => mark.blur());
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("img", { name: /Audio, Feb/ })).toBeNull();
    await expectAccessible(container);
    await userEvent.click(screen.getByRole("radio", { name: /Table/ }));
    expect(screen.getByText("No value")).toBeTruthy();
    expect(screen.getByRole("table", { name: "Spend by month" })).toBeTruthy();
  });

  it("draws lines with markers and folds an eighth series into Other", async () => {
    const series = Array.from({ length: 8 }, (_, i) => ({
      name: `S${i + 1}`,
      values: [i, i + 1, i === 7 ? null : i + 2],
    }));
    const folded = foldSeries(series, "Other", 3);
    expect(folded).toHaveLength(7);
    expect(folded[6]?.values).toEqual([13, 15, null]);
    const { container } = render(
      <Chart
        type="line"
        title="Headcount"
        categoryLabel="Month"
        categories={categories}
        series={[
          { name: "Crew", values: [3, null, 5] },
          { name: "Staff", values: [1, 2, 3] },
        ]}
      />,
    );
    const point = screen.getByRole("img", { name: "Crew, Mar: 5" });
    await userEvent.hover(point);
    expect(screen.getByRole("status").textContent).toContain("Mar");
    await userEvent.unhover(point);
    expect(container.querySelectorAll("text").length).toBeGreaterThan(5);
    await expectAccessible(container);
    render(
      <Chart
        type="line"
        title="Many"
        categoryLabel="Month"
        categories={categories}
        series={series}
      />,
    );
    expect(screen.getAllByText("Other").length).toBeGreaterThan(0);
  });
});

describe("Sparkline and StatTile trend", () => {
  it("labels the trend when shown in a tile", async () => {
    const { container } = render(
      <div>
        <StatTile label="Open Gaps" value={12} trend={[5, 8, null, 12]} />
        <Sparkline values={[1, 2, 3]} />
      </div>,
    );
    expect(screen.getByRole("img", { name: "Trend for Open Gaps" })).toBeTruthy();
    await expectAccessible(container);
  });
});
