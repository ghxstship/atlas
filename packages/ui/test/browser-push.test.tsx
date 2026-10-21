import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserPushSetting, type BrowserPushLabels } from "../src/pwa/browser-push.tsx";
import { expectAccessible } from "./a11y.ts";

/** Browser notifications for this browser (A96): on only when asked, off in one action. */

const labels: BrowserPushLabels = {
  title: "Browser Notifications",
  body: "Get notifications in this browser.",
  turnOn: "Turn On",
  turnOff: "Turn Off",
  on: "On in this browser.",
  off: "Off in this browser.",
  blocked: "This browser blocks notifications.",
  unsupported: "This browser cannot show notifications.",
  unavailable: "Browser notifications are not set up yet.",
  failed: "That did not work. Try again.",
};
const KEY = `B${"A".repeat(86)}`;

function browser(subscribed: boolean, permission = "granted") {
  let current: {
    endpoint: string;
    unsubscribe: () => Promise<boolean>;
    toJSON: () => unknown;
  } | null = subscribed
    ? {
        endpoint: "https://push.example.test/send/x",
        unsubscribe: async () => true,
        toJSON: () => ({ endpoint: "x" }),
      }
    : null;
  const registration = {
    pushManager: {
      getSubscription: async () => current,
      subscribe: async () => {
        current = {
          endpoint: "https://push.example.test/send/x",
          unsubscribe: async () => ((current = null), true),
          toJSON: () => ({ endpoint: "x" }),
        };
        return current;
      },
    },
  };
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      register: async () => registration,
      getRegistration: async () => registration,
      ready: Promise.resolve(registration),
    },
  });
  Object.assign(window, {
    PushManager: {},
    Notification: { permission, requestPermission: async () => permission },
  });
}

afterEach(() => {
  Reflect.deleteProperty(navigator, "serviceWorker");
  Reflect.deleteProperty(window, "PushManager");
  Reflect.deleteProperty(window, "Notification");
});

describe("BrowserPushSetting", () => {
  it("says when the platform has not set browser notifications up", async () => {
    render(
      <BrowserPushSetting
        vapidPublicKey={null}
        labels={labels}
        onRegister={vi.fn()}
        onRevoke={vi.fn()}
      />,
    );
    expect((await screen.findByRole("status")).textContent).toBe(labels.unavailable);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("says when this browser cannot show them", async () => {
    render(
      <BrowserPushSetting
        vapidPublicKey={KEY}
        labels={labels}
        onRegister={vi.fn()}
        onRevoke={vi.fn()}
      />,
    );
    expect((await screen.findByRole("status")).textContent).toBe(labels.unsupported);
  });

  it("turns them on when asked and off in one action", async () => {
    browser(false);
    const onRegister = vi.fn(async () => true);
    const onRevoke = vi.fn(async () => true);
    const { container } = render(
      <BrowserPushSetting
        vapidPublicKey={KEY}
        labels={labels}
        onRegister={onRegister}
        onRevoke={onRevoke}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Turn On" }));
    expect(onRegister).toHaveBeenCalledWith({ endpoint: "x" });
    expect((await screen.findByRole("status")).textContent).toBe(labels.on);
    await userEvent.click(screen.getByRole("button", { name: "Turn Off" }));
    expect(onRevoke).toHaveBeenCalledWith("https://push.example.test/send/x");
    expect((await screen.findByRole("status")).textContent).toBe(labels.off);
    await expectAccessible(container);
  });

  it("says so when saving the subscription fails, and when the browser blocks them", async () => {
    browser(false);
    render(
      <BrowserPushSetting
        vapidPublicKey={KEY}
        labels={labels}
        onRegister={async () => false}
        onRevoke={vi.fn()}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Turn On" }));
    expect((await screen.findByRole("alert")).textContent).toBe(labels.failed);
  });

  it("shows a blocked browser without a button", async () => {
    browser(false, "denied");
    render(
      <BrowserPushSetting
        vapidPublicKey={KEY}
        labels={labels}
        onRegister={vi.fn()}
        onRevoke={vi.fn()}
      />,
    );
    expect((await screen.findByRole("status")).textContent).toBe(labels.blocked);
  });
});
