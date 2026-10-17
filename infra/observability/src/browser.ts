/**
 * Browser error reporter for Atlas and Gateway, in place of the Sentry browser SDK (about 30 KB
 * gzip), which the route JavaScript budgets of ADR 0027 cannot absorb. About 1 KB gzip.
 *
 * It listens for `error` and `unhandledrejection` on `window` and takes errors from the apps'
 * `error.tsx` boundaries, then posts a minimal payload with `navigator.sendBeacon` to a
 * same-origin route (`/api/client-errors`), which validates, redacts and forwards it through the
 * server Sentry client. The payload carries the message, a stack cut to its frames, the route
 * template, the release and the person's id when the page knows it. Query strings, fragments,
 * tokens, emails, form values and the concrete path never leave the browser. At most five
 * distinct reports leave per page load.
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
}

/** Reports sent per page load, longest message and number of stack frames kept. */
export const MAX_REPORTS = 5;
export const MAX_MESSAGE = 300;
export const MAX_FRAMES = 15;

// Order matters: whole credentials before the shapes they contain. A colon ends a query string
// or fragment, so a stack frame keeps its `:line:column`.
const SCRUB: ReadonlyArray<readonly [RegExp, string]> = [
  [/[?#][^\s)"'`:]*/g, ""],
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]*/g, "[jwt]"],
  [/\b(?:Bearer|Basic)\s+\S+/gi, "[credential]"],
  [/[\w.%+-]+@[\w.-]+\.[a-z]{2,}/gi, "[email]"],
  [/[\w-]{32,}/g, "[redacted]"],
];

/** Strips query strings, fragments, credentials, emails and long tokens. */
export function scrubText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SCRUB) out = out.replace(pattern, replacement);
  return out;
}

/** Keeps only stack frame lines (V8 `at ...` and Firefox/Safari `fn@url:1:2`), scrubbed. */
export function trimStack(stack: string | undefined): string | undefined {
  const lines = (stack ?? "")
    .split("\n")
    .filter((line) => /^\s*at\s|@.*:\d+:\d+$/.test(line))
    .slice(0, MAX_FRAMES)
    .map((line) => scrubText(line.trim()));
  return lines.length > 0 ? lines.join("\n") : undefined;
}

/**
 * The route template for a path: the first template whose segments match (a `[param]` segment
 * matches any value) replaces the matched part, and any remaining segment that holds a digit
 * becomes `[id]`. `/acme/p/NWS/work` with `/[org]/p/[projectKey]` gives
 * `/[org]/p/[projectKey]/work`.
 */
export function routeTemplate(pathname: string, routes: readonly string[]): string {
  const segments = pathname.split("/").filter(Boolean);
  for (const route of routes) {
    const parts = route.split("/").filter(Boolean);
    if (
      parts.length <= segments.length &&
      parts.every((p, i) => p[0] === "[" || p === segments[i])
    ) {
      segments.splice(0, parts.length, ...parts);
      break;
    }
  }
  return `/${segments.map((s) => (s[0] === "[" || !/\d/.test(s) ? s : "[id]")).join("/")}`;
}

let options: ClientReporterOptions | undefined;
let userId: string | undefined;
const seen = new Set<string>();

/** The person's id (a UUID) for later reports, or `undefined` once they sign out. */
export function setReporterUser(id: string | undefined): void {
  userId = id;
}

/**
 * Reports one error. Errors from a server render carry a `digest` and were already reported on
 * the server by `onRequestError`, so they are skipped. Returns the payload sent, if any.
 */
export function reportClientError(
  error: unknown,
  source: ClientErrorSource = "boundary",
): ClientErrorPayload | undefined {
  if (!options || (error as { digest?: string } | null)?.digest) return undefined;
  const raw =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : typeof error === "string"
        ? error
        : "Non-error value thrown";
  const message = scrubText(raw)
    .replace(/\+?\d[\d ().-]{7,}\d/g, "[number]")
    .slice(0, MAX_MESSAGE);
  const key = source + message;
  if (seen.has(key) || seen.size >= MAX_REPORTS) return undefined;
  seen.add(key);
  const stack = trimStack((error as Error | null)?.stack);
  const payload: ClientErrorPayload = {
    message,
    ...(stack ? { stack } : {}),
    route: routeTemplate(location.pathname, options.routes),
    source,
    ...(options.release ? { release: options.release } : {}),
    ...(userId ? { userId } : {}),
  };
  navigator.sendBeacon?.(
    options.endpoint,
    new Blob([JSON.stringify(payload)], { type: "application/json" }),
  );
  return payload;
}

/**
 * Installs the window listeners, once per page. Errors raised by scripts from other origins
 * (browser extensions, "Script error.") are ignored: they carry nothing useful.
 */
export function installClientReporter(reporter: ClientReporterOptions): void {
  if (options) return;
  options = reporter;
  addEventListener("error", (event) => {
    if (event.filename && !event.filename.startsWith(location.origin)) return;
    if (event.error || (event.message && event.message !== "Script error.")) {
      reportClientError(event.error ?? event.message, "window");
    }
  });
  addEventListener("unhandledrejection", (event) => {
    reportClientError(event.reason, "promise");
  });
}
