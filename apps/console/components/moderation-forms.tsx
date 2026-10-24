"use client";

import { Input, Select, Textarea } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ActionForm } from "@/components/action-form";
import { decideAppealAction, decideListingAction } from "@/lib/actions/operations";

type Action = "Removed" | "Restricted" | "Restored" | "No Action";
type Ground = "Illegal Content" | "Terms Violation" | "No Violation";

const VIOLATIONS: readonly Ground[] = ["Terms Violation", "Illegal Content"];

function groundsFor(action: Action): readonly Ground[] {
  return action === "Removed" || action === "Restricted" ? VIOLATIONS : ["No Violation"];
}

/**
 * The statement of reasons in parts (Digital Services Act article 17): the decision, its ground (which follows
 * the decision), the law or rule relied on, the facts, and the statement the affected party receives. The database
 * refuses a decision whose parts do not fit.
 */
function StatementFields({
  idPrefix,
  actions,
  withStatement,
}: {
  idPrefix: string;
  actions: readonly Action[];
  withStatement: boolean;
}) {
  const t = useTranslations("console");
  const [action, setAction] = useState<Action>(actions[0] ?? "Removed");
  const grounds = groundsFor(action);
  return (
    <>
      <Select
        id={`${idPrefix}-action`}
        name="action"
        label={t("moderation.action")}
        value={action}
        options={actions.map((a) => ({ value: a, label: t(`actions.${a}`) }))}
        onChange={(e) => setAction(e.target.value as Action)}
      />
      <Select
        key={action}
        id={`${idPrefix}-ground`}
        name="ground"
        label={t("moderation.ground")}
        value={grounds[0] ?? "No Violation"}
        options={grounds.map((g) => ({ value: g, label: t(`grounds.${g}`) }))}
      />
      <Input
        id={`${idPrefix}-rule`}
        name="ruleReference"
        label={t("moderation.ruleReference")}
        help={t("moderation.ruleReferenceHelp")}
        maxLength={300}
        required={withStatement}
        width="100%"
      />
      <Textarea
        id={`${idPrefix}-facts`}
        name="facts"
        label={t("moderation.facts")}
        maxLength={4000}
        rows={3}
        required={withStatement}
        width="100%"
      />
      {withStatement ? (
        <Textarea
          id={`${idPrefix}-statement`}
          name="statement"
          label={t("moderation.statement")}
          help={t("moderation.statementHelp")}
          maxLength={4000}
          rows={4}
          required
          width="100%"
        />
      ) : null}
    </>
  );
}

export function DecideListingForm({
  opportunityId,
  removed,
}: {
  opportunityId: string;
  removed: boolean;
}) {
  const t = useTranslations("console");
  const actions: readonly Action[] = removed
    ? ["Restored", "Removed", "Restricted", "No Action"]
    : ["Removed", "Restricted", "No Action"];
  return (
    <ActionForm
      action={decideListingAction}
      hidden={{ opportunityId }}
      submitLabel={t("moderation.decide")}
      successLabel={t("moderation.decided")}
      label={t("moderation.decideTitle")}
      testId="decide-listing"
    >
      <StatementFields idPrefix="decide" actions={actions} withStatement />
    </ActionForm>
  );
}

export function DecideAppealForm({
  opportunityId,
  appealId,
  reversesNoAction,
}: {
  opportunityId: string;
  appealId: string;
  reversesNoAction: boolean;
}) {
  const t = useTranslations("console");
  const [outcome, setOutcome] = useState<"Upheld" | "Reversed">("Upheld");
  return (
    <ActionForm
      action={decideAppealAction}
      hidden={{ opportunityId, appealId }}
      submitLabel={t("moderation.decideAppeal")}
      successLabel={t("moderation.appealDecided")}
      label={t("moderation.decideAppeal")}
      testId="decide-appeal"
    >
      <Select
        id={`appeal-${appealId}-outcome`}
        name="outcome"
        label={t("moderation.outcome")}
        value={outcome}
        options={[
          { value: "Upheld", label: t("moderation.uphold") },
          { value: "Reversed", label: t("moderation.reverse") },
        ]}
        onChange={(e) => setOutcome(e.target.value === "Reversed" ? "Reversed" : "Upheld")}
      />
      <Textarea
        id={`appeal-${appealId}-statement`}
        name="statement"
        label={t("moderation.appealStatement")}
        maxLength={4000}
        rows={3}
        required
        width="100%"
      />
      {outcome === "Reversed" && reversesNoAction ? (
        <fieldset className="m-0 flex flex-col gap-12 border-0 p-0">
          <legend className="text-text-13 font-medium">{t("moderation.newDecision")}</legend>
          <StatementFields
            idPrefix={`appeal-${appealId}`}
            actions={["Removed", "Restricted"]}
            withStatement={false}
          />
        </fieldset>
      ) : null}
    </ActionForm>
  );
}
