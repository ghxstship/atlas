"use client";

import { Input, Select } from "@xos/ui";
import { useActionState, useState } from "react";
import { saveQuoteAction } from "@/app/[org]/finance/quote-actions";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import { ActionFeedback } from "./kit-action-feedback";
import { fieldError } from "./kit-field-error";
import { useAfterSave } from "./kit-use-after-save";
import { useFinanceT } from "./kit-use-finance-t";
import { INITIAL, Submit } from "./forms.shared";

export interface QuoteBudgetOption {
  readonly value: string;
  readonly label: string;
  readonly projectId: string;
  readonly hasDefaultMarkup: boolean;
}

export interface QuoteEngagementOption {
  readonly value: string;
  readonly label: string;
  readonly projectId: string;
}

/**
 * New quote. The client engagement's options and the default markup field depend on the chosen budget,
 * so they carry a key on it and reset when it changes. Valid until defaults in the database to 30 days
 * from today on the project's calendar.
 */
export function QuoteForm({
  org,
  budgets,
  engagements,
}: {
  org: string;
  budgets: readonly QuoteBudgetOption[];
  engagements: readonly QuoteEngagementOption[];
}) {
  const t = useFinanceT();
  const [state, action, pending] = useActionState(saveQuoteAction, INITIAL);
  useAfterSave(state, "create");
  const [budgetId, setBudgetId] = useState(budgets.length === 1 ? (budgets[0]?.value ?? "") : "");
  const budget = budgets.find((b) => b.value === budgetId);
  const clients = engagements.filter((e) => e.projectId === budget?.projectId);
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex flex-col gap-16"
      noValidate
    >
      <input type="hidden" name="org" value={org} />
      <Select
        id="quote-budget"
        name="budgetId"
        label={t("quotes.fields.budget")}
        placeholder={t("quotes.fields.chooseBudget")}
        value={budgetId}
        options={budgets.map((b) => ({ value: b.value, label: b.label }))}
        onChange={(e) => setBudgetId(e.target.value)}
        error={fieldError(t, state, "budgetId")}
      />
      <Input
        id="quote-title"
        name="title"
        required
        width="100%"
        label={t("quotes.fields.title")}
        error={fieldError(t, state, "title")}
      />
      <Select
        key={`engagement-${budgetId}`}
        id="quote-engagement"
        name="engagementId"
        label={t("quotes.fields.engagement")}
        help={t("quotes.fields.engagementHelp")}
        value=""
        options={[
          { value: "", label: t("common.none") },
          ...clients.map((c) => ({ value: c.value, label: c.label })),
        ]}
        error={fieldError(t, state, "engagementId")}
      />
      <Input
        id="quote-valid-until"
        name="validUntil"
        type="date"
        label={t("quotes.fields.validUntil")}
        help={t("quotes.fields.validUntilHelp")}
        error={fieldError(t, state, "validUntil")}
      />
      {budget && !budget.hasDefaultMarkup ? (
        <Input
          key={`markup-${budgetId}`}
          id="quote-markup"
          name="defaultMarkupPercent"
          inputMode="decimal"
          label={t("budgets.fields.defaultMarkup")}
          help={t("budgets.fields.defaultMarkupHelp")}
          error={fieldError(t, state, "defaultMarkupPercent")}
        />
      ) : null}
      <ActionFeedback state={state} />
      <Submit label={t("quotes.create")} pending={pending} />
    </form>
  );
}
