import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The live Show screen with two running orders under way (C-08), as an operator calls cues: the real ShowView and the
 * real show rules over rows held in memory. Only the native primitives and the provider are stand-ins. It proves the
 * screen stays on the running order it is on while cues are called, that only the person moves it, and that show mode
 * still names the running order on screen.
 */

const now = Date.UTC(2026, 10, 14, 20, 0, 0);
const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();

interface CueRow {
  readonly id: string;
  readonly project_id: string;
  readonly run_of_show_id: string;
  readonly position: number;
  readonly label: string;
  readonly planned_at: string | null;
  readonly duration: null;
  readonly called_at: string | null;
}

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  enqueue: vi.fn(),
}));

vi.mock("expo-haptics", () => ({
  notificationAsync: vi.fn(),
  NotificationFeedbackType: { Warning: "warning" },
}));
vi.mock("expo-keep-awake", () => ({
  activateKeepAwakeAsync: vi.fn(async () => undefined),
  deactivateKeepAwake: vi.fn(async () => undefined),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key} ${JSON.stringify(values)}` : key,
    i18n: { language: "en-US" },
  }),
}));
vi.mock("../../src/screens/common", () => ({
  formatDay: (iso: string) => iso.slice(0, 10),
  formatTime: (iso: string) => iso.slice(11, 16),
  ProjectPicker: () => null,
  SyncBanner: () => null,
  useAllowed: () => true,
}));
vi.mock("../../src/runtime/CompassProvider", () => ({
  useCompass: () => ({
    projectId: "proj-1",
    enqueue: h.enqueue,
    settings: { showDepartment: null, haptics: false },
    updateSettings: vi.fn(),
    orgSettings: new Map(),
    client: {},
    refreshTables: vi.fn(),
    network: { isConnected: false },
  }),
  useRows: (table: string, filter: (row: Record<string, unknown>) => boolean) => ({
    rows: (h.tables[table] ?? []).filter(filter),
  }),
}));
vi.mock("../../src/ui", () => ({
  announce: vi.fn(),
  Screen: ({
    children,
    testID,
    title,
    footer,
  }: {
    children: ReactNode;
    testID: string;
    title: string;
    footer?: ReactNode;
  }) => (
    <main data-testid={testID}>
      <h1>{title}</h1>
      {children}
      <footer>{footer}</footer>
    </main>
  ),
  ThemeProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Card: ({ children, testID }: { children: ReactNode; testID?: string }) => (
    <section data-testid={testID}>{children}</section>
  ),
  Text: ({ children, testID }: { children: ReactNode; testID?: string }) => (
    <p data-testid={testID}>{children}</p>
  ),
  Tag: ({ label, testID }: { label: string; testID?: string }) => (
    <span data-testid={testID}>{label}</span>
  ),
  InlineAlert: ({ message }: { message: string }) => <div role="alert">{message}</div>,
  EmptyState: ({ testID }: { testID: string }) => <div data-testid={testID} />,
  ProgressBar: ({ label }: { label: string }) => <div>{label}</div>,
  SegmentedControl: () => null,
  RunOfShowLive: () => null,
  Sheet: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
  ListRow: (props: { testID: string; title: string; selected?: boolean; onPress: () => void }) => (
    <button
      data-testid={props.testID}
      role="radio"
      aria-checked={props.selected}
      onClick={props.onPress}
    >
      {props.title}
    </button>
  ),
  Button: (props: { testID: string; label: string; onPress: () => void }) => (
    <button data-testid={props.testID} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));

const { ShowView } = await import("../../src/screens/ShowView");

const cue = (
  order: "main" | "side",
  position: number,
  planned: number,
  called: number | null = null,
): CueRow => ({
  id: `${order}-${position}`,
  project_id: "proj-1",
  run_of_show_id: order === "main" ? "ros-main" : "ros-side",
  position,
  label: `${order === "main" ? "Main" : "Side"} ${position}`,
  planned_at: at(planned),
  duration: null,
  called_at: called === null ? null : at(called),
});

/** Calling a cue lands as its optimistic row would: the cue reads called from then on. */
function callsLand() {
  h.enqueue.mockImplementation(async (m: { optimistic: CueRow }) => {
    h.tables["cues"] = (h.tables["cues"] ?? []).map((c) =>
      c["id"] === m.optimistic.id ? { ...c, called_at: m.optimistic.called_at } : c,
    );
  });
}

const tick = () =>
  act(async () => {
    vi.advanceTimersByTime(500);
  });
const callCue = () => screen.getByTestId("call-cue").textContent ?? "";
const picker = () => screen.getByTestId("running-order-picker").textContent ?? "";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(now);
  // Both stages under way: main's next cue (2) is in 5 min, the side stage's (2) in 10.
  h.tables = {
    cues: [
      cue("main", 1, -5, -5),
      cue("main", 2, 5),
      cue("main", 3, 30),
      cue("side", 1, -5, -5),
      cue("side", 2, 10),
    ] as unknown as Record<string, unknown>[],
    run_of_show: [
      { id: "ros-main", project_id: "proj-1", name: "Main Stage", show_date: null },
      { id: "ros-side", project_id: "proj-1", name: "Side Stage", show_date: null },
    ],
  };
  callsLand();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Show with several running orders", () => {
  it("stays on the running order it is on while the operator calls its cues", async () => {
    render(<ShowView readOnly={false} />);
    expect(picker()).toContain("Main Stage");
    expect(callCue()).toContain("Main 2");

    // Calling main 2 makes the side stage's next cue (10 min) sooner than main's (30 min).
    await act(async () => {
      fireEvent.click(screen.getByTestId("call-cue"));
    });
    await tick();
    expect(picker()).toContain("Main Stage");
    expect(callCue()).toContain("Main 3");
    await tick();
    expect(picker()).toContain("Main Stage");

    // The next call is the main stage's, never the side stage's.
    await act(async () => {
      fireEvent.click(screen.getByTestId("call-cue"));
    });
    expect(h.enqueue.mock.calls.map((c) => (c[0] as { rowId: string }).rowId)).toEqual([
      "main-2",
      "main-3",
    ]);
  });

  it("moves to another running order only when the person picks it, and says which is chosen", async () => {
    render(<ShowView readOnly={false} />);
    fireEvent.click(screen.getByTestId("running-order-picker"));
    expect(screen.getByTestId("running-order-ros-main").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("running-order-ros-side").getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByTestId("running-order-ros-side"));
    await tick();
    expect(picker()).toContain("Side Stage");
    expect(callCue()).toContain("Side 2");
    // The picker names the control, not only the order.
    expect(picker()).toContain("compass.show.runningOrderOnScreen");
  });

  it("names the running order on screen in show mode, where the picker is hidden", () => {
    render(<ShowView readOnly={false} />);
    fireEvent.click(screen.getByTestId("show-mode"));
    expect(screen.queryByTestId("running-order-picker")).toBeNull();
    expect(screen.getByTestId("running-order-name").textContent).toContain("Main Stage");
  });
});
