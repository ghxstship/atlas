/**
 * Diagnostics a person may attach to a support request (Section 11.16): the page, the app version,
 * the browser and device, and the errors this visit raised. Nothing leaves the browser unless the
 * person ticks the consent box; record contents and query strings are never collected.
 */

const MAX_ERRORS = 10;
const MAX_ERROR_LENGTH = 300;
const recent: string[] = [];

/** Records uncaught errors and rejections of this visit, newest first. Returns the remover. */
export function installErrorCapture(target: Window): () => void {
  const push = (message: string) => {
    recent.unshift(`${new Date().toISOString()} ${message}`.slice(0, MAX_ERROR_LENGTH));
    recent.length = Math.min(recent.length, MAX_ERRORS);
  };
  const onError = (event: ErrorEvent) => push(event.message || "Script error");
  const onRejection = (event: PromiseRejectionEvent) =>
    push(event.reason instanceof Error ? event.reason.message : String(event.reason));
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}

export interface CollectedDiagnostics {
  readonly route: string;
  readonly appVersion: string | null;
  readonly device: string;
  readonly recentErrors: string | null;
}

/** The diagnostics of this visit, as they would be sent. */
export function collectDiagnostics(pathname: string, userAgent: string): CollectedDiagnostics {
  return {
    route: pathname.slice(0, 500),
    appVersion: process.env["NEXT_PUBLIC_APP_VERSION"] ?? null,
    device: userAgent.slice(0, 300),
    recentErrors: recent.length > 0 ? recent.join("\n").slice(0, 4000) : null,
  };
}
