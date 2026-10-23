"use client";

import { Input, Select, Textarea } from "@xos/ui";
import { useActionState, useState } from "react";
import { saveChangeOrderAction } from "@/app/[org]/finance/actions";
import { ActionFeedback } from "./kit-action-feedback";
import { fieldError } from "./kit-field-error";
import { useAfterSave } from "./kit-use-after-save";
import { useFinanceT } from "./kit-use-finance-t";
import { type Option } from "./kit.types";
import { DraftEntry } from "@/components/aurora/entry/draft-entry";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import { INITIAL, Submit } from "./forms.shared";
import { type BudgetOption } from "./forms.types";

export function ChangeOrderForm({
  org,
  budgets,
  orderTypes,
  order,
}: {
  org: string;
  budgets: readonly BudgetOption[];
  orderTypes: readonly Option[];
  order?: { id: string; title: string; orderTypeId: string | null; reason: string | null };
}) {
  const t = useFinanceT();
  const [state, action, pending] = useActionState(saveChangeOrderAction, INITIAL);
  useAfterSave(state, order ? "edit" : "create");
  const [budgetId, setBudgetId] = useState(budgets.length === 1 ? (budgets[0]?.value ?? "") : "");
  const projectId = budgets.find((b) => b.value === budgetId)?.projectId ?? "";
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex flex-col gap-16"
      noValidate
    >
      <input type="hidden" name="org" value={org} />
      {order ? (
        <input type="hidden" name="id" value={order.id} />
      ) : (
        <>
          <input type="hidden" name="projectId" value={projectId} />
          <Select
            id="co-budget"
            name="budgetId"
            label={t("changeOrders.fields.budget")}
            placeholder={t("changeOrders.fields.chooseBudget")}
            value={budgetId}
            options={[...budgets]}
            onChange={(e) => setBudgetId(e.target.value)}
            error={fieldError(t, state, "budgetId")}
          />
        </>
      )}
      <Input
        id="co-title"
        name="title"
        required
        width="100%"
        label={t("changeOrders.fields.title")}
        defaultValue={order?.title ?? ""}
        error={fieldError(t, state, "title")}
      />
      <Select
        id="co-type"
        name="orderTypeId"
        label={t("changeOrders.fields.orderType")}
        value={order?.orderTypeId ?? ""}
        options={[{ value: "", label: t("common.none") }, ...orderTypes]}
      />
      <DraftEntry
        kind="change_order_description"
        fields={{ title: "title", body: "reason" }}
        instructionsFrom="title"
        maxBody={20000}
        context={[
          ...(order
            ? [{ collection: "change-orders", id: order.id, label: order.title }]
            : budgetId
              ? [
                  {
                    collection: "budgets",
                    id: budgetId,
                    label: budgets.find((b) => b.value === budgetId)?.label ?? "",
                  },
                ]
              : []),
        ]}
      />
      <Textarea
        id="co-reason"
        name="reason"
        width="100%"
        label={t("changeOrders.fields.reason")}
        defaultValue={order?.reason ?? ""}
        error={fieldError(t, state, "reason")}
      />
      <ActionFeedback state={state} />
      <Submit label={order ? t("common.save") : t("changeOrders.create")} pending={pending} />
    </form>
  );
}
