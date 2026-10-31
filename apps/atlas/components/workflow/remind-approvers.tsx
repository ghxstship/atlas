"use client";

import { Button } from "@xos/ui";
import { remindApproversAction } from "@/app/[org]/approvals/actions";
import { ActionForm, useWorkflowT } from "./kit";

/**
 * Remind approvers (P9, G-261): the requester's nudge to the approvers of the step an approval waits
 * on. Until the next allowed time (4 hours after they were last notified) the button is disabled and
 * says when it opens; once every reminder of the org's limit is sent it says so. The database checks
 * both again, and a refusal shows its rule. Loaded on demand, so Approvals carries it only for a
 * requester with something pending.
 */
export function RemindApprovers({
  org,
  subjectTable,
  subjectId,
  allowed,
  nextAllowed,
}: {
  org: string;
  subjectTable: "approval_instances" | "timesheets" | "subject_approvals";
  subjectId: string;
  /** False until the next allowed time, and once the limit is reached. */
  allowed: boolean;
  /** When it may next be pressed, already formatted; null once the limit is reached. */
  nextAllowed: string | null;
}) {
  const t = useWorkflowT();
  if (!allowed) {
    return (
      <div className="flex flex-wrap items-center gap-8">
        <Button variant="secondary" disabled>
          {t("approvals.remind.button")}
        </Button>
        <span className="text-text-12 text-text-secondary">
          {nextAllowed
            ? t("approvals.remind.nextAllowed", { when: nextAllowed })
            : t("approvals.remind.limitReached")}
        </span>
      </div>
    );
  }
  return (
    <ActionForm
      action={remindApproversAction}
      hidden={{ org, subjectTable, subjectId }}
      label={t("approvals.remind.label")}
      submitLabel={t("approvals.remind.button")}
      submitVariant="secondary"
      success={t("approvals.remind.done")}
      announce
      inline
    />
  );
}
