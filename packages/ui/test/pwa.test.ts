// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  OFFLINE_KEY_HEADER,
  manifestColors,
  offlineKey,
  serviceWorkerScript,
  themeColors,
  tokenColor,
} from "../src/pwa/index.ts";

/**
 * The service worker (A96, ADR 0052) run against a fake worker scope: caches, fetch, clients and push. It must keep
 * pages per person, never touch a mutation, an API call or another person's page, clear everything on sign-out and
 * answer offline from the person's pages or the offline page.
 */

const ORIGIN = "https://atlas.example.test";
const ALICE = "a".repeat(32);
const BOB = "b".repeat(32);

class FakeCache {
  readonly entries = new Map<string, Response>();
  private key(input: RequestInfo | URL): string {
    return new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      ORIGIN,
    ).href;
  }
  async match(input: RequestInfo | URL): Promise<Response | undefined> {
    return this.entries.get(this.key(input))?.clone();
  }
  async put(input: RequestInfo | URL, response: Response): Promise<void> {
    const key = this.key(input);
    this.entries.delete(key);
    this.entries.set(key, response);
  }
  async keys(): Promise<Request[]> {
    return [...this.entries.keys()].map((k) => new Request(k));
  }
  async delete(input: RequestInfo | URL): Promise<boolean> {
    return this.entries.delete(this.key(input));
  }
}

class FakeCaches {
  readonly stores = new Map<string, FakeCache>();
  async open(name: string): Promise<FakeCache> {
    const existing = this.stores.get(name);
    if (existing) return existing;
    const created = new FakeCache();
    this.stores.set(name, created);
    return created;
  }
  async keys(): Promise<string[]> {
    return [...this.stores.keys()];
  }
  async delete(name: string): Promise<boolean> {
    return this.stores.delete(name);
  }
}

interface Event {
  waits: Promise<unknown>[];
  answer?: Promise<Response>;
}

function page(key: string | null, init: { status?: number; type?: string; body?: string } = {}) {
  const headers: Record<string, string> = {
    "content-type": init.type ?? "text/html; charset=utf-8",
  };
  if (key) headers[OFFLINE_KEY_HEADER] = key;
  return new Response(init.body ?? "<html>page</html>", { status: init.status ?? 200, headers });
}

function worker(answer: (request: Request) => Response | Promise<Response>) {
  const listeners = new Map<string, (event: unknown) => void>();
  const caches = new FakeCaches();
  const unsubscribe = vi.fn(async () => true);
  const notifications: { title: string; options: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const windows: { url: string; focus: () => Promise<unknown> }[] = [];
  const fetched: string[] = [];
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    skipWaiting: vi.fn(async () => undefined),
    clients: {
      claim: vi.fn(async () => undefined),
      matchAll: async () => windows,
      openWindow: async (url: string) => {
        opened.push(url);
        return null;
      },
    },
    registration: {
      pushManager: { getSubscription: async () => ({ unsubscribe }) },
      showNotification: async (title: string, options: Record<string, unknown>) => {
        notifications.push({ title, options });
      },
    },
  };
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request =
      input instanceof Request ? input : new Request(new URL(String(input), ORIGIN), init);
    fetched.push(request.url);
    return answer(request);
  };
  const script = serviceWorkerScript({
    app: "Atlas",
    version: "v1",
    offlinePath: "/auth/offline",
    icon: "/icon.svg",
  });
  new Function("self", "caches", "fetch", script)(self, caches, fetchImpl);

  async function dispatch(type: string, extra: Record<string, unknown>): Promise<Event> {
    const event: Event = { waits: [] };
    const full = {
      ...extra,
      waitUntil: (p: Promise<unknown>) => event.waits.push(p),
      respondWith: (p: Promise<Response> | Response) => {
        event.answer = Promise.resolve(p);
      },
    };
    listeners.get(type)?.(full);
    if (event.answer) await event.answer;
    await Promise.all(event.waits);
    return event;
  }
  const navigate = (path: string, method = "GET") => {
    const request = new Request(new URL(path, ORIGIN), { method });
    Object.defineProperty(request, "mode", {
      value: method === "GET" ? "navigate" : "same-origin",
    });
    return dispatch("fetch", { request });
  };
  const subresource = (path: string, method = "GET", origin = ORIGIN) =>
    dispatch("fetch", { request: new Request(new URL(path, origin), { method }) });
  const pages = (key: string) =>
    [...(caches.stores.get(`xos-pages-${key}`)?.entries.keys() ?? [])].map(
      (u) => new URL(u).pathname,
    );
  return {
    caches,
    dispatch,
    navigate,
    subresource,
    pages,
    unsubscribe,
    notifications,
    opened,
    windows,
    fetched,
  };
}

describe("the service worker's offline pages", () => {
  it("keeps a page for the person it was served to and answers offline from it", async () => {
    let online = true;
    const sw = worker((r) =>
      online
        ? page(ALICE, { body: `<p>${new URL(r.url).pathname}</p>` })
        : Promise.reject(new TypeError("offline")),
    );
    await sw.dispatch("install", {});
    await sw.navigate("/northwind/home");
    expect(sw.pages(ALICE)).toEqual(["/northwind/home"]);
    online = false;
    const event = await sw.navigate("/northwind/home");
    expect(await (await event.answer)?.text()).toBe("<p>/northwind/home</p>");
  });

  it("answers with the offline page for a page it never kept", async () => {
    let online = true;
    const sw = worker((r) =>
      online
        ? page(null, { body: new URL(r.url).pathname === "/auth/offline" ? "offline page" : "x" })
        : Promise.reject(new TypeError("offline")),
    );
    await sw.dispatch("install", {});
    online = false;
    const event = await sw.navigate("/northwind/projects");
    expect(await (await event.answer)?.text()).toBe("offline page");
  });

  it("keeps nothing for a signed-out visitor, a redirect, an error or anything but HTML", async () => {
    const answers = [
      page(null),
      page(ALICE, { status: 500 }),
      page(ALICE, { type: "application/json" }),
      page(ALICE, { status: 404 }),
    ];
    const sw = worker(() => answers.shift() ?? page(null));
    for (const path of ["/a", "/b", "/c", "/d"]) await sw.navigate(path);
    expect(sw.caches.stores.has(`xos-pages-${ALICE}`)).toBe(false);
  });

  it("never touches a mutation, an API call, an auth page, a token link, a server component request or another origin", async () => {
    const sw = worker(() => page(ALICE));
    for (const event of [
      await sw.navigate("/northwind/projects", "POST"),
      await sw.subresource("/api/v1/projects"),
      await sw.navigate("/auth/sign-in"),
      await sw.navigate("/advance/xadv_123"),
      await sw.navigate("/northwind/home?token=abc"),
      await sw.navigate("/northwind/home?_rsc=1"),
      await sw.subresource("/northwind/home"),
      await sw.subresource("/x", "GET", "https://other.example.test"),
    ])
      expect(event.answer).toBeUndefined();
    expect(sw.caches.stores.has(`xos-pages-${ALICE}`)).toBe(false);
  });

  it("files each page under its own person and drops the last person's pages", async () => {
    let key = ALICE;
    const sw = worker(() => page(key));
    await sw.navigate("/northwind/home");
    key = BOB;
    await sw.navigate("/harbor/home");
    expect(sw.caches.stores.has(`xos-pages-${ALICE}`)).toBe(false);
    expect(sw.pages(BOB)).toEqual(["/harbor/home"]);
  });

  it("keeps the 30 most recent pages", async () => {
    const sw = worker(() => page(ALICE));
    for (let i = 0; i < 32; i += 1) await sw.navigate(`/northwind/p/NWS/${i}`);
    expect(sw.pages(ALICE)).toHaveLength(30);
    expect(sw.pages(ALICE)[0]).toBe("/northwind/p/NWS/2");
  });

  it("forgets every page and unsubscribes from push on sign-out", async () => {
    const sw = worker(() => page(ALICE));
    await sw.navigate("/northwind/home");
    await sw.navigate("/auth/sign-out", "POST");
    expect(sw.caches.stores.has(`xos-pages-${ALICE}`)).toBe(false);
    expect(sw.unsubscribe).toHaveBeenCalledTimes(1);
    await sw.navigate("/northwind/home");
    await sw.dispatch("message", { data: { type: "sign-out" } });
    expect(sw.caches.stores.has(`xos-pages-${ALICE}`)).toBe(false);
  });

  it("keeps a page reached by client-side navigation when asked, but not twice in half an hour", async () => {
    const sw = worker(() => page(ALICE));
    await sw.dispatch("message", { data: { type: "remember", url: "/northwind/inbox" } });
    expect(sw.pages(ALICE)).toEqual(["/northwind/inbox"]);
    await sw.dispatch("message", { data: { type: "remember", url: "/northwind/inbox" } });
    await sw.dispatch("message", { data: { type: "remember", url: "/api/v1/projects" } });
    expect(sw.fetched.filter((u) => u.endsWith("/northwind/inbox"))).toHaveLength(1);
    expect(sw.fetched.some((u) => u.includes("/api/"))).toBe(false);
  });

  it("caches build files on first use and retires the previous build's", async () => {
    const sw = worker(() => new Response("js", { status: 200 }));
    await sw.caches.open("xos-static-v0");
    await sw.subresource("/_next/static/chunks/app.js");
    await sw.subresource("/_next/static/chunks/app.js");
    expect(sw.fetched.filter((u) => u.endsWith("app.js"))).toHaveLength(1);
    await sw.dispatch("activate", {});
    expect(await sw.caches.keys()).not.toContain("xos-static-v0");
  });
});

describe("the service worker's push", () => {
  it("shows the dispatcher's notification and opens its path on this origin", async () => {
    const sw = worker(() => page(null));
    await sw.dispatch("push", {
      data: {
        json: () => ({
          title: "Approval needed",
          body: "Bob asked.",
          tag: "n-1",
          url: "/northwind/inbox",
        }),
      },
    });
    expect(sw.notifications[0]).toEqual({
      title: "Approval needed",
      options: {
        body: "Bob asked.",
        data: { url: "/northwind/inbox" },
        icon: "/icon.svg",
        tag: "n-1",
      },
    });
    const close = vi.fn();
    await sw.dispatch("notificationclick", {
      notification: { close, data: { url: "/northwind/inbox" } },
    });
    expect(close).toHaveBeenCalled();
    expect(sw.opened).toEqual([`${ORIGIN}/northwind/inbox`]);
  });

  it("focuses a window already on the page and never follows a link off the origin", async () => {
    const sw = worker(() => page(null));
    const focus = vi.fn(async () => undefined);
    sw.windows.push({ url: `${ORIGIN}/`, focus });
    await sw.dispatch("push", {
      data: { json: () => ({ body: "x", url: "//evil.example.test/" }) },
    });
    expect(sw.notifications[0]?.title).toBe("Atlas");
    expect(sw.notifications[0]?.options["data"]).toEqual({ url: "/" });
    await sw.dispatch("notificationclick", {
      notification: { close: () => undefined, data: sw.notifications[0]?.options["data"] },
    });
    expect(focus).toHaveBeenCalled();
    await sw.dispatch("push", {
      data: {
        json: () => {
          throw new SyntaxError("not JSON");
        },
      },
    });
    expect(sw.notifications[1]).toMatchObject({
      title: "Atlas",
      options: { body: "", data: { url: "/" } },
    });
  });
});

describe("the shared manifest pieces", () => {
  it("names a person's offline cache by a stable hash, never the id", async () => {
    const key = await offlineKey("01920000-0000-7000-8000-000000000101");
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(key).toBe(await offlineKey("01920000-0000-7000-8000-000000000101"));
    expect(key).not.toBe(await offlineKey("01920000-0000-7000-8000-000000000102"));
  });

  it("takes its colors from the tokens", () => {
    expect(tokenColor("bg-canvas", "dark")).toBe("#0E0F11");
    expect(manifestColors("light")).toEqual({
      background_color: "#FFFFFF",
      theme_color: "#FFFFFF",
    });
    expect(themeColors()).toHaveLength(2);
    expect(() => tokenColor("no-such-token", "dark")).toThrow();
  });
});
