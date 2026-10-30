// @vitest-environment jsdom
/**
 * Regions that fail alone (Section 11.7, ADR 0118). Atlas's Region wraps @xos/ui's RegionBoundary
 * with Next: a redirect or not found thrown inside it reaches Next's boundaries instead of showing
 * Retry, a caught error goes to the browser error reporter, and Retry fetches the route again and
 * renders the region in one transition. RegionFailed and RegionContent show the same Retry for a
 * region whose loader could not read its data, and the dashboard grid keeps every other tile when
 * one tile fails. next/navigation keeps Next's own redirect, notFound and unstable_rethrow; only the
 * router and the path are replaced, as is the reporter, so nothing leaves the test.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { getMessages } from "@xos/i18n";
import type { DashboardTile } from "@xos/ui";
import type { Route } from "next";
import { NextIntlClientProvider } from "next-intl";
import { Component, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ refresh: vi.fn(), pathname: "/acme/home" }));
const reporter = vi.hoisted(() => ({ reportClientError: vi.fn() }));

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRouter: () => ({ refresh: nav.refresh, push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => nav.pathname,
}));
vi.mock("@xos/infra/observability/browser", () => reporter);
vi.mock("@/lib/dashboard/layout-actions", () => ({
  saveDashboardLayoutAction: vi.fn(async () => ({ ok: true })),
  resetDashboardLayoutAction: vi.fn(async () => ({ ok: true })),
}));

const { notFound, redirect } = await import("next/navigation");
const { Region, RegionFailed } = await import("@/components/shell/region");
const { RegionContent } = await import("@/components/shell/region-content");
const { DashboardGrid } = await import("@/components/dashboard/dashboard-grid");

/** A part of the page whose render throws while `broken.now` is true. */
const broken = { now: true };
function Flaky({ label }: { label: string }): ReactNode {
  if (broken.now) throw new Error(`${label} failed to render`);
  return <p>{label} loaded</p>;
}

/** Stands in for the route's error page and not-found page above every region. */
class RouteBoundary extends Component<{ children: ReactNode }, { caught: unknown }> {
  override state = { caught: null as unknown };
  static getDerivedStateFromError(caught: unknown) {
    return { caught };
  }
  override render() {
    return this.state.caught ? (
      <p>route boundary: {(this.state.caught as Error).message}</p>
    ) : (
      this.props.children
    );
  }
}

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  broken.now = true;
  nav.refresh.mockReset();
  nav.pathname = "/acme/home";
  reporter.reportClientError.mockReset();
  // React logs every caught render error; the tests assert on what the page shows instead.
  consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  consoleError.mockRestore();
});

function Page({ children }: { children: ReactNode }) {
  return (
    <RouteBoundary>
      <main>
        <h1>Home</h1>
        {children}
      </main>
    </RouteBoundary>
  );
}

describe("Region", () => {
  it("shows Retry in place of a region that throws, reports it, and keeps the page", async () => {
    render(
      <Page>
        <Region>
          <Flaky label="Alerts" />
        </Region>
        <Region>
          <p>Activity loaded</p>
        </Region>
      </Page>,
    );
    expect(screen.getByRole("heading", { name: "Home" })).toBeTruthy();
    expect(screen.getByText("Activity loaded")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("This section did not load");
    expect(reporter.reportClientError).toHaveBeenCalledTimes(1);
    expect((reporter.reportClientError.mock.calls[0]?.[0] as Error).message).toBe(
      "Alerts failed to render",
    );

    // Retry fetches the route again and renders the region in the same transition.
    broken.now = false;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(nav.refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Alerts loaded")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("passes Next's redirect and not found on to the boundaries above, unreported", () => {
    function Redirecting(): ReactNode {
      return redirect("/acme/login" as Route);
    }
    render(
      <Page>
        <Region>
          <Redirecting />
        </Region>
      </Page>,
    );
    expect(screen.getByText(/route boundary: NEXT_REDIRECT/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

    cleanup();
    function Missing(): ReactNode {
      return notFound();
    }
    render(
      <Page>
        <Region>
          <Missing />
        </Region>
      </Page>,
    );
    expect(screen.getByText(/route boundary: NEXT_HTTP_ERROR_FALLBACK;404/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(reporter.reportClientError).not.toHaveBeenCalled();
  });

  it("clears the error after a navigation", () => {
    const tree = () => (
      <Page>
        <Region>
          <Flaky label="Tiles" />
        </Region>
      </Page>
    );
    const { rerender } = render(tree());
    expect(screen.getByRole("alert")).toBeTruthy();
    broken.now = false;
    nav.pathname = "/acme/inbox";
    rerender(tree());
    expect(screen.getByText("Tiles loaded")).toBeTruthy();
  });
});

describe("RegionFailed and RegionContent", () => {
  it("show Retry for a region whose read failed, which fetches the route again", async () => {
    render(
      <Page>
        <RegionContent<string[]> data={{ ok: false }}>
          {(items) => <p>{items.join(", ")}</p>}
        </RegionContent>
        <RegionContent data={{ ok: true, data: ["Ada", "Grace"] }}>
          {(people) => <p>{people.join(", ")}</p>}
        </RegionContent>
      </Page>,
    );
    expect(screen.getByText("Ada, Grace")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("The rest of the page still works.");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(nav.refresh).toHaveBeenCalledTimes(1);
    // The loader reported the read on the server; the browser does not report it again.
    expect(reporter.reportClientError).not.toHaveBeenCalled();
  });

  it("calls onRetry instead for a region outside the page, such as the shell's peek", () => {
    const onRetry = vi.fn();
    render(
      <Page>
        <RegionFailed onRetry={onRetry} />
      </Page>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it("keeps an error while building the content inside the region", () => {
    render(
      <Page>
        <RegionContent data={{ ok: true, data: 3 }}>
          {() => {
            throw new Error("history could not be worded");
          }}
        </RegionContent>
      </Page>,
    );
    expect(screen.getByRole("heading", { name: "Home" })).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(reporter.reportClientError).toHaveBeenCalledTimes(1);
  });
});

describe("the dashboard grid", () => {
  const messages = getMessages("en-US");
  const tile = (id: string, content: ReactNode): DashboardTile => ({
    id,
    label: id,
    span: 4,
    content,
  });

  it("keeps every other tile when one tile throws and another could not be read", async () => {
    render(
      <NextIntlClientProvider locale="en-US" timeZone="UTC" messages={messages}>
        <Page>
          <DashboardGrid
            dashboard="home"
            header={<h2>Tiles</h2>}
            tiles={[
              tile("readiness", <p>Readiness loaded</p>),
              tile("alerts", <Flaky label="Alerts" />),
              tile("activity", <RegionFailed />),
            ]}
            saved={{}}
            label="Home tiles"
          />
        </Page>
      </NextIntlClientProvider>,
    );
    expect(screen.getByRole("heading", { name: "Home" })).toBeTruthy();
    expect(screen.getByText("Readiness loaded")).toBeTruthy();
    expect(screen.getAllByRole("alert")).toHaveLength(2);
    expect(screen.queryByText(/route boundary/)).toBeNull();

    broken.now = false;
    const [alertsRetry] = screen.getAllByRole("button", { name: "Retry" });
    await act(async () => {
      if (alertsRetry) fireEvent.click(alertsRetry);
    });
    expect(screen.getByText("Alerts loaded")).toBeTruthy();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });
});
