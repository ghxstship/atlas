import type { DataError } from "@xos/data";

/**
 * Outcomes of A33's server actions (approvals, Trash, templates, state labels and the report
 * builder). Forms show catalog copy under `workflow.refusals` and `workflow.errors`, never a raw
 * database message, so every outcome reads in en-US and es-US.
 */
export interface WorkflowActionState {
  readonly ok?: boolean;
  /** Id of the row the action created or changed. */
  readonly id?: string;
  /** The refusal rule the database named. */
  readonly rule?: string;
  readonly error?: "input" | "notFound" | "conflict" | "invalid" | "unexpected";
  /** Distinguishes two identical outcomes in a row, so a form shows the second one too. */
  readonly at?: number;
}

export const INITIAL_STATE: WorkflowActionState = {};

export function fromDataError(error: DataError): WorkflowActionState {
  const at = Date.now();
  switch (error.kind) {
    case "refusal":
      return { rule: error.rule, at };
    case "not-found":
      return { error: "notFound", at };
    case "conflict":
      return { error: "conflict", at };
    case "invalid":
      return { error: "invalid", at };
    case "unexpected":
      console.error("workflow action failed", error);
      return { error: "unexpected", at };
  }
}
