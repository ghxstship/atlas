import { afterEach, describe, expect, it, vi } from "vitest";
import {
  afterHydration,
  applicationServerKey,
  currentPushSubscription,
  forgetOfflinePages,
  pushSupported,
  registerServiceWorker,
  rememberPage,
  serviceWorkerSupported,
  subscribeToPush,
  unsubscribeFromPush,
} from "../src/pwa/client.ts";

/** Browser helpers of the installable apps (A96, ADR 0052) in jsdom, with a stand-in service worker container. */

function installContainer() {
  const posted: unknown[] = [];
  const unsubscribe = vi.fn(async () => true);
  const subscription = {
    endpoint: "https://push.example.test/send/x",
    unsubscribe,
    toJSON: () => ({ endpoint: "https://push.example.test/send/x" }),
  };
  const registration = {
    active: { postMessage: (m: unknown) => posted.push(m) },
    pushManager: {
      getSubscription: vi.fn(async () => subscription),
      subscribe: vi.fn(async () => subscription),
    },
  };
  const container = {
    controller: { postMessage: (m: unknown) => posted.push(m) },
    register: vi.fn(async () => registration),
    getRegistration: vi.fn(async () => registration),
    ready: Promise.resolve(registration),
  };
  Object.defineProperty(navigator, "serviceWorker", { value: container, configurable: true });
  return { posted, container, registration, unsubscribe };
}

afterEach(() => {
  Reflect.deleteProperty(navigator, "serviceWorker");
  Reflect.deleteProperty(window, "PushManager");
  Reflect.deleteProperty(window, "Notification");
});

describe("the service worker helpers", () => {
  it("does nothing where service workers do not run", async () => {
    expect(serviceWorkerSupported()).toBe(false);
    expect(await registerServiceWorker()).toBeNull();
    expect(pushSupported()).toBe(false);
    expect(await currentPushSubscription()).toBeNull();
    expect(await subscribeToPush("key")).toEqual({ ok: false, reason: "unsupported" });
    forgetOfflinePages();
  });

  it("registers the worker for the whole origin and passes it messages", async () => {
    const sw = installContainer();
    expect(await registerServiceWorker()).toBe(sw.registration);
    expect(sw.container.register).toHaveBeenCalledWith("/sw.js", { scope: "/" });
    forgetOfflinePages();
    expect(rememberPage("/northwind/home", 1_000_000)).toBe(true);
    expect(rememberPage("/northwind/inbox", 1_005_000)).toBe(false);
    expect(sw.posted).toEqual([{ type: "sign-out" }, { type: "remember", url: "/northwind/home" }]);
  });

  it("waits for the page to load and the browser to go idle", () => {
    vi.useFakeTimers();
    const task = vi.fn();
    afterHydration(task);
    vi.advanceTimersByTime(2000);
    expect(task).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe("the push helpers", () => {
  it("decodes the VAPID public key", () => {
    expect(Array.from(applicationServerKey("-_8"))).toEqual([251, 255]);
  });

  it("subscribes once permission is granted, and unsubscribes", async () => {
    const sw = installContainer();
    Object.assign(window, {
      PushManager: {},
      Notification: { permission: "granted", requestPermission: async () => "granted" },
    });
    expect(pushSupported()).toBe(true);
    expect(await subscribeToPush("BAAA")).toEqual({
      ok: true,
      subscription: { endpoint: "https://push.example.test/send/x" },
    });
    expect(await unsubscribeFromPush()).toBe("https://push.example.test/send/x");
    expect(sw.unsubscribe).toHaveBeenCalled();
  });

  it("says when the browser blocks notifications", async () => {
    installContainer();
    Object.assign(window, {
      PushManager: {},
      Notification: { permission: "default", requestPermission: async () => "denied" },
    });
    expect(await subscribeToPush("BAAA")).toEqual({ ok: false, reason: "blocked" });
  });
});
