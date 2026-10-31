"use client";

import { APPROVAL_RULE_SUBJECTS, type ApprovalRuleSubject } from "@xos/data/workflow";
import { Input, Select, Switch, Textarea } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { ActionForm } from "@/components/workflow/kit";
import {
  addApprovalRuleStepAction,
  createApprovalRuleAction,
  deleteApprovalRuleAction,
  removeApprovalRuleStepAction,
  transitionApprovalRuleAction,
} from "./approval-rule-actions";

/**
 * The approval rule editor of Project Settings (P9, migration 2860), loaded on demand: a new rule
 * (its subject, an optional filter of that subject, a name), a step added to a Draft rule (a role, a
 * member or an engagement of the project, and for an engagement whether its approver decides from
 * email without signing in), and Activate, Retire, Remove and Delete. The database decides every
 * rule; a refusal shows its rule through workflow.refusals.
 */

export interface Choice {
  readonly value: string;
  readonly label: string;
}

/** Filters a rule may use, by subject: credential categories, dock zones and asset classes. */
export type FilterChoices = Readonly<Record<ApprovalRuleSubject, readonly Choice[]>>;

interface Scope {
  readonly org: string;
  readonly projectId: string;
  readonly projectKey: string;
}

type Translate = (key: string, values?: Record<string, string | number>) => string;

function useRulesT(): Translate {
  return useTranslations("projects.settings.approvalRules") as unknown as Translate;
}

export function NewApprovalRuleForm({ scope, filters }: { scope: Scope; filters: FilterChoices }) {
  const t = useRulesT();
  const [subject, setSubject] = useState<ApprovalRuleSubject>("Pass");
  const [filterId, setFilterId] = useState("");
  return (
    <ActionForm
      action={createApprovalRuleAction}
      hidden={{
        org: scope.org,
        projectId: scope.projectId,
        projectKey: scope.projectKey,
        subject,
        filterId,
      }}
      label={t("create.label")}
      submitLabel={t("create.submit")}
      success={t("create.done")}
    >
      <div className="grid grid-cols-2 gap-8 max-md:grid-cols-1">
        <Select
          label={t("fields.subject")}
          help={t("fields.subjectHelp")}
          value={subject}
          options={APPROVAL_RULE_SUBJECTS.map((s) => ({ value: s, label: t(`subjects.${s}`) }))}
          onChange={(e) => {
            setSubject(e.target.value as ApprovalRuleSubject);
            setFilterId("");
          }}
        />
        <Select
          label={t(`fields.filter.${subject}`)}
          help={t("fields.filterHelp")}
          value={filterId}
          options={[{ value: "", label: t(`fields.every.${subject}`) }, ...filters[subject]]}
          onChange={(e) => setFilterId(e.target.value)}
        />
      </div>
      <Input name="name" label={t("fields.name")} maxLength={200} required width="100%" />
      <Textarea
        name="description"
        label={t("fields.description")}
        maxLength={2000}
        rows={2}
        width="100%"
      />
    </ActionForm>
  );
}

export function AddApprovalRuleStepForm({
  scope,
  ruleId,
  approvers,
}: {
  scope: Scope;
  ruleId: string;
  /** Roles, members and engagements, as role:<id>, member:<id> and engagement:<id>. */
  approvers: readonly Choice[];
}) {
  const t = useRulesT();
  const [approver, setApprover] = useState(approvers[0]?.value ?? "");
  const helpId = useId();
  const engagement = approver.startsWith("engagement:");
  return (
    <ActionForm
      action={addApprovalRuleStepAction}
      hidden={{ org: scope.org, projectKey: scope.projectKey, ruleId, approver }}
      label={t("steps.addLabel")}
      submitLabel={t("steps.add")}
      submitVariant="secondary"
      success={t("steps.added")}
    >
      <div className="grid grid-cols-2 gap-8 max-md:grid-cols-1">
        <Input name="name" label={t("steps.name")} maxLength={200} required width="100%" />
        <Select
          label={t("steps.approver")}
          help={t("steps.approverHelp")}
          value={approver}
          options={approvers.map((a) => ({ value: a.value, label: a.label }))}
          onChange={(e) => setApprover(e.target.value)}
        />
      </div>
      {engagement ? (
        <div className="flex flex-col gap-4">
          <Switch name="signedOutLinks" label={t("steps.signedOut")} aria-describedby={helpId} />
          <p id={helpId} className="m-0 text-text-12 text-text-secondary">
            {t("steps.signedOutHelp")}
          </p>
        </div>
      ) : null}
    </ActionForm>
  );
}

export function RemoveApprovalRuleStep({
  scope,
  id,
  name,
}: {
  scope: Scope;
  id: string;
  name: string;
}) {
  const t = useRulesT();
  return (
    <ActionForm
      action={removeApprovalRuleStepAction}
      hidden={{ org: scope.org, projectKey: scope.projectKey, id }}
      label={t("steps.removeNamed", { name })}
      submitLabel={t("steps.remove")}
      submitVariant="ghost"
      inline
    />
  );
}

export function ApprovalRuleTransition({
  scope,
  rule,
  to,
}: {
  scope: Scope;
  rule: { readonly id: string; readonly name: string; readonly state: string };
  to: "Active" | "Retired";
}) {
  const t = useRulesT();
  return (
    <ActionForm
      action={transitionApprovalRuleAction}
      hidden={{
        org: scope.org,
        projectKey: scope.projectKey,
        id: rule.id,
        from: rule.state,
        to,
        reason: t(`transition.reasons.${to}`),
      }}
      label={t(`transition.${to}Named`, { name: rule.name })}
      submitLabel={t(`transition.${to}`)}
      submitVariant={to === "Active" ? "primary" : "secondary"}
      success={t(`transition.${to}Done`)}
      inline
    />
  );
}

export function DeleteApprovalRule({
  scope,
  id,
  name,
}: {
  scope: Scope;
  id: string;
  name: string;
}) {
  const t = useRulesT();
  return (
    <ActionForm
      action={deleteApprovalRuleAction}
      hidden={{ org: scope.org, projectKey: scope.projectKey, id }}
      label={t("delete.label", { name })}
      submitLabel={t("delete.submit")}
      submitVariant="danger"
      inline
    />
  );
}
