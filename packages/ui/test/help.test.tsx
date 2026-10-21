import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  FeedbackWidget,
  HelpPanel,
  NotificationCenter,
  OnboardingChecklist,
  ShortcutEditor,
  WhatsNew,
} from "../src/index.ts";
import { expectAccessible } from "./a11y.ts";

const needsYou = [
  {
    title: "Approve PO-112",
    meta: "Dana Ortiz · 2 h",
    kind: "Approval" as const,
    action: "Approve",
    actionKey: "A",
  },
  { title: "Sign crew agreement", meta: "Due today" },
];

describe("NotificationCenter", () => {
  it("switches tabs and runs done, snooze and actions from the keyboard", async () => {
    const onDone = vi.fn();
    const onSnooze = vi.fn();
    const onAction = vi.fn();
    const { container } = render(
      <NotificationCenter
        needsYou={needsYou}
        fyi={[{ title: "Budget updated", meta: "Yesterday" }]}
        onDone={onDone}
        onSnooze={onSnooze}
        onAction={onAction}
      />,
    );
    const item = screen.getByText("Approve PO-112").closest("li") as HTMLElement;
    act(() => item.focus());
    fireEvent.keyDown(item, { key: "e" });
    fireEvent.keyDown(item, { key: "h" });
    fireEvent.keyDown(item, { key: "Enter" });
    fireEvent.keyDown(item, { key: "x" });
    expect(onDone).toHaveBeenCalledWith(needsYou[0]);
    expect(onSnooze).toHaveBeenCalledWith(needsYou[0]);
    expect(onAction).toHaveBeenCalledWith(needsYou[0]);
    await userEvent.click(screen.getAllByRole("button", { name: "Done" })[1] as HTMLElement);
    expect(onDone).toHaveBeenLastCalledWith(needsYou[1]);
    await userEvent.click(screen.getByRole("tab", { name: /For Your Information/ }));
    expect(screen.getByText("Budget updated")).toBeTruthy();
    await expectAccessible(container);
  });
});

describe("checklist, what's new and feedback", () => {
  it("counts done steps and runs the next action", async () => {
    const onAction = vi.fn();
    const { container } = render(
      <OnboardingChecklist
        title="Set Up Northwind"
        onAction={onAction}
        steps={[
          { label: "Invite team", done: true },
          { label: "Create project", done: false, action: "Create" },
        ]}
      />,
    );
    expect(screen.getByText("1 of 2")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(onAction).toHaveBeenCalledWith("Create project");
    await expectAccessible(container);
  });

  it("lists recent changes", async () => {
    const { container } = render(
      <WhatsNew
        changelogHref="/changelog"
        entries={[
          {
            label: "New",
            date: "Oct 9",
            title: "Gate readiness",
            body: "See blockers at a glance.",
          },
          {
            label: "Fix",
            tone: "neutral",
            date: "Oct 2",
            title: "Faster tables",
            body: "Lists scroll at 60 fps.",
          },
        ]}
      />,
    );
    expect(screen.getByRole("link", { name: "Changelog" }).getAttribute("href")).toBe("/changelog");
    await expectAccessible(container);
  });

  it("sends feedback only after something is written", async () => {
    const onSend = vi.fn();
    const { container } = render(<FeedbackWidget onSend={onSend} />);
    const send = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText("What happened?"), "Export failed");
    await userEvent.click(
      screen.getByRole("checkbox", { name: "Attach a screenshot of this page" }),
    );
    await userEvent.click(send);
    expect(onSend).toHaveBeenCalledWith({ text: "Export failed", screenshot: true });
    expect(screen.getByRole("status").textContent).toContain("Thanks");
    await expectAccessible(container);
  });
});

describe("ShortcutEditor and HelpPanel", () => {
  it("names conflicts and changes or resets shortcuts", async () => {
    const onChange = vi.fn();
    const onReset = vi.fn();
    const { container } = render(
      <ShortcutEditor
        onChange={onChange}
        onReset={onReset}
        rows={[
          { action: "Create record", keys: "C" },
          { action: "Go to projects", keys: "G P", conflict: "Used by Go to People", custom: true },
          { action: "Search", keys: "⌘ K", recording: true },
          { action: "Go to safety", keys: "" },
        ]}
      />,
    );
    expect(screen.getByText("Used by Go to People")).toBeTruthy();
    expect(screen.getByText("Not set")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Press Keys" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    await userEvent.click(screen.getAllByRole("button", { name: "Change" })[0] as HTMLElement);
    await userEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(onChange).toHaveBeenCalledWith("Create record");
    expect(onReset).toHaveBeenCalledWith("Go to projects");
    await expectAccessible(container);
  });

  it("searches help, opens articles and asks the assistant", async () => {
    const onSearch = vi.fn();
    const onArticle = vi.fn();
    const onAsk = vi.fn();
    const onClose = vi.fn();
    const { container } = render(
      <HelpPanel
        assistant
        articles={["Advance a gate"]}
        shortcuts={[{ label: "Command menu", keys: "⌘ K" }]}
        onSearch={onSearch}
        onArticle={onArticle}
        onAsk={onAsk}
        onClose={onClose}
      />,
    );
    await userEvent.type(screen.getByRole("searchbox", { name: "Search help" }), "gate");
    expect(onSearch).toHaveBeenLastCalledWith("gate");
    await userEvent.click(screen.getByRole("button", { name: "Advance a gate" }));
    expect(onArticle).toHaveBeenCalledWith("Advance a gate");
    await userEvent.type(
      screen.getByRole("textbox", { name: "Ask a question about this page" }),
      "Why blocked?{Enter}",
    );
    expect(onAsk).toHaveBeenCalledWith("Why blocked?");
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
    await expectAccessible(container);
  });
});
