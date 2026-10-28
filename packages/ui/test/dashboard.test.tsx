import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  Card,
  clampSpan,
  spansOf,
  TemplateAuth,
  TemplateCollection,
  TemplateDashboard,
  TemplateDocument,
  TemplateGatewayShell,
  TemplateGridEditor,
  TemplateRecord,
  TemplateSettings,
  TemplateSplitView,
  TemplateSystem,
  TemplateWizard,
  XOSProvider,
  type DashboardResize,
  type DashboardTile,
} from "../src/index.ts";
import { expectAccessible } from "./a11y.ts";

const tiles: DashboardTile[] = [
  { id: "plan", label: "Plan", span: 4, content: <Card>Plan</Card> },
  { id: "alerts", label: "Alerts", span: 8, minSpan: 4, content: <Card>Alerts</Card> },
];

function resizeWith(onChange: DashboardResize["onChange"]): DashboardResize {
  return {
    label: (tile) => `Resize ${tile}`,
    describe: (tile, span) => `${tile}, ${span} of 12 columns`,
    onChange,
  };
}

const tileOf = (id: string) => document.querySelector(`[data-tile="${id}"]`) as HTMLElement;

describe("TemplateDashboard", () => {
  it("lays tiles on the 12-column grid with their spans, the saved ones first", async () => {
    const { container } = render(
      <TemplateDashboard
        header={<h1>Home</h1>}
        controls={<button type="button">Last 7 days</button>}
        tiles={tiles}
        spans={{ plan: 6, unknown: 2 }}
        label="Home tiles"
      />,
    );
    const root = container.querySelector("[data-template='dashboard']") as HTMLElement;
    expect(root).toBeTruthy();
    expect(screen.getByRole("group", { name: "Home tiles" }).className).toContain("grid-cols-12");
    expect(tileOf("plan").dataset["span"]).toBe("6");
    expect(tileOf("plan").style.getPropertyValue("--tile-span")).toBe("6");
    expect(tileOf("alerts").dataset["span"]).toBe("8");
    // The date range and scope picker sit in the header row.
    expect(screen.getByRole("button", { name: "Last 7 days" })).toBeTruthy();
    // Without resize the tiles keep their spans: no handles.
    expect(screen.queryByRole("separator")).toBeNull();
    await expectAccessible(container);
  });

  it("keeps spans in whole columns between the tile's minimum and the full width", () => {
    expect(clampSpan(0)).toBe(3);
    expect(clampSpan(13)).toBe(12);
    expect(clampSpan(5.6)).toBe(6);
    expect(clampSpan(Number.NaN, 4)).toBe(4);
    expect(spansOf(tiles, { alerts: 2, plan: 20 })).toEqual({ plan: 12, alerts: 4 });
  });

  it("resizes a tile with the keyboard, announces each span and reports every span", async () => {
    const onChange = vi.fn();
    const { container } = render(
      <TemplateDashboard header={<h1>Home</h1>} tiles={tiles} resize={resizeWith(onChange)} />,
    );
    const handle = screen.getByRole("separator", { name: "Resize Plan" });
    expect(handle.getAttribute("aria-valuenow")).toBe("4");
    expect(handle.getAttribute("aria-valuemin")).toBe("3");
    expect(handle.getAttribute("aria-valuemax")).toBe("12");
    expect(handle.getAttribute("aria-valuetext")).toBe("Plan, 4 of 12 columns");
    handle.focus();
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(tileOf("plan").dataset["span"]).toBe("5");
    expect(onChange).toHaveBeenLastCalledWith({ plan: 5, alerts: 8 });
    expect(container.querySelector("[aria-live='polite']")?.textContent).toBe(
      "Plan, 5 of 12 columns",
    );
    fireEvent.keyDown(handle, { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith({ plan: 12, alerts: 8 });
    fireEvent.keyDown(handle, { key: "Home" });
    expect(tileOf("plan").dataset["span"]).toBe("3");
    // At the minimum, shrinking again changes nothing and saves nothing.
    onChange.mockClear();
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(onChange).not.toHaveBeenCalled();
    const alerts = screen.getByRole("separator", { name: "Resize Alerts" });
    fireEvent.keyDown(alerts, { key: "Home" });
    expect(tileOf("alerts").dataset["span"]).toBe("4");
    await expectAccessible(container);
  });

  it("mirrors the arrow keys in right-to-left", () => {
    const onChange = vi.fn();
    render(
      <XOSProvider locale="ar-XB">
        <TemplateDashboard header={<h1>Home</h1>} tiles={tiles} resize={resizeWith(onChange)} />
      </XOSProvider>,
    );
    const handle = screen.getByRole("separator", { name: "Resize Plan" });
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(tileOf("plan").dataset["span"]).toBe("5");
  });

  it("snaps a drag to whole grid units and saves once the drag ends", () => {
    const onChange = vi.fn();
    render(
      <TemplateDashboard header={<h1>Home</h1>} tiles={tiles} resize={resizeWith(onChange)} />,
    );
    const grid = tileOf("plan").parentElement as HTMLElement;
    // 12 columns of 50 px with no gap: one grid unit is 50 px.
    Object.defineProperty(grid, "clientWidth", { configurable: true, value: 600 });
    const handle = screen.getByRole("separator", { name: "Resize Plan" });
    fireEvent.pointerDown(handle, { clientX: 200 });
    act(() => {
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 290 }));
    });
    expect(tileOf("plan").dataset["span"]).toBe("6");
    expect(onChange).not.toHaveBeenCalled();
    act(() => {
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 2000 }));
      window.dispatchEvent(new MouseEvent("pointerup"));
    });
    expect(tileOf("plan").dataset["span"]).toBe("12");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ plan: 12, alerts: 8 });
  });

  it("puts free content on the grid at four columns", () => {
    const { container } = render(
      <TemplateDashboard header={<h1>Reports</h1>}>
        <Card>One</Card>
        <Card>Two</Card>
      </TemplateDashboard>,
    );
    const cells = container.querySelectorAll(".lg\\:col-span-4");
    expect(cells).toHaveLength(2);
  });
});

describe("page templates", () => {
  it("each template root names its template, so a page check can find exactly one", () => {
    const { container } = render(
      <div>
        <TemplateCollection header={<h1>Projects</h1>}>Body</TemplateCollection>
        <TemplateRecord header={<h1>NWS-1</h1>} properties={<p>Props</p>}>
          Body
        </TemplateRecord>
        <TemplateSplitView list={<p>List</p>} detail={<p>Detail</p>} />
        <TemplateDashboard header={<h1>Home</h1>} />
        <TemplateSettings sections={<p>Sections</p>}>Form</TemplateSettings>
        <TemplateWizard steps={["One"]} current={0} title="Create">
          Step
        </TemplateWizard>
        <TemplateGridEditor header={<h1>Budget</h1>}>Grid</TemplateGridEditor>
        <TemplateDocument outline={<p>Outline</p>}>Body</TemplateDocument>
        <TemplateAuth>Sign in</TemplateAuth>
        <TemplateGatewayShell topNav={<nav>Top</nav>}>Feed</TemplateGatewayShell>
        <TemplateSystem icon="Compass" title="Not found" sentence="Gone." actionLabel="Home" />
      </div>,
    );
    const names = [...container.querySelectorAll("[data-template]")].map((el) =>
      el.getAttribute("data-template"),
    );
    expect(names).toEqual([
      "collection",
      "record",
      "split-view",
      "dashboard",
      "settings",
      "wizard",
      "grid-editor",
      "document",
      "auth",
      "gateway-shell",
      "system",
    ]);
  });
});
