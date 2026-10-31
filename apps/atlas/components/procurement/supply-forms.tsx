"use client";

import type { HireWarning } from "@xos/data/procurement";
import { Button, Checkbox, InlineAlert, Input, Select } from "@xos/ui";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import type { ActionState } from "@/lib/collection-kit/forms";
import { HIRE_WARNING_KEY } from "@/lib/procurement/hire";
import { ActionFeedback } from "@/components/collection-kit/kit";
import { keepInputOnSubmit, useResetOnSuccess } from "@/components/collection-kit/keep-input";
import { useCopy } from "@/components/collection-kit/use-copy";

/**
 * The supply bridge forms (R7a), loaded on demand by the order and receipt pages: an order line that buys or hires
 * its item, with the delivery and return window warnings of a hire shown while it is typed (G-99, never blocking),
 * and a return to the vendor against a receipt.
 */

type ServerAction = (state: ActionState, form: FormData) => Promise<ActionState>;
type WarningsAction = (
  org: string,
  projectId: string,
  hireFrom: string,
  hireTo: string,
  timeZone: string,
) => Promise<HireWarning[] | null>;

const INITIAL: ActionState = {};
const REFUSALS = "procurement.refusals";

function useDone(state: ActionState, successHref?: string) {
  const router = useRouter();
  const seen = useRef<ActionState | null>(null);
  useEffect(() => {
    if (state.ok && seen.current !== state) {
      seen.current = state;
      if (successHref) router.push(successHref.replace("{id}", state.id ?? "") as Route);
      else router.refresh();
    }
  }, [state, successHref, router]);
}

export function PoLineForm({
  org,
  purchaseOrderId,
  projectId,
  currencyCode,
  timeZone,
  action,
  warningsAction,
}: {
  org: string;
  purchaseOrderId: string;
  projectId: string;
  currencyCode: string;
  /** The project's zone: hire times are typed in it. */
  timeZone: string;
  action: ServerAction;
  warningsAction: WarningsAction;
}) {
  const t = useCopy("procurement");
  const k = useCopy("procurement.kit");
  const [state, formAction, pending] = useActionState(action, INITIAL);
  const formRef = useResetOnSuccess(state);
  const [kind, setKind] = useState<"Purchase" | "Rental">("Purchase");
  const [hire, setHire] = useState({ from: "", to: "" });
  const [warnings, setWarnings] = useState<HireWarning[]>([]);
  const [, startCheck] = useTransition();
  useDone(state);
  const err = (name: string) =>
    state.fieldErrors?.[name] ? k(`validation.${state.fieldErrors[name]}`) : "";

  // The warnings follow the typed hire; an incomplete or backwards hire shows none. The latest check wins.
  const asked = useRef(0);
  const check = (next: { from: string; to: string }) => {
    setHire(next);
    const ask = (asked.current += 1);
    if (!next.from || !next.to) {
      setWarnings([]);
      return;
    }
    startCheck(async () => {
      const found = await warningsAction(org, projectId, next.from, next.to, timeZone);
      if (ask === asked.current) setWarnings(found ?? []);
    });
  };
  const shown = kind === "Rental" ? warnings : [];

  return (
    <form
      ref={formRef}
      id={`po-line-${purchaseOrderId}`}
      action={formAction}
      onSubmit={keepInputOnSubmit(formAction)}
      className="flex flex-col gap-12"
      noValidate
    >
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="purchaseOrderId" value={purchaseOrderId} />
      <input type="hidden" name="currencyCode" value={currencyCode} />
      <input type="hidden" name="timeZone" value={timeZone} />
      <ActionFeedback state={state} refusals={REFUSALS} />
      <Input
        id={`po-line-description-${purchaseOrderId}`}
        name="description"
        label={t("lines.descriptionLabel")}
        width="100%"
        required
        error={err("description")}
      />
      <div className="flex flex-wrap gap-12">
        <Input
          id={`po-line-quantity-${purchaseOrderId}`}
          name="quantity"
          inputMode="decimal"
          label={t("lines.quantity")}
          defaultValue="1"
          required
          error={err("quantity")}
        />
        <Input
          id={`po-line-unit-${purchaseOrderId}`}
          name="unitBasis"
          label={t("lines.unitBasis")}
          help={t("lines.unitBasisHelp")}
        />
        <Input
          id={`po-line-price-${purchaseOrderId}`}
          name="unitPrice"
          inputMode="decimal"
          label={`${t("lines.unitPrice")} (${currencyCode})`}
          help={k("moneyHelp")}
          error={err("unitPrice")}
        />
        <Select
          id={`po-line-acquisition-${purchaseOrderId}`}
          name="acquisitionKind"
          label={t("lines.acquisition.label")}
          value="Purchase"
          options={[
            { value: "Purchase", label: t("lines.acquisition.purchase") },
            { value: "Rental", label: t("lines.acquisition.rental") },
          ]}
          onChange={(e) => setKind(e.target.value === "Rental" ? "Rental" : "Purchase")}
        />
      </div>
      {kind === "Rental" ? (
        <div className="flex flex-col gap-8">
          <div className="flex flex-wrap gap-12">
            <Input
              id={`po-line-hire-from-${purchaseOrderId}`}
              name="hireFrom"
              type="datetime-local"
              label={t("lines.hire.from")}
              help={t("lines.hire.zone", { zone: timeZone })}
              error={err("hireFrom")}
              onChange={(e) => check({ ...hire, from: e.target.value })}
            />
            <Input
              id={`po-line-hire-to-${purchaseOrderId}`}
              name="hireTo"
              type="datetime-local"
              label={t("lines.hire.to")}
              error={err("hireTo")}
              onChange={(e) => check({ ...hire, to: e.target.value })}
            />
          </div>
          {shown.length > 0 ? (
            <InlineAlert tone="warning" title={t("hireWarnings.title")}>
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {shown.map((w) => (
                  <li key={w}>{t(`hireWarnings.${HIRE_WARNING_KEY[w]}`)}</li>
                ))}
              </ul>
            </InlineAlert>
          ) : null}
        </div>
      ) : null}
      <div>
        <Button type="submit" variant="secondary" loading={pending}>
          {t("orders.addLine")}
        </Button>
      </div>
    </form>
  );
}

export interface ReturnableLine {
  readonly receiptLineId: string;
  readonly label: string;
  /** What the receipt line brought in, less what already went back. */
  readonly returnable: number;
  readonly rental: boolean;
  /** Units that arrived on the line and can still go back. */
  readonly units: readonly { readonly id: string; readonly tag: string }[];
  /**
   * The venue whose lot the line's quantity came into, or null when it never came into stock. A line goes back the
   * way it came in, so a stocked quantity always leaves a lot and any other quantity never does.
   */
  readonly stockedAt: string | null;
}

export function ReturnForm({
  org,
  purchaseOrderId,
  lines,
  venues,
  action,
  successHref,
}: {
  org: string;
  purchaseOrderId: string;
  lines: readonly ReturnableLine[];
  venues: readonly { value: string; label: string }[];
  action: ServerAction;
  successHref?: string;
}) {
  const t = useCopy("procurement");
  const k = useCopy("procurement.kit");
  const [state, formAction, pending] = useActionState(action, INITIAL);
  // The event id is minted when the dialog opens, so a resubmitted return records nothing twice.
  const [eventId] = useState(() => crypto.randomUUID());
  useDone(state, successHref);
  const rental = lines.some((l) => l.rental);
  const reasons = ["Off Hire", "Defective", "Wrong Item", "Over Delivery"] as const;
  return (
    <form
      action={formAction}
      onSubmit={keepInputOnSubmit(formAction)}
      className="flex flex-col gap-12"
      noValidate
    >
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="purchaseOrderId" value={purchaseOrderId} />
      <input type="hidden" name="eventId" value={eventId} />
      <ActionFeedback state={state} refusals={REFUSALS} />
      <Select
        id={`return-reason-${purchaseOrderId}`}
        name="reason"
        label={t("returns.reason")}
        value={rental ? "Off Hire" : "Defective"}
        options={reasons.map((r) => ({ value: r, label: t(`returns.reasons.${reasonKey(r)}`) }))}
        error={state.fieldErrors?.["reason"] ? k("validation.required") : ""}
      />
      {lines.map((l) => (
        <fieldset key={l.receiptLineId} className="m-0 flex flex-col gap-8 border-0 p-0">
          <legend className="mb-4 text-label-13 font-medium">{l.label}</legend>
          <input type="hidden" name="receiptLineId" value={l.receiptLineId} />
          {l.units.length > 0 ? (
            <div className="flex flex-col gap-4">
              {l.units.map((u) => (
                <Checkbox
                  key={u.id}
                  name={`units-${l.receiptLineId}`}
                  value={u.id}
                  label={<span className="font-mono">{u.tag}</span>}
                />
              ))}
            </div>
          ) : (
            <div className="flex flex-wrap gap-12">
              <Input
                id={`return-qty-${l.receiptLineId}`}
                name={`returned-${l.receiptLineId}`}
                inputMode="decimal"
                label={t("returns.quantity")}
                help={t("returns.returnable", { count: l.returnable })}
                error={
                  state.fieldErrors?.[`returned-${l.receiptLineId}`] ? k("validation.number") : ""
                }
              />
              {l.stockedAt ? (
                <Select
                  id={`return-venue-${l.receiptLineId}`}
                  name={`venue-${l.receiptLineId}`}
                  label={t("returns.fromStock")}
                  value={l.stockedAt}
                  options={
                    venues.some((v) => v.value === l.stockedAt)
                      ? [...venues]
                      : [{ value: l.stockedAt, label: t("returns.receivedVenue") }, ...venues]
                  }
                />
              ) : null}
            </div>
          )}
        </fieldset>
      ))}
      {state.fieldErrors?.["lines"] ? (
        <p role="alert" className="m-0 text-text-12 text-danger-text">
          {k("validation.lines")}
        </p>
      ) : null}
      <Input
        id={`return-note-${purchaseOrderId}`}
        name="note"
        label={t("returns.note")}
        width="100%"
      />
      <div>
        <Button type="submit" variant="primary" loading={pending}>
          {t("returns.record")}
        </Button>
      </div>
    </form>
  );
}

function reasonKey(reason: string): string {
  const [first = "", ...rest] = reason.split(" ");
  return first.toLowerCase() + rest.join("");
}
