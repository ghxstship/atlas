import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Component, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import esUSui from "@xos/i18n/messages/es-US/ui.json" with { type: "json" };
import { RegionBoundary, XOSProvider, flattenMessages } from "../src/index.ts";
import { ROUTE_TRANSITION_CLASS, RouteTransition } from "../src/lib/route-transition.tsx";
import { expectAccessible } from "./a11y.ts";

/** A region whose render throws while `broken.now` is true. */
const broken = { now: true };
function Flaky({ label }: { label: string }) {
  if (broken.now) throw new Error(`${label} failed to render`);
  return <p>{label} loaded</p>;
}

/** Stands in for a framework's redirect, which a region must not swallow. */
class Redirect extends Error {}

class Outer extends Component<{ children: ReactNode }, { caught: unknown }> {
  override state = { caught: null as unknown };
  static getDerivedStateFromError(caught: unknown) {
    return { caught };
  }
  override render() {
    return this.state.caught ? <p>outer caught it</p> : this.props.children;
  }
}

// React logs every caught render error; the tests assert on what the page shows instead.
let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  broken.now = true;
  consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => consoleError.mockRestore());

describe("RegionBoundary", () => {
  it("keeps the rest of the page when one region throws, then recovers on Retry", async () => {
    const onError = vi.fn();
    render(
      <main>
        <h1>Home</h1>
        <RegionBoundary onError={onError}>
          <Flaky label="Alerts" />
        </RegionBoundary>
        <RegionBoundary>
          <p>Activity loaded</p>
        </RegionBoundary>
      </main>,
    );
    expect(screen.getByRole("heading", { name: "Home" })).toBeTruthy();
    expect(screen.getByText("Activity loaded")).toBeTruthy();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("This section did not load");
    expect(alert.textContent).toContain("The rest of the page still works.");
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe("Alerts failed to render");
    await expectAccessible();

    broken.now = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByText("Alerts loaded")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("shows the alert again when the retry fails too, and names the region when given a title", async () => {
    const onError = vi.fn();
    render(
      <RegionBoundary title="Alerts did not load" onError={onError}>
        <Flaky label="Alerts" />
      </RegionBoundary>,
    );
    expect(screen.getByRole("alert").textContent).toContain("Alerts did not load");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it("lets the app fetch the region again before it clears the error", async () => {
    const onRetry = vi.fn((reset: () => void) => {
      broken.now = false;
      reset();
    });
    render(
      <RegionBoundary onRetry={onRetry}>
        <Flaky label="Comments" />
      </RegionBoundary>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Comments loaded")).toBeTruthy();
  });

  it("clears the error when its reset key changes, as after a navigation", () => {
    const { rerender } = render(
      <RegionBoundary resetKey="/acme/home">
        <Flaky label="Readiness" />
      </RegionBoundary>,
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    broken.now = false;
    rerender(
      <RegionBoundary resetKey="/acme/home">
        <Flaky label="Readiness" />
      </RegionBoundary>,
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    rerender(
      <RegionBoundary resetKey="/acme/inbox">
        <Flaky label="Readiness" />
      </RegionBoundary>,
    );
    expect(screen.getByText("Readiness loaded")).toBeTruthy();
  });

  it("throws pass-through errors on to the boundary above without reporting them", () => {
    const onError = vi.fn();
    function Redirecting(): ReactNode {
      throw new Redirect("NEXT_REDIRECT");
    }
    render(
      <Outer>
        <RegionBoundary onError={onError} passThrough={(error) => error instanceof Redirect}>
          <Redirecting />
        </RegionBoundary>
      </Outer>,
    );
    expect(screen.getByText("outer caught it")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it("speaks es-US", () => {
    render(
      <XOSProvider locale="es-US" messages={flattenMessages(esUSui)}>
        <RegionBoundary>
          <Flaky label="Alertas" />
        </RegionBoundary>
      </XOSProvider>,
    );
    expect(screen.getByRole("alert").textContent).toContain("Esta sección no se cargó");
    expect(screen.getByRole("button", { name: "Reintentar" })).toBeTruthy();
  });
});

describe("RouteTransition", () => {
  it("renders the page as it is, with no markup of its own", () => {
    expect(ROUTE_TRANSITION_CLASS).toBe("xos-route");
    expect(
      renderToStaticMarkup(
        <RouteTransition>
          <p>Projects</p>
        </RouteTransition>,
      ),
    ).toBe("<p>Projects</p>");
  });
});
