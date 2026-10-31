// @vitest-environment jsdom
/**
 * B3 (RRR-227, ADR 0142): the show keys on a page, in a browser DOM with the shell's key handler installed, as live
 * mode lays them out: the showcaller console, the show channel beside it and, for the registry's list rule, a design
 * system list beside it. The show keys answer only in the console: S, J or Space typed in the channel's message box
 * are letters, Space on the channel's buttons presses the button, and a list's J and K move the list. M in the
 * console hands focus to the message box. The panel offers Open or Join as app.show_channel_status allows, shows
 * that Clients are never in it, and rereads its messages when Realtime reports one. The server actions and Realtime
 * are stand-ins.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getMessages } from "@xos/i18n";
import type { Cue, RunOfShow } from "@xos/data/show";
import type { ShowChannelStatus } from "@xos/data/show-channel";
import type { ChatMessage } from "@xos/data/workforce-chat";
import { SHORTCUT_REGISTRY } from "@xos/schemas/shortcuts";
import type * as XosUi from "@xos/ui";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { createElement as h, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  status: null as ShowChannelStatus | null,
  messages: [] as ChatMessage[],
  live: null as (() => void) | null,
}));

const panel = vi.hoisted(() => ({
  load: vi.fn(),
  open: vi.fn(async () => ({ ok: true as const, data: "conv-1" })),
  join: vi.fn(async () => ({ ok: true as const, data: "conv-1" })),
  send: vi.fn(async () => ({ ok: true as const, data: "msg-new" })),
}));

vi.mock("@/components/show/depth-actions", () => ({
  loadShowChannelAction: panel.load,
  openShowChannelAction: panel.open,
  joinShowChannelAction: panel.join,
  sendShowChannelMessageAction: panel.send,
}));
// The console's own server actions; every test gives it a transport instead.
vi.mock("@/components/show/actions", () => ({
  callCueAction: vi.fn(),
  standbyCueAction: vi.fn(),
  shiftCuePlanAction: vi.fn(),
}));
vi.mock("@xos/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof XosUi>()),
  useLive: (subscriptions: unknown, onChange: () => void) => {
    state.live = subscriptions === null ? null : onChange;
  },
}));

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
Object.assign(globalThis, { ResizeObserver: globalThis.ResizeObserver ?? ResizeObserverStub });
if (typeof window.matchMedia !== "function") {
  Object.assign(window, {
    matchMedia: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
// jsdom lays nothing out, so every control would look hidden to the shell's shortcut targets; give each a box, as a
// browser does, so a shortcut that reached the console's controls from outside would press them here too.
Element.prototype.getClientRects = function getClientRects() {
  return [{ x: 0, y: 0, width: 10, height: 10 }] as unknown as DOMRectList;
};

const { ShowcallerConsole } = await import("@/components/show/showcaller-console");
const { ShowChannelPanel } = await import("@/components/show/show-channel-panel");
const { showChannelComposerId } = await import("@/components/show/show-channel-ids");
const { ShellKeysContext } = await import("@/components/shell/shell-keys-context");
const { installShellKeys } = await import("@/components/shell/key-dispatch");
const { buildShellKeys } = await import("@/lib/shell/shell-keys");
const { RecordList, RecordRow } = await import("@xos/ui");

const ORG = "northwind-live";
const PROJECT = "prj-1";
const keys = buildShellKeys(SHORTCUT_REGISTRY, {
  platform: "other",
  custom: {},
  goTargets: new Map(),
});
const shell = { command: vi.fn(), go: vi.fn(), pending: vi.fn() };

const run: RunOfShow = {
  id: "run-1",
  projectId: PROJECT,
  projectKey: "SHW",
  projectName: "Summer Headline Weekend",
  timeZone: "America/New_York",
  scopeNodeId: null,
  name: "Opening Night Running Order",
  showDate: "2027-03-13",
  cueCount: 2,
  calledCount: 0,
  curfewAt: null,
};
const cue = (id: string, position: number, label: string): Cue => ({
  id,
  runOfShowId: run.id,
  position,
  label,
  plannedAt: null,
  durationSeconds: null,
  calledAt: null,
  calledByName: null,
  startTbc: false,
  standbyAt: null,
  segment: null,
  description: null,
  script: null,
  segmentInstanceId: null,
  calledViaLink: null,
  updatedAt: "2027-03-13T18:00:00Z",
});
const cues = [cue("cue-1", 1, "House to Half"), cue("cue-2", 2, "Walk-in Music Out")];

const transport = {
  call: vi.fn(async () => ({ ok: true as const, data: null })),
  standby: vi.fn(async () => ({ ok: true as const, data: null })),
  nudge: vi.fn(async () => ({ ok: true as const, data: null })),
};

const member: ShowChannelStatus = {
  exists: true,
  conversationId: "conv-1",
  isMember: true,
  canJoin: false,
  canOpen: false,
};
const message = (id: string, body: string): ChatMessage => ({
  id,
  authorMembershipId: "mem-1",
  authorName: "Sky Stage",
  kind: "Text",
  body,
  language: null,
  createdAt: "2027-03-13T18:01:00Z",
  editedAt: null,
});

/** Live mode as runs.tsx lays it out, with the shell's key handler listening, and optionally a list beside it. */
function renderLive(extra: ReactElement | null = null) {
  const page = h(
    "div",
    { className: "grid" },
    h(
      "div",
      null,
      h(ShowcallerConsole, {
        org: ORG,
        run,
        cues,
        calls: [],
        department: null,
        onDepartment: () => undefined,
        transport,
        onChat: () => document.getElementById(showChannelComposerId(PROJECT))?.focus(),
      }),
    ),
    h(ShowChannelPanel, { org: ORG, projectId: PROJECT }),
    extra,
  );
  return render(
    h(NextIntlClientProvider, {
      locale: "en-US",
      messages: getMessages("en-US"),
      timeZone: "America/New_York",
      children: h(ShellKeysContext.Provider, { value: keys }, page),
    }),
  );
}

let uninstall: () => void = () => undefined;

beforeEach(() => {
  vi.clearAllMocks();
  state.status = member;
  state.messages = [message("msg-1", "Doors in five")];
  state.live = null;
  panel.load.mockImplementation(async () => ({
    ok: true as const,
    data: { status: state.status, messages: state.messages, unread: 0 },
  }));
  uninstall = installShellKeys({ current: { keys, handlers: shell } });
});

afterEach(() => {
  uninstall();
  cleanup();
});

const consoleRegion = () => screen.getByRole("region", { name: "Showcaller console" });
const composer = () => screen.findByLabelText("Message the crew");

describe("the show keys beside the show channel", () => {
  it("answer in the console: S stands the next cue by", async () => {
    const user = userEvent.setup();
    renderLive();
    await composer();
    act(() => consoleRegion().focus());
    await user.keyboard("s");
    expect(transport.standby).toHaveBeenCalledWith("cue-1");
  });

  it("type S, J and Space as letters in the message box, never a standby or a call", async () => {
    const user = userEvent.setup();
    renderLive();
    const box = await composer();
    await user.click(box);
    await user.keyboard("SJ sj ");
    expect((box as HTMLTextAreaElement).value).toBe("SJ sj ");
    expect(transport.standby).not.toHaveBeenCalled();
    expect(transport.call).not.toHaveBeenCalled();
    expect(shell.command).not.toHaveBeenCalled();
  });

  it("leave Space on the channel's Send button to the button", async () => {
    const user = userEvent.setup();
    renderLive();
    const box = await composer();
    await user.click(box);
    await user.keyboard("Standby lights");
    act(() => screen.getByRole("button", { name: "Send" }).focus());
    await user.keyboard(" ");
    await waitFor(() => expect(panel.send).toHaveBeenCalledWith(ORG, "conv-1", "Standby lights"));
    expect(transport.call).not.toHaveBeenCalled();
  });

  it("hand M from the console to the message box", async () => {
    const user = userEvent.setup();
    renderLive();
    const box = await composer();
    act(() => consoleRegion().focus());
    await user.keyboard("m");
    expect(document.activeElement).toBe(box);
    expect(transport.standby).not.toHaveBeenCalled();
  });

  it("leave a list's J and K to the list, while J in the console stands the next cue by", async () => {
    const user = userEvent.setup();
    renderLive(
      h(RecordList, {
        label: "Tasks",
        children: [
          h(RecordRow, {
            key: "1",
            state: "active",
            stateLabel: "Active",
            recordKey: "SHW-1",
            title: "Hang truss",
          }),
          h(RecordRow, {
            key: "2",
            state: "blocked",
            stateLabel: "Blocked",
            recordKey: "SHW-2",
            title: "Load-in",
          }),
        ],
      }),
    );
    await composer();
    const grid = screen.getByRole("grid", { name: "Tasks" });
    const [, first, second] = within(grid).getAllByRole("row");
    act(() => grid.focus());
    expect(document.activeElement).toBe(first);
    await user.keyboard("j");
    expect(document.activeElement).toBe(second);
    await user.keyboard("k");
    expect(document.activeElement).toBe(first);
    expect(transport.standby).not.toHaveBeenCalled();

    act(() => consoleRegion().focus());
    await user.keyboard("j");
    expect(transport.standby).toHaveBeenCalledWith("cue-1");
  });
});

describe("live mode", () => {
  it("marks no show scope region, so the shell never presses the console's controls from beside it", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "../components/show/runs.tsx"), "utf8");
    expect(source).not.toMatch(/data-shortcut-scope=["{]?["']?show/);
  });
});

describe("the show channel panel", () => {
  it("says Clients are never in it and shows the channel's messages", async () => {
    renderLive();
    await composer();
    expect(screen.getByText("Clients are never in this channel.")).toBeTruthy();
    expect(
      within(screen.getByRole("list", { name: "Show channel messages" })).getByText(
        "Doors in five",
      ),
    ).toBeTruthy();
  });

  it("offers Open only when the database allows it, and opens the channel", async () => {
    const user = userEvent.setup();
    state.status = {
      exists: false,
      conversationId: null,
      isMember: false,
      canJoin: false,
      canOpen: true,
    };
    renderLive();
    const open = await screen.findByRole("button", { name: "Open the show channel" });
    expect(screen.queryByRole("button", { name: "Join the show channel" })).toBeNull();
    expect(screen.queryByLabelText("Message the crew")).toBeNull();
    state.status = member;
    await user.click(open);
    await waitFor(() => expect(panel.open).toHaveBeenCalledWith(ORG, PROJECT));
    await composer();
  });

  it("offers Join to a reader who is not in it", async () => {
    const user = userEvent.setup();
    state.status = {
      exists: true,
      conversationId: null,
      isMember: false,
      canJoin: true,
      canOpen: false,
    };
    renderLive();
    const join = await screen.findByRole("button", { name: "Join the show channel" });
    expect(screen.queryByRole("button", { name: "Open the show channel" })).toBeNull();
    state.status = member;
    await user.click(join);
    await waitFor(() => expect(panel.join).toHaveBeenCalledWith(ORG, PROJECT));
    await composer();
  });

  it("offers neither to someone the database lets do neither", async () => {
    state.status = {
      exists: true,
      conversationId: null,
      isMember: false,
      canJoin: false,
      canOpen: false,
    };
    renderLive();
    await screen.findByText("You are not in this show channel.");
    expect(screen.queryByRole("button", { name: "Join the show channel" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open the show channel" })).toBeNull();
  });

  it("shows a new message when Realtime reports one, without a page refresh", async () => {
    renderLive();
    await composer();
    expect(state.live).not.toBeNull();
    state.messages = [...state.messages, message("msg-2", "Lights to half on my go")];
    act(() => state.live?.());
    await screen.findByText("Lights to half on my go");
    expect(panel.load).toHaveBeenCalledTimes(2);
  });
});
