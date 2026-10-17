"use client";

import { Button, Select, Textarea } from "@xos/ui";
import { useId, useState } from "react";
import {
  cancelApprovalAction,
  decideApprovalAction,
  requestApprovalAction,
} from "@/app/[org]/approvals/actions";
import { ActionForm, useWorkflowT } from "./kit";

/** Approve, or reject with a reason, the step an approval waits on. */
export function DecisionForm({ org, id }: { org: string; id: string }) {
  const t = useWorkflowT();
  const fieldId = useId();
  const [decision, setDecision] = useState<"approve" | "reject">("approve");
  return (
    <ActionForm
      action={decideApprovalAction}
      hidden={{ org, id, decision }}
      label={t("approvals.decide.label")}
      submitLabel={
        decision === "approve" ? t("approvals.decide.approve") : t("approvals.decide.reject")
      }
      submitVariant={decision === "approve" ? "primary" : "danger"}
      success={t("approvals.decide.done")}
      announce
    >
      <fieldset className="m-0 flex flex-wrap gap-12 border-0 p-0">
        <legend className="mb-4 text-text-13 font-medium">{t("approvals.decide.legend")}</legend>
        {(["approve", "reject"] as const).map((value) => (
          <label key={value} className="flex items-center gap-6 text-text-13">
            <input
              type="radio"
              name={`${fieldId}-decision`}
              value={value}
              checked={decision === value}
              onChange={() => setDecision(value)}
            />
            {t(`approvals.decide.${value}Option`)}
          </label>
        ))}
      </fieldset>
      <Textarea
        id={`${fieldId}-comment`}
        name="comment"
        label={
          decision === "reject"
            ? t("approvals.decide.reasonRequired")
            : t("approvals.decide.comment")
        }
        help={
          decision === "reject"
            ? t("approvals.decide.reasonHelp")
            : t("approvals.decide.commentHelp")
        }
        maxLength={2000}
        rows={3}
        width="100%"
        required={decision === "reject"}
      />
    </ActionForm>
  );
}

/** Withdraw an approval in review, or an approved one the document has not used. */
export function CancelForm({ org, id }: { org: string; id: string }) {
  const t = useWorkflowT();
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <Button variant="ghost" onClick={() => setOpen(true)}>
        {t("approvals.cancel.open")}
      </Button>
    );
  }
  return (
    <ActionForm
      action={cancelApprovalAction}
      hidden={{ org, id }}
      label={t("approvals.cancel.label")}
      submitLabel={t("approvals.cancel.submit")}
      submitVariant="danger"
      success={t("approvals.cancel.done")}
      announce
      onDone={() => setOpen(false)}
    >
      <Textarea
        name="reason"
        label={t("approvals.cancel.reason")}
        help={t("approvals.cancel.reasonHelp")}
        maxLength={500}
        rows={2}
        width="100%"
        required
      />
    </ActionForm>
  );
}

export interface DocumentOption {
  readonly value: string;
  readonly label: string;
}

/** Submit a spend document an Active policy gates. */
export function SubmitForm({
  org,
  documents,
}: {
  org: string;
  documents: readonly DocumentOption[];
}) {
  const t = useWorkflowT();
  const [value, setValue] = useState(documents[0]?.value ?? "");
  return (
    <ActionForm
      action={requestApprovalAction}
      hidden={{ org, document: value }}
      label={t("approvals.submit.label")}
      submitLabel={t("approvals.submit.submit")}
      success={t("approvals.submit.done")}
      inline
    >
      <Select
        label={t("approvals.submit.document")}
        help={t("approvals.submit.documentHelp")}
        value={value}
        options={documents.map((d) => ({ value: d.value, label: d.label }))}
        onChange={(e) => setValue(e.target.value)}
      />
    </ActionForm>
  );
}
