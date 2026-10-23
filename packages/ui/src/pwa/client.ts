/**
 * Browser side of the installable apps (Section 4.10, A65-023, ADR 0052): registering the service worker after the
 * page hydrates, asking it to keep a page for offline reading, clearing it on sign-out, and the browser's push
 * subscription. No React and no imports, so it adds a few hundred bytes to a route.
 */

const SW_PATH = "/sw.js";
const REMEMBER_GAP_MS = 10_000;
let lastRemembered = 0;

/** True when the browser can run the service worker. */
export function serviceWorkerSupported(): boolean {
  return typeof navigator !== "undefined" && "serviceWorker" in navigator;
}

/** Runs `task` once the page has loaded and the browser is idle, so registration never competes with hydration. */
export function afterHydration(task: () => void): void {
  const idle = () => {
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
    };
    if (typeof w.requestIdleCallback === "function") w.requestIdleCallback(task, { timeout: 5000 });
    else window.setTimeout(task, 1500);
  };
  if (document.readyState === "complete") idle();
  else window.addEventListener("load", idle, { once: true });
}

/** Registers /sw.js for the whole origin; null where it cannot run or registration fails. */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!serviceWorkerSupported()) return null;
  try {
    return await navigator.serviceWorker.register(SW_PATH, { scope: "/" });
  } catch {
    return null;
  }
}

function post(message: Record<string, unknown>): void {
  if (!serviceWorkerSupported()) return;
  const controller = navigator.serviceWorker.controller;
  if (controller) controller.postMessage(message);
  else void navigator.serviceWorker.ready.then((r) => r.active?.postMessage(message));
}

/**
 * Asks the service worker to keep the page at `path` for offline reading: a page reached by client-side navigation
 * never passes through it as a document. At most one request every 10 seconds; the worker skips a page it saved in
 * the last 30 minutes.
 */
export function rememberPage(path: string, now = Date.now()): boolean {
  if (now - lastRemembered < REMEMBER_GAP_MS) return false;
  lastRemembered = now;
  post({ type: "remember", url: path });
  return true;
}

/** Tells the service worker the person signed out: it deletes every saved page and unsubscribes from push. */
export function forgetOfflinePages(): void {
  post({ type: "sign-out" });
}

// Push ------------------------------------------------------------------------------------------------------------

/** True when this browser can subscribe to Web Push. */
export function pushSupported(): boolean {
  return (
    serviceWorkerSupported() &&
    typeof window !== "undefined" &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** The VAPID public key, base64url, as the bytes PushManager.subscribe takes. */
export function applicationServerKey(base64Url: string): Uint8Array<ArrayBuffer> {
  const padded =
    base64Url.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((base64Url.length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** The browser's current push subscription, or null. */
export async function currentPushSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration("/");
  return registration ? registration.pushManager.getSubscription() : null;
}

/** Asks for permission and subscribes; returns the subscription as JSON, or the reason it did not. */
export async function subscribeToPush(
  vapidPublicKey: string,
): Promise<
  | { readonly ok: true; readonly subscription: PushSubscriptionJSON }
  | { readonly ok: false; readonly reason: "unsupported" | "blocked" | "failed" }
> {
  if (!pushSupported()) return { ok: false, reason: "unsupported" };
  const permission =
    Notification.permission === "default"
      ? await Notification.requestPermission()
      : Notification.permission;
  if (permission !== "granted") return { ok: false, reason: "blocked" };
  try {
    const registration = (await registerServiceWorker()) ?? (await navigator.serviceWorker.ready);
    const subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey(vapidPublicKey),
      }));
    return { ok: true, subscription: subscription.toJSON() };
  } catch {
    return { ok: false, reason: "failed" };
  }
}

/** Unsubscribes this browser; returns the endpoint it had, or null. */
export async function unsubscribeFromPush(): Promise<string | null> {
  const subscription = await currentPushSubscription();
  if (!subscription) return null;
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  return endpoint;
}
