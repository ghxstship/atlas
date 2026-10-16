"use client";

import { APPROVAL_DOCUMENT_TYPES, type ApprovalPolicy, type StateLabel } from "@xos/data/workflow";
import { Input, Select, Textarea } from "@xos/ui";
import { useState } from "react";
import {
  addStepAction,
  createPolicyAction,
  deletePolicyAction,
  removeStepAction,
  setStateLabelAction,
  transitionPolicyAction,
} from "@/lib/workflow/settings-actions";
import { ActionForm, useWorkflowT } from "./kit";

export interface ApproverChoice {
  readonly value: string;
  readonly label: string;
}

export function CreatePolicyForm({
  org,
  currencies,
}: {
  org: string;
  currencies: readonly { code: string; exponent: number }[];
}) {
  const t = useWorkflowT();
  const [type, setType] = useState<string>(APPROVAL_DOCUMENT_TYPES[0]);
  const [currency, setCurrency] = useState("");
  const exponent = currencies.find((c) => c.code === currency)?.exponent ?? 2;
  return (
    <ActionForm
      action={createPolicyAction}
      hidden={{ org, documentType: type, currency, exponent: String(exponent) }}
      label={t("policies.create.label")}
      submitLabel={t("policies.create.submit")}
      success={t("policies.create.done")}
    >
      <Input name="name" label={t("policies.fields.name")} maxLength={200} required width="100%" />
      <Select
        label={t("policies.fields.documentType")}
        value={type}
        options={APPROVAL_DOCUMENT_TYPES.map((d) => ({ value: d, label: t(`documentTypes.${d}`) }))}
        onChange={(e) => setType(e.target.value)}
      />
      <Textarea
        name="description"
        label={t("policies.fields.description")}
        maxLength={2000}
        rows={2}
        width="100%"
      />
      <div className="grid grid-cols-2 gap-8 max-md:grid-cols-1">
        <Select
          label={t("policies.fields.currency")}
          help={t("policies.fields.currencyHelp")}
          value={currency}
          options={[
            { value: "", label: t("policies.fields.everyAmount") },
            ...currencies.map((c) => ({ value: c.code, label: c.code })),
          ]}
          onChange={(e) => setCurrency(e.target.value)}
        />
        {currency ? (
          <Input
            name="threshold"
            type="number"
            min={0}
            step={1 / 10 ** exponent}
            label={t("policies.fields.threshold", { currency })}
            help={t("policies.fields.thresholdHelp")}
            required
            width="100%"
          />
        ) : null}
      </div>
    </ActionForm>
  );
}

export function AddStepForm({
  org,
  policyId,
  approvers,
}: {
  org: string;
  policyId: string;
  approvers: readonly ApproverChoice[];
}) {
  const t = useWorkflowT();
  const [approver, setApprover] = useState(approvers[0]?.value ?? "");
  return (
    <ActionForm
      action={addStepAction}
      hidden={{ org, policyId, approver }}
      label={t("policies.steps.addLabel")}
      submitLabel={t("policies.steps.add")}
      submitVariant="secondary"
      success={t("policies.steps.added")}
      inline
    >
      <Input name="name" label={t("policies.steps.name")} maxLength={200} required />
      <Select
        label={t("policies.steps.approver")}
        help={t("policies.steps.approverHelp")}
        value={approver}
        options={approvers.map((a) => ({ value: a.value, label: a.label }))}
        onChange={(e) => setApprover(e.target.value)}
      />
    </ActionForm>
  );
}

export function RemoveStepButton({ org, id, name }: { org: string; id: string; name: string }) {
  const t = useWorkflowT();
  return (
    <ActionForm
      action={removeStepAction}
      hidden={{ org, id }}
      label={t("policies.steps.removeNamed", { name })}
      submitLabel={t("policies.steps.remove")}
      submitVariant="ghost"
      inline
    />
  );
}

export function PolicyTransition({
  org,
  policy,
  to,
}: {
  org: string;
  policy: Pick<ApprovalPolicy, "id" | "state" | "name">;
  to: "Active" | "Retired";
}) {
  const t = useWorkflowT();
  return (
    <ActionForm
      action={transitionPolicyAction}
      hidden={{ org, id: policy.id, from: policy.state, to, reason: t(`policies.reasons.${to}`) }}
      label={t(`policies.transition.${to}Named`, { name: policy.name })}
      submitLabel={t(`policies.transition.${to}`)}
      submitVariant={to === "Active" ? "primary" : "secondary"}
      success={t(`policies.transition.${to}Done`)}
      inline
    />
  );
}

export function DeletePolicyButton({ org, id, name }: { org: string; id: string; name: string }) {
  const t = useWorkflowT();
  return (
    <ActionForm
      action={deletePolicyAction}
      hidden={{ org, id }}
      label={t("policies.delete.label", { name })}
      submitLabel={t("policies.delete.submit")}
      submitVariant="danger"
      inline
    />
  );
}

export function StateLabelRow({
  org,
  row,
  editable,
}: {
  org: string;
  row: StateLabel;
  editable: boolean;
}) {
  const t = useWorkflowT();
  return (
    <ActionForm
      action={setStateLabelAction}
      hidden={{ org, state: row.state, labelId: row.labelId ?? "" }}
      label={t("labels.rowLabel", { state: row.state })}
      submitLabel={t("labels.save")}
      submitVariant="secondary"
      success={t("labels.saved")}
      inline
    >
      <Input
        name="label"
        label={t("labels.labelFor", { state: row.state })}
        help={t("labels.help")}
        defaultValue={row.relabeled ? row.label : ""}
        placeholder={row.state}
        maxLength={40}
        disabled={!editable}
      />
    </ActionForm>
  );
}
