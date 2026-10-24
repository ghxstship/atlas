"use client";

import { Input, Select } from "@xos/ui";
import { useActionState } from "react";
import { saveInvoiceAction } from "@/app/[org]/finance/actions";
import { ActionFeedback } from "./kit-action-feedback";
import { CustomFieldInputs } from "@/components/custom-fields/inputs";
import { fieldError } from "./kit-field-error";
import { useAfterSave } from "./kit-use-after-save";
import { useFinanceT } from "./kit-use-finance-t";
import { type Option } from "./kit.types";
import { ExtractEntry } from "@/components/aurora/entry/extract-entry";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import { INITIAL, Submit } from "./forms.shared";

// Invoices and payments ------------------------------------------------------------------------------

export function InvoiceForm({
  org,
  projects,
  projectId,
  counterparties,
  currencies,
  defaultCurrency,
  invoice,
}: {
  org: string;
  projects: readonly Option[];
  projectId: string | null;
  counterparties: readonly Option[];
  currencies: readonly string[];
  defaultCurrency: string;
  invoice?: { id: string; number: string | null; issuedOn: string | null; dueOn: string | null };
}) {
  const t = useFinanceT();
  const [state, action, pending] = useActionState(saveInvoiceAction, INITIAL);
  useAfterSave(state, invoice ? "edit" : "create");
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex flex-col gap-16"
      noValidate
    >
      <input type="hidden" name="org" value={org} />
      {invoice ? (
        <input type="hidden" name="id" value={invoice.id} />
      ) : (
        <>
          <ExtractEntry
            kind="invoice"
            fields={{
              invoice_number: { name: "number" },
              issued_on: { name: "issuedOn" },
              due_on: { name: "dueOn" },
              currency_code: { name: "currency" },
            }}
          />
          {projectId ? (
            <input type="hidden" name="projectId" value={projectId} />
          ) : (
            <Select
              id="invoice-project"
              name="projectId"
              label={t("common.project")}
              placeholder={t("common.chooseProject")}
              options={[...projects]}
              error={fieldError(t, state, "projectId")}
            />
          )}
          <Select
            id="invoice-direction"
            name="direction"
            label={t("invoices.fields.direction")}
            value="Payable"
            options={[
              { value: "Payable", label: t("invoices.direction.Payable") },
              { value: "Receivable", label: t("invoices.direction.Receivable") },
            ]}
          />
          <Select
            id="invoice-counterparty"
            name="counterpartyId"
            label={t("invoices.fields.counterparty")}
            placeholder={t("common.chooseCounterparty")}
            options={[...counterparties]}
            error={fieldError(t, state, "counterpartyId")}
          />
          <Select
            id="invoice-currency"
            name="currency"
            label={t("common.currency")}
            value={defaultCurrency}
            options={currencies.map((c) => ({ value: c, label: c }))}
          />
        </>
      )}
      <Input
        id="invoice-number"
        name="number"
        label={t("invoices.fields.number")}
        defaultValue={invoice?.number ?? ""}
        error={fieldError(t, state, "number")}
      />
      <div className="flex flex-wrap gap-12">
        <Input
          id="invoice-issued"
          name="issuedOn"
          type="date"
          label={t("invoices.fields.issuedOn")}
          defaultValue={invoice?.issuedOn ?? ""}
          error={fieldError(t, state, "issuedOn")}
        />
        <Input
          id="invoice-due"
          name="dueOn"
          type="date"
          label={t("invoices.fields.dueOn")}
          defaultValue={invoice?.dueOn ?? ""}
          error={fieldError(t, state, "dueOn")}
        />
      </div>
      {invoice ? null : <CustomFieldInputs table="app.invoices" />}
      <ActionFeedback state={state} />
      <Submit label={invoice ? t("common.save") : t("invoices.create")} pending={pending} />
    </form>
  );
}
