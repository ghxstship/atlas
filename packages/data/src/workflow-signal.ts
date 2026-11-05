import type { WorkflowSignal } from "./product-workflows.ts";

/**
 * Workflow funnel signals from pages (A146, ADR 0052). Deliberately tiny and free of the registry, so a page pays a few
 * bytes for them: the browser module that turns a signal into an event (packages/ui pwa/analytics.ts with
 * product-workflows.ts) loads only when the person consented to analytics, and without it a signal reaches nothing.
 * Signals carry a workflow and a step, never a record, a person or free text.
 */

/** The window event emitWorkflow dispatches and the analytics module listens for. */
export const WORKFLOW_SIGNAL_EVENT = "xos:workflow";

/**
 * Signals a workflow event from client code, for example once a server action succeeded: from the form's result
 * (useActionOutcome in @xos/ui/pwa/action-outcome, or a success effect), never by wrapping the action, which would stop
 * the form posting without JavaScript (ADR 0001).
 */
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
