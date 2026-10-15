"use client";

import { Button, Input, Select } from "@xos/ui";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState } from "react";
import type { ActionState } from "@/lib/collection-kit/forms";
import { ActionFeedback } from "@/components/collection-kit/kit";
import { keepInputOnSubmit, useResetOnSuccess } from "@/components/collection-kit/keep-input";
import { useCopy } from "@/components/collection-kit/use-copy";

/**
 * Procurement forms with repeated rows that the generic EntityForm cannot express: an RFQ response
 * with its quoted lines, and a goods receipt with the quantity received per order line.
 */

type ServerAction = (state: ActionState, form: FormData) => Promise<ActionState>;
const INITIAL: ActionState = {};

function useDone(state: ActionState, successHref?: string) {
  const router = useRouter();
  const seen = useRef<ActionState | null>(null);
  useEffect(() => {
    if (state.ok && seen.current !== state) {
      seen.current = state;
      if (successHref)
        router.push(
          successHref.replace("{id}", state.id ?? "").replace("%7Bid%7D", state.id ?? "") as Route,
        );
      else router.refresh();
    }
  }, [state, successHref, router]);
}

export function ResponseForm({
  org,
  rfqId,
  vendors,
  currencies,
  defaultCurrency,
  action,
}: {
  org: string;
  rfqId: string;
  vendors: { value: string; label: string }[];
  currencies: { value: string; label: string }[];
  defaultCurrency: string;
  action: ServerAction;
}) {
  const t = useCopy("procurement");
  const k = useCopy("procurement.kit");
  const [state, formAction, pending] = useActionState(action, INITIAL);
  const formRef = useResetOnSuccess(state);
  const [count, setCount] = useState(2);
  useDone(state);
  const err = (name: string) =>
    state.fieldErrors?.[name] ? k(`validation.${state.fieldErrors[name]}`) : "";
  return (
    <form
      ref={formRef}
      action={formAction}
      onSubmit={keepInputOnSubmit(formAction)}
      className="flex flex-col gap-12"
      noValidate
    >
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="rfqId" value={rfqId} />
      <ActionFeedback state={state} refusals="procurement.refusals" />
      <div className="flex flex-wrap gap-12">
        <Select
          id={`resp-vendor-${rfqId}`}
          name="vendorId"
          label={t("rfqs.respondingVendor")}
          options={vendors}
          error={err("vendorId")}
        />
        <Select
          id={`resp-currency-${rfqId}`}
          name="currencyCode"
          label={t("fields.currency")}
          options={currencies}
          value={defaultCurrency}
          error={err("currencyCode")}
        />
        <Input
          id={`resp-valid-${rfqId}`}
          name="validUntil"
          type="date"
          label={t("rfqs.validUntil")}
          error={err("validUntil")}
        />
      </div>
      <fieldset className="m-0 flex flex-col gap-8 border-0 p-0">
        <legend className="mb-4 text-label-13 font-medium">{t("rfqs.quotedLines")}</legend>
        {Array.from({ length: count }, (_, i) => (
          <div
            key={i}
            className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)] max-sm:grid-cols-1 gap-8"
          >
            <Input
              id={`resp-desc-${rfqId}-${i}`}
              name="lineDescription"
              label={t("lines.description", { n: i + 1 })}
              width="100%"
            />
            <Input
              id={`resp-qty-${rfqId}-${i}`}
              name="lineQuantity"
              inputMode="decimal"
              label={t("lines.quantity")}
              width="100%"
              defaultValue="1"
            />
            <Input
              id={`resp-price-${rfqId}-${i}`}
              name="linePrice"
              inputMode="decimal"
              label={t("lines.unitPrice")}
              help={k("moneyHelp")}
              width="100%"
            />
          </div>
        ))}
        {state.fieldErrors?.["lines"] ? (
          <p role="alert" className="m-0 text-text-12 text-danger-text">
            {err("lines")}
          </p>
        ) : null}
        <div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setCount((c) => Math.min(c + 1, 30))}
          >
            {t("lines.addRow")}
          </Button>
        </div>
      </fieldset>
      <div>
        <Button type="submit" variant="primary" loading={pending}>
          {t("rfqs.recordResponse")}
        </Button>
      </div>
    </form>
  );
}

export function ReceiptForm({
  org,
  purchaseOrderId,
  lines,
  action,
  successHref,
}: {
  org: string;
  purchaseOrderId: string;
  lines: { id: string; label: string; ordered: number; received: number }[];
  action: ServerAction;
  successHref?: string;
}) {
  const t = useCopy("procurement");
  const k = useCopy("procurement.kit");
  const [state, formAction, pending] = useActionState(action, INITIAL);
  const formRef = useResetOnSuccess(state);
  useDone(state, successHref);
  return (
    <form
      ref={formRef}
      action={formAction}
      onSubmit={keepInputOnSubmit(formAction)}
      className="flex flex-col gap-12"
      noValidate
    >
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="purchaseOrderId" value={purchaseOrderId} />
      <ActionFeedback state={state} refusals="procurement.refusals" />
      {lines.map((l) => {
        const remaining = Math.max(0, l.ordered - l.received);
        return (
          <div key={l.id} className="flex flex-col gap-2">
            <input type="hidden" name="lineId" value={l.id} />
            <Input
              id={`receive-${l.id}`}
              name={`received-${l.id}`}
              inputMode="decimal"
              width="100%"
              label={l.label}
              help={t("receipts.remaining", { remaining, ordered: l.ordered })}
              defaultValue={remaining > 0 ? String(remaining) : ""}
              error={state.fieldErrors?.[`received-${l.id}`] ? k("validation.number") : ""}
            />
          </div>
        );
      })}
      {state.fieldErrors?.["lines"] ? (
        <p role="alert" className="m-0 text-text-12 text-danger-text">
          {k("validation.lines")}
        </p>
      ) : null}
      <Input
        id={`receive-note-${purchaseOrderId}`}
        name="note"
        label={t("receipts.note")}
        width="100%"
      />
      <div>
        <Button type="submit" variant="primary" loading={pending}>
          {t("receipts.record")}
        </Button>
      </div>
    </form>
  );
}
