"use client";

import { InlineAlert, RefusalNotice } from "@xos/ui";
import { type ActionState } from "@/app/[org]/finance/actions";
import { useFinanceT } from "./kit-use-finance-t";

// Feedback -------------------------------------------------------------------------------------------

/**
 * Turns an action result into copy: a refusal names its rule from `finance.refusals` (falling back to
 * the rule code itself when the catalog has no sentence for it), a pending approval says a second
 * approver is needed, and other failures say what to do next.
 */
export function ActionFeedback({ state, success }: { state: ActionState; success?: string }) {
  const t = useFinanceT();
  if (state.error) {
    const error = state.error;
    if (error.kind === "refusal") {
      const key = `refusals.${error.rule}`;
      return (
        <RefusalNotice
          outcome="REFUSE"
          title={t("common.refusedTitle")}
          reason={t.has(key) ? t(key) : t("refusals.unknown", { rule: error.rule })}
        />
      );
    }
    if (error.kind === "input") return null;
    return <InlineAlert tone="danger">{t(`errors.${error.kind}`)}</InlineAlert>;
  }
  if (state.pending) {
    return (
      <p role="status" className="m-0 text-text-13 text-warning-text">
        {t("common.approvalPending")}
      </p>
    );
  }
  if (state.ok && success) {
    return (
      <p role="status" className="m-0 text-text-13 text-success-text">
        {success}
      </p>
    );
  }
  return null;
}
