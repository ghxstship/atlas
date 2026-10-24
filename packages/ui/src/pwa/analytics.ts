/**
 * The browser side of consent-gated product analytics (Section 11.14, A96, ADR 0052). Apps load this module only
 * when their consent seam said yes, and it stops itself when the browser sends Global Privacy Control. Events carry
 * a route template (never the path), a workflow and a step, keyed to a random session key kept in sessionStorage,
 * and go to the app's own /api/product-events in small batches. Nothing goes to another origin.
 */

export type WorkflowEvent = "Workflow Started" | "Workflow Step" | "Workflow Completed";

interface QueuedEvent {
  readonly occurredAt: string;
  readonly name: "Page Viewed" | WorkflowEvent;
  readonly route?: string;
  readonly workflow?: string;
  readonly step?: number;
}

export interface ProductAnalyticsOptions {
  readonly endpoint: string;
  /** Turns a path into its route template, so no slug, key or token leaves the browser. */
  readonly template: (path: string) => string;
  /** Sends a batch; defaults to a keepalive POST. */
  readonly send?: (body: string) => void;
  readonly now?: () => Date;
}

export interface ProductAnalytics {
  pageViewed(path: string): void;
  workflow(code: string, event: WorkflowEvent, step?: number): void;
  flush(): void;
}

const SESSION_KEY = "xos-analytics-session";
const BATCH = 10;
const FLUSH_MS = 5000;

function sessionKey(): string {
  try {
    const stored = window.sessionStorage.getItem(SESSION_KEY);
    if (stored) return stored;
    const fresh = crypto.randomUUID();
    window.sessionStorage.setItem(SESSION_KEY, fresh);
    return fresh;
  } catch {
    return crypto.randomUUID();
  }
}

/** True when the browser sends Global Privacy Control, which turns analytics off whatever was chosen. */
export function globalPrivacyControl(): boolean {
  return (
    (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true
  );
}

const NOOP: ProductAnalytics = {
  pageViewed: () => undefined,
  workflow: () => undefined,
  flush: () => undefined,
};

export function productAnalytics(options: ProductAnalyticsOptions): ProductAnalytics {
  if (globalPrivacyControl()) return NOOP;
  const key = sessionKey();
  const now = options.now ?? (() => new Date());
  const send =
    options.send ??
    ((body: string) => {
      void fetch(options.endpoint, {
        method: "POST",
        keepalive: true,
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body,
      }).catch(() => undefined);
    });
  let queue: QueuedEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (queue.length === 0) return;
    const events = queue.slice(0, 25);
    queue = queue.slice(25);
    send(JSON.stringify({ sessionKey: key, events }));
  };
  const add = (event: QueuedEvent) => {
    queue.push(event);
    if (queue.length >= BATCH) flush();
    else timer ??= setTimeout(flush, FLUSH_MS);
  };
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });

  return {
    pageViewed(path) {
      add({ occurredAt: now().toISOString(), name: "Page Viewed", route: options.template(path) });
    },
    workflow(code, event, step) {
      add({
        occurredAt: now().toISOString(),
        name: event,
        workflow: code,
        ...(step === undefined ? {} : { step }),
      });
    },
    flush,
  };
}
