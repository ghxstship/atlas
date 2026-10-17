/**
 * Browser error reporter for Atlas and Gateway, in place of the Sentry browser SDK (about 30 KB
 * gzip), which the route JavaScript budgets of ADR 0027 cannot absorb.
 *
 * It listens for `error` and `unhandledrejection` on `window` and takes errors from the apps'
 * `error.tsx` boundaries, then posts a minimal payload to a same-origin route
 * (`/api/client-errors`), which validates, redacts and forwards it through the server Sentry
 * client. The payload carries the message, a stack cut to its frames, the route template, the
 * release and the person's id when the page knows it. Query strings, tokens, emails, form values
 * and the concrete path never leave the browser.
 *
 * This module is the only telemetry code in client bundles, so it imports nothing.
 */

export type ClientErrorSource = "window" | "promise" | "boundary";

export interface ClientErrorPayload {
  readonly message: string;
  readonly stack?: string;
  readonly route: string;
  readonly source: ClientErrorSource;
  readonly release?: string;
  readonly userId?: string;
}

export interface ClientReporterOptions {
  /** The same-origin ingest route. */
  readonly endpoint: string;
  /** Route templates with `[param]` segments, most specific first (`/[org]/p/[projectKey]`). */
  readonly routes: readonly string[];
  readonly release?: string | undefined;
  /** Reports sent per page load; later errors are dropped. Default 5. */
  readonly max?: number;
  /** Delivers one serialized payload. Defaults to `navigator.sendBeacon`. */
  readonly send?: (endpoint: string, body: string) => void;
}

/** Longest message and number of frames kept. */
export const MAX_MESSAGE = 300;
export const MAX_FRAMES = 15;

// Order matters: whole credentials before the shapes they contain. A colon ends a query string,
// so a stack frame keeps its `:line:column`.
const SCRUB: ReadonlyArray<readonly [RegExp, string]> = [
  [/\?[^\s)"'`:]*/g, ""],
  [/([\w/])#[^\s)"'`:]*/g, "$1"],
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]*/g, "[jwt]"],
  [/\b(?:Bearer|Basic)\s+\S+/gi, "[credential]"],
  [/[\w.%+-]+@[\w.-]+\.[a-z]{2,}/gi, "[email]"],
  [/[\w-]{32,}/g, "[redacted]"],
];
const DIGIT_RUN = /\+?\d[\d ().-]{7,}\d/g;

/** Strips query strings, fragments, credentials, emails and long tokens. */
export function scrubText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SCRUB) out = out.replace(pattern, replacement);
  return out;
}

/** Keeps only stack frame lines (V8 `at ...` and Firefox/Safari `fn@url:1:2`), scrubbed. */
export function trimStack(stack: string | undefined): string | undefined {
  if (!stack) return undefined;
  const lines = stack
    .split("\n")
    .filter((line) => /^\s*at\s/.test(line) || /@.*:\d+:\d+$/.test(line))
    .slice(0, MAX_FRAMES)
    .map((line) => scrubText(line.trim()));
  return lines.length > 0 ? lines.join("\n") : undefined;
}

/**
 * The route template for a path: the first template whose segments match (a `[param]` segment
 * matches any value) replaces the matched part, and any remaining segment that holds a digit
 * becomes `[id]`. `/acme/p/NWS/work?tab=2` with `/[org]/p/[projectKey]` gives
 * `/[org]/p/[projectKey]/work`.
 */
export function routeTemplate(pathname: string, routes: readonly string[]): string {
  const segments = (pathname.split(/[?#]/)[0] ?? "").split("/").filter(Boolean);
  for (const route of routes) {
    const parts = route.split("/").filter(Boolean);
    if (parts.length > segments.length) continue;
    if (parts.every((part, i) => part.startsWith("[") || part === segments[i])) {
      segments.splice(0, parts.length, ...parts);
      break;
    }
  }
  return `/${segments.map((s) => (s.startsWith("[") || !/\d/.test(s) ? s : "[id]")).join("/")}`;
}

interface ReporterState {
  readonly options: ClientReporterOptions;
  readonly seen: Set<string>;
  readonly uninstall: () => void;
  userId: string | undefined;
}

let state: ReporterState | undefined;

/** The person's id (a UUID) for later reports, or `undefined` once they sign out. */
export function setReporterUser(id: string | undefined): void {
  if (state) state.userId = id;
}

function messageOf(error: unknown): { message: string; stack: string | undefined } {
  if (error instanceof Error) {
    return { message: `${error.name}: ${error.message}`, stack: error.stack };
  }
  return {
    message: typeof error === "string" ? error : "Non-error value thrown",
    stack: undefined,
  };
}

/**
 * Reports one error. Errors from a server render carry a `digest` and were already reported on
 * the server by `onRequestError`, so they are skipped. Returns the payload sent, if any.
 */
export function reportClientError(
  error: unknown,
  source: ClientErrorSource = "boundary",
): ClientErrorPayload | undefined {
  if (!state || typeof window === "undefined") return undefined;
  if (typeof error === "object" && error !== null && "digest" in error && error.digest) {
    return undefined;
  }
  const { message: raw, stack } = messageOf(error);
  const message = scrubText(raw).replace(DIGIT_RUN, "[number]").slice(0, MAX_MESSAGE);
  const key = `${source}:${message}`;
  if (state.seen.has(key) || state.seen.size >= (state.options.max ?? 5)) return undefined;
  state.seen.add(key);
  const frames = trimStack(stack);
  const payload: ClientErrorPayload = {
    message,
    ...(frames ? { stack: frames } : {}),
    route: routeTemplate(window.location.pathname, state.options.routes),
    source,
    ...(state.options.release ? { release: state.options.release } : {}),
    ...(state.userId ? { userId: state.userId } : {}),
  };
  const send =
    state.options.send ??
    ((endpoint: string, body: string) =>
      navigator.sendBeacon?.(endpoint, new Blob([body], { type: "application/json" })));
  send(state.options.endpoint, JSON.stringify(payload));
  return payload;
}

/**
 * Installs the window listeners once per page and returns a function that removes them. Errors
 * raised by scripts from other origins (browser extensions, "Script error.") are ignored: they
 * carry nothing useful.
 */
export function installClientReporter(options: ClientReporterOptions): () => void {
  if (typeof window === "undefined") return () => undefined;
  if (state) return state.uninstall;
  const onError = (event: ErrorEvent) => {
    if (event.filename && !event.filename.startsWith(window.location.origin)) return;
    if (!event.error && (!event.message || event.message === "Script error.")) return;
    reportClientError(event.error ?? event.message, "window");
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    reportClientError(event.reason, "promise");
  };
  const uninstall = () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
    state = undefined;
  };
  state = { options, seen: new Set(), uninstall, userId: undefined };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return uninstall;
}
