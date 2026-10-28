/**
 * The service worker Atlas and Gateway serve at /sw.js (Section 4.10, A65-023, ADR 0052), as script source: each
 * app's app/sw.js/route.ts answers with serviceWorkerScript(...). It is plain JavaScript with no imports, so the route
 * budgets (ADR 0027) never count it, and it is registered only after hydration.
 *
 * What it caches, and what it never does:
 *   - Pages: a page loaded as a document is kept for offline reading only when the response names its signed-in
 *     person (the x-xos-offline-key header the proxy sets, a hash of the person's sign-in id). Pages live in a cache
 *     per person (xos-pages-<key>); a page of another person never lands in it, and the caches of everyone but the
 *     person last seen are deleted. At most 30 pages, the oldest dropped first.
 *   - Never: anything but a GET, any other origin, /auth, /api, token links (/advance, /sign, /ical, ?token=), React
 *     Server Component requests and every fetch the app makes itself. Server actions and API calls pass straight
 *     through, so no mutation and no API response is ever cached.
 *   - Build files under /_next/static are content-hashed and the same for everyone: cached on first use.
 *   - Sign-out (a POST to /auth/sign-out, or a "sign-out" message from the sign-in page) deletes every page cache
 *     and unsubscribes the browser from push, so the next person on the device sees nothing of the last.
 *   - Offline, a page navigation answers from the person's cache, else with the offline page precached at install.
 *   - Push: shows the notification the dispatcher sent (title, body, tag) and opens its path on this origin.
 */

export interface ServiceWorkerConfig {
  /** App name shown when a push carries no title. */
  // eslint-disable-next-line xos/no-restated-enums -- below @xos/data; test/database-enums.test.ts holds it equal
  readonly app: "Atlas" | "Gateway";
  /** Build release: a new value retires the previous build files' cache. */
  readonly version: string;
  /** Same-origin path of the offline page. */
  readonly offlinePath: string;
  /** Same-origin path of the notification icon. */
  readonly icon: string;
}

const SOURCE = String.raw`"use strict";
const STATIC = "xos-static-" + CONFIG.version;
const OFFLINE = "xos-offline";
const META = "xos-meta";
const PAGES = "xos-pages-";
const USER = "/__xos/offline-user";
const KEY_HEADER = "x-xos-offline-key";
const SAVED_AT = "x-xos-saved-at";
const MAX_PAGES = 30;
const MAX_STATIC = 400;
const FRESH_MS = 30 * 60 * 1000;
const NEVER = /^\/(auth|api|advance|sign|ical|\.well-known|__xos)(\/|$)|^\/(sw\.js|manifest\.webmanifest)$/;

function sameOrigin(url) {
  return url.origin === self.location.origin;
}

function keepable(url) {
  return sameOrigin(url) && !NEVER.test(url.pathname) && !url.searchParams.has("token") && !url.searchParams.has("_rsc");
}

function pageUrl(url) {
  const copy = new URL(url.href);
  copy.hash = "";
  return copy.href;
}

async function currentUser() {
  const meta = await caches.open(META);
  const hit = await meta.match(USER);
  return hit ? hit.text() : null;
}

async function setUser(key) {
  const meta = await caches.open(META);
  await meta.put(USER, new Response(key));
  const names = await caches.keys();
  await Promise.all(names.filter((n) => n.startsWith(PAGES) && n !== PAGES + key).map((n) => caches.delete(n)));
}

async function forget() {
  const names = await caches.keys();
  await Promise.all(names.filter((n) => n.startsWith(PAGES) || n === META).map((n) => caches.delete(n)));
  try {
    const subscription = await self.registration.pushManager.getSubscription();
    if (subscription) await subscription.unsubscribe();
  } catch (error) {
    // Push may be unavailable; the caches are gone either way.
  }
}

async function save(url, response) {
  const key = response.headers.get(KEY_HEADER);
  const type = response.headers.get("content-type") || "";
  if (!key || !/^[0-9a-f]{32}$/.test(key) || response.status !== 200 || response.redirected || !type.includes("text/html")) {
    return false;
  }
  if ((await currentUser()) !== key) await setUser(key);
  const headers = new Headers(response.headers);
  headers.set(SAVED_AT, String(Date.now()));
  const body = await response.blob();
  const cache = await caches.open(PAGES + key);
  await cache.put(pageUrl(url), new Response(body, { status: 200, statusText: response.statusText, headers }));
  const keys = await cache.keys();
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_PAGES))) await cache.delete(old);
  return true;
}

async function offlinePage(url) {
  const user = await currentUser();
  if (user) {
    const hit = await (await caches.open(PAGES + user)).match(pageUrl(url), { ignoreVary: true });
    if (hit) return hit;
  }
  const page = await (await caches.open(OFFLINE)).match(CONFIG.offlinePath, { ignoreVary: true });
  return page || Response.error();
}

async function refreshOffline() {
  try {
    const response = await fetch(CONFIG.offlinePath, { credentials: "same-origin", cache: "no-store" });
    if (response.status === 200) await (await caches.open(OFFLINE)).put(CONFIG.offlinePath, response);
  } catch (error) {
    // Offline at install: the next install or refresh tries again.
  }
}

async function buildFile(request) {
  const cache = await caches.open(STATIC);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.status === 200) {
    await cache.put(request, response.clone());
    const keys = await cache.keys();
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_STATIC))) await cache.delete(old);
  }
  return response;
}

async function remember(href) {
  const url = new URL(href, self.location.origin);
  if (!keepable(url)) return false;
  const user = await currentUser();
  if (user) {
    const hit = await (await caches.open(PAGES + user)).match(pageUrl(url));
    if (hit && Date.now() - Number(hit.headers.get(SAVED_AT)) < FRESH_MS) return false;
  }
  try {
    const response = await fetch(url.href, { credentials: "same-origin", headers: { Accept: "text/html" } });
    return await save(url, response);
  } catch (error) {
    return false;
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(refreshOffline().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n.startsWith("xos-static-") && n !== STATIC).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (!sameOrigin(url)) return;
  if (request.method !== "GET") {
    if (request.method === "POST" && url.pathname === "/auth/sign-out") event.waitUntil(forget());
    return;
  }
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(buildFile(request));
    return;
  }
  if (request.mode !== "navigate" || !keepable(url)) return;
  event.respondWith(
    (async () => {
      try {
        const response = await fetch(request);
        event.waitUntil(save(url, response.clone()).catch(() => false));
        return response;
      } catch (error) {
        return offlinePage(url);
      }
    })(),
  );
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "remember" && typeof data.url === "string") event.waitUntil(remember(data.url));
  else if (data.type === "sign-out") event.waitUntil(forget());
  else if (data.type === "refresh-offline") event.waitUntil(refreshOffline());
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (error) {
    data = {};
  }
  const path = typeof data.url === "string" && data.url.startsWith("/") && !data.url.startsWith("//") ? data.url : "/";
  const options = { body: typeof data.body === "string" ? data.body : "", data: { url: path }, icon: CONFIG.icon };
  if (typeof data.tag === "string") options.tag = data.tag;
  event.waitUntil(self.registration.showNotification(typeof data.title === "string" ? data.title : CONFIG.app, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const target = new URL(typeof data.url === "string" ? data.url : "/", self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if (client.url === target && "focus" in client) return client.focus();
      }
      return self.clients.openWindow(target);
    })(),
  );
});
`;

/** The service worker's source for one app. */
export function serviceWorkerScript(config: ServiceWorkerConfig): string {
  return `// XOS service worker for ${config.app} (A96, ADR 0052). Generated by @xos/ui/pwa; never cached by itself.\nconst CONFIG = ${JSON.stringify(config)};\n${SOURCE}`;
}
