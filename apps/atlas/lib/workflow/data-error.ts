import type { DataError } from "@xos/data";
import { observability } from "@/lib/observability";
import type { WorkflowActionState } from "./state";

/**
 * The form outcome for a data error from one of A33's server actions. An unexpected error goes to the
 * redacting logger (A69-014). Server only: forms import their state from ./state, which carries no
 * server code into the browser.
 */
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
      observability.logger.error("workflow action failed", { error: error });
      return { error: "unexpected", at };
  }
}
