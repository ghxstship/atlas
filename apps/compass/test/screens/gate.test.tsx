import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { CompassIdentity } from "../../src/domain/access";

/**
 * The access gate on a whole route (C-07): a refused person sees the refusal in a Screen, which clears the native
 * large-title header and names the page, never a blank page under the back button. The real Gate and access rules run;
 * only the native primitives and the provider are stand-ins.
 */

const h = vi.hoisted(() => ({ identity: null as CompassIdentity | null }));

vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("expo-router", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en-US" } }),
}));
vi.mock("../../src/screens/OrgSwitcher", () => ({ OrgSwitcher: () => null }));
vi.mock("../../src/runtime/i18n", () => ({ countKey: (key: string) => key }));
vi.mock("../../src/ui", () => ({
  Screen: ({
    children,
    testID,
    title,
  }: {
    children: ReactNode;
    testID?: string;
    title?: string;
  }) => (
    <main data-testid={testID}>
      {title ? <h1>{title}</h1> : null}
      {children}
    </main>
  ),
  RefusalNotice: (props: { testID: string; title: string; actionLabel: string }) => (
    <section data-testid={props.testID}>
      <h2>{props.title}</h2>
      <button>{props.actionLabel}</button>
    </section>
  ),
  Skeleton: () => <div data-testid="skeleton" />,
  announce: vi.fn(),
  Banner: () => null,
  Button: () => null,
  ErrorState: () => null,
  ListRow: () => null,
  OfflineBanner: () => null,
  Sheet: () => null,
  useTheme: () => ({ space: { "8": 8 } }),
}));
vi.mock("../../src/runtime/CompassProvider", () => ({
  useCompass: () => ({
    resolved: h.identity ? { identity: h.identity, projects: [] } : null,
    projectId: "proj-1",
  }),
  useRows: () => ({ rows: [] }),
}));

const { Gate } = await import("../../src/screens/common");

const client: CompassIdentity = {
  personId: "x",
  displayName: "Client",
  audience: "client",
  capabilities: [],
  membershipId: null,
  engagements: [
    {
      id: "e1",
      orgId: "o1",
      orgName: "Demo Org",
      projectId: "proj-1",
      projectName: "Demo",
      roleType: "client",
      state: "Active",
      via: "engagement",
      rosterEntryId: null,
    },
  ],
};

describe("C-07: a refused route shows its refusal in a Screen", () => {
  it("frames the refusal with the route title and a way to Today", () => {
    h.identity = client;
    render(
      <Gate feature="incidents.report" title="Incidents">
        <p>incidents body</p>
      </Gate>,
    );
    const frame = screen.getByTestId("gate-incidents.report");
    expect(frame.querySelector("h1")?.textContent).toBe("Incidents");
    expect(frame.querySelector('[data-testid="denial-role"]')).toBeTruthy();
    expect(screen.getByText(/^compass\.scan\.goToday$/)).toBeTruthy();
    expect(screen.queryByText(/incidents body/)).toBeNull();
  });

  it("frames the skeleton while access loads", () => {
    h.identity = null;
    render(
      <Gate feature="show.live" title="Show">
        <p>show body</p>
      </Gate>,
    );
    expect(
      screen.getByTestId("gate-show.live").querySelector('[data-testid="skeleton"]'),
    ).toBeTruthy();
  });

  it("draws in place when nested in a Screen of its own", () => {
    h.identity = client;
    render(
      <Gate feature="expenses.submit">
        <p>expenses body</p>
      </Gate>,
    );
    expect(screen.queryByTestId("gate-expenses.submit")).toBeNull();
    expect(screen.getByTestId("denial-role")).toBeTruthy();
  });

  it("renders the route when the person may use it", () => {
    h.identity = client;
    render(
      <Gate feature="show.read" title="Run of Show">
        <p>running order</p>
      </Gate>,
    );
    expect(screen.getByText(/running order/)).toBeTruthy();
    expect(screen.queryByTestId("gate-show.read")).toBeNull();
  });
});
