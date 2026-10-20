/**
 * The browser errors of this visit, newest first, which a person may attach to a support request
 * with their consent (Section 11.16). Only the message and the time are kept, never record contents,
 * and nothing leaves the browser unless the person sends it.
 */

const MAX_ERRORS = 10;
const MAX_LENGTH = 300;
const recent: string[] = [];

/** Records uncaught errors and rejections from now on. Returns the remover. */
export function installRecentErrors(target: Window): () => void {
  const push = (message: string) => {
    recent.unshift(`${new Date().toISOString()} ${message}`.slice(0, MAX_LENGTH));
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

/** The recorded errors as sent with a request, or null when this visit raised none. */
export function recentErrors(): string | null {
  return recent.length > 0 ? recent.join("\n").slice(0, 4000) : null;
}
