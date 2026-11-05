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

/** A workflow event a signal records (packages/data product-workflows.ts parseWorkflowSignal). */
export interface WorkflowSignalEvent {
  readonly workflow: string;
  readonly name: WorkflowEvent;
  readonly step?: number;
}

/**
 * Workflow funnel signals (A146): the app's registry, passed in so this module carries none. A signal is
 * `<workflow>:start`, `<workflow>:step<n>` or `<workflow>:done`, from a page view (`forRoute`), a `data-workflow`
 * attribute or a window event named `eventName`.
 */
export interface WorkflowSignals {
  readonly eventName: string;
  readonly parse: (signal: unknown) => WorkflowSignalEvent | null;
  readonly forRoute: (template: string) => readonly string[];
}

export interface ProductAnalyticsOptions {
  readonly endpoint: string;
  /** Turns a path into its route template, so no slug, key or token leaves the browser. */
  readonly template: (path: string) => string;
  /** Sends a batch; defaults to a keepalive POST. */
  readonly send?: (body: string) => void;
  readonly now?: () => Date;
  /** Records workflow funnel events from signals; without it only page views are recorded. */
  readonly workflows?: WorkflowSignals;
}

export interface ProductAnalytics {
  pageViewed(path: string): void;
  workflow(code: string, event: WorkflowEvent, step?: number): void;
  flush(): void;
  /** Sends what is queued and stops listening. */
  stop(): void;
}

const SESSION_KEY = "xos-analytics-session";
const STARTED_KEY = "xos-analytics-started";
// Elements that signal when activated; any other marked element (but a form) signals when it appears.
const INTERACTIVE =
  "a,button,input,select,textarea,summary,[role=button],[role=link],[role=menuitem],[role=option],[role=tab]";
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

/** Workflows this browser session started, so a step or completion counts only after its start. */
function startedWorkflows(): Set<string> {
  try {
    const stored = JSON.parse(window.sessionStorage.getItem(STARTED_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(stored) ? stored.filter((v) => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

function rememberStarted(started: Set<string>): void {
  try {
    window.sessionStorage.setItem(STARTED_KEY, JSON.stringify([...started]));
  } catch {
    // Storage blocked: the set lasts as long as the page.
  }
}

const NOOP: ProductAnalytics = {
  pageViewed: () => undefined,
  workflow: () => undefined,
  flush: () => undefined,
  stop: () => undefined,
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
  const listening = new AbortController();
  const { signal: until } = listening;
  window.addEventListener("pagehide", flush, { signal: until });
  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.visibilityState === "hidden") flush();
    },
    { signal: until },
  );
  let observer: MutationObserver | null = null;

  const workflows = options.workflows;
  const started = workflows ? startedWorkflows() : new Set<string>();
  // A signal the registry names becomes an event. A step or a completion counts only once the session started the
  // workflow, so a return visit to a finished packet or an empty queue is not a completion.
  const signal = (value: unknown) => {
    const event = workflows?.parse(value);
    if (!event) return;
    if (event.name === "Workflow Started") {
      started.add(event.workflow);
      rememberStarted(started);
    } else if (!started.has(event.workflow)) return;
    add({
      occurredAt: now().toISOString(),
      name: event.name,
      workflow: event.workflow,
      ...(event.step === undefined ? {} : { step: event.step }),
    });
  };
  if (workflows) {
    const seen = new WeakSet<Element>();
    const appeared = (root: ParentNode) => {
      const marked = [
        ...(root instanceof Element && root.matches("[data-workflow]") ? [root] : []),
        ...root.querySelectorAll("[data-workflow]"),
      ];
      for (const el of marked) {
        if (seen.has(el) || el.matches(INTERACTIVE) || el instanceof HTMLFormElement) continue;
        seen.add(el);
        signal(el.getAttribute("data-workflow"));
      }
    };
    window.addEventListener(workflows.eventName, (e) => signal((e as CustomEvent).detail), {
      signal: until,
    });
    document.addEventListener(
      "click",
      (e) => {
        const el = e.target instanceof Element ? e.target.closest("[data-workflow]") : null;
        if (el?.matches(INTERACTIVE)) signal(el.getAttribute("data-workflow"));
      },
      { capture: true, signal: until },
    );
    document.addEventListener(
      "submit",
      (e) => {
        if (e.target instanceof HTMLFormElement) signal(e.target.getAttribute("data-workflow"));
      },
      { capture: true, signal: until },
    );
    appeared(document);
    const watcher = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === "attributes" && r.target instanceof Element) appeared(r.target);
        for (const node of r.addedNodes) if (node instanceof Element) appeared(node);
      }
    });
    watcher.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-workflow"],
    });
    observer = watcher;
  }

  return {
    pageViewed(path) {
      const route = options.template(path);
      add({ occurredAt: now().toISOString(), name: "Page Viewed", route });
      for (const s of workflows?.forRoute(route) ?? []) signal(s);
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
    stop() {
      flush();
      listening.abort();
      observer?.disconnect();
    },
  };
}
