import type { WorkflowSignal } from "./product-workflows.ts";

/**
 * Workflow funnel signals from pages (A146, ADR 0052). Deliberately tiny and free of the registry, so a page pays a few
 * bytes for them: the browser module that turns a signal into an event (packages/ui pwa/analytics.ts with
 * product-workflows.ts) loads only when the person consented to analytics, and without it a signal reaches nothing.
 * Signals carry a workflow and a step, never a record, a person or free text.
 */

/** The window event emitWorkflow dispatches and the analytics module listens for. */
export const WORKFLOW_SIGNAL_EVENT = "xos:workflow";

/** Signals a workflow event from client code, for example once a server action succeeded. */
export function emitWorkflow(signal: WorkflowSignal): void {
  (globalThis as unknown as EventTarget).dispatchEvent(
    new CustomEvent(WORKFLOW_SIGNAL_EVENT, { detail: signal }),
  );
}

/**
 * The attribute that signals from markup: on a link, button or form when it is clicked or submitted, on any other
 * element (a hidden span, a success notice) when it appears. Spread it onto the element.
 */
export function workflowMarker(signal: WorkflowSignal): {
  readonly "data-workflow": WorkflowSignal;
} {
  return { "data-workflow": signal };
}

/**
 * Wraps a server action so a result that `succeeded` signals, in the browser, after it returns. For forms whose row
 * can leave the page with the result, where an effect of the form would never run.
 */
export function signalOnSuccess<S, P>(
  action: (state: S, payload: P) => Promise<S>,
  signal: WorkflowSignal,
  succeeded: (state: S) => boolean,
): (state: S, payload: P) => Promise<S> {
  return async (state, payload) => {
    const next = await action(state, payload);
    if (succeeded(next)) emitWorkflow(signal);
    return next;
  };
}
