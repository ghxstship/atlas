"use client";

import type { Database } from "@xos/data/database.types";
import type { PublicIntake, IntakeInvoiceDraft } from "@xos/data/vendor-intake";
import { Button, Checkbox, InlineAlert, Input, Select } from "@xos/ui";
import { countryOptions } from "@xos/i18n/formats";
import { useLocale, useTranslations } from "next-intl";
import { useActionState, useEffect, useMemo, useState } from "react";
import { keepInputOnSubmit } from "@/components/forms/keep-input";
import { TaxAddressForm, type TaxAddressCopy } from "@/components/forms/tax-address-form";
import {
  intakeCreateAccountAction,
  intakeOnFileAction,
  intakePayoutAction,
  intakeSubmitAction,
  intakeTaxFormAction,
  type IntakeOnFileChoice,
  type IntakeResult,
} from "@/lib/actions/intake";
import { formatMoney, minorDigits } from "@/lib/format";
import {
  intakeSteps,
  intakeTaxKinds,
  parseLinePrice,
  todayIn,
  type IntakeStep,
} from "@/lib/intake-steps";

type Translate = (key: string, values?: Record<string, string | number>) => string;

const COPY = "gatewayOnboarding.intake";

type StepState = { readonly outcome: string | null };
const CLEAN: StepState = { outcome: null };

function useOutcomeText() {
  const t = useTranslations("gateway.outcomes") as unknown as Translate;
  return (outcome: string) => t(outcome);
}

function Outcome({ outcome }: { outcome: string | null }) {
  const text = useOutcomeText();
  return outcome ? <InlineAlert tone="danger">{text(outcome)}</InlineAlert> : null;
}

/** Runs one step's action; on success the wizard moves on. */
function useStep<T>(run: (data: FormData) => Promise<IntakeResult<T>>, onDone: (value: T) => void) {
  return useActionState(async (_s: StepState, data: FormData) => {
    const result = await run(data);
    if (!result.ok) return { outcome: result.outcome };
    onDone(result.data);
    return CLEAN;
  }, CLEAN);
}

interface Line {
  readonly description: string;
  readonly quantity: number;
  readonly unitPriceMinor: number | null;
}

/**
 * The steps of a vendor intake on the person's own session (B2, ADR 0141): one form per step, each with at most seven
 * fields and its own forward button; only Review holds the primary Submit. What the person already filed with this org
 * is offered instead of asking again. After a tax identifier is entered only its last four is ever shown.
 */
export function IntakeWizard({
  token,
  link,
  accounts,
  currencies,
  addressCopy,
}: {
  token: string;
  link: PublicIntake;
  accounts: readonly { readonly id: string; readonly name: string }[];
  /** ISO 4217 codes a first invoice may use; it starts on the org's base currency. */
  currencies: readonly string[];
  addressCopy: TaxAddressCopy;
}) {
  const t = useTranslations(COPY) as unknown as Translate;
  const locale = useLocale();
  // A new company account states its country (ADR 0160); the database refuses one outside the offered territories.
  const countries = useMemo(() => [...countryOptions(locale)], [locale]);
  const steps = useMemo(() => intakeSteps(link), [link]);
  const [index, setIndex] = useState(0);
  const step: IntakeStep = steps[index] ?? "review";
  const next = () => setIndex((i) => Math.min(i + 1, steps.length - 1));
  const back = () => setIndex((i) => Math.max(i - 1, 0));
  const [accountId, setAccountId] = useState<string | null>(null);
  // An account made in this step stays a choice when the person comes back to it.
  const [madeAccounts, setMadeAccounts] = useState<readonly { id: string; name: string }[]>([]);
  const accountChoices = [...accounts, ...madeAccounts];
  const [onFile, setOnFile] = useState<IntakeOnFileChoice | null>(null);
  const [tax, setTax] = useState<{ id: string; last4: string; kind: string } | null>(null);
  const [payout, setPayout] = useState<{ id: string; reference: string } | null>(null);
  const [signer, setSigner] = useState("");
  const [header, setHeader] = useState<Omit<IntakeInvoiceDraft, "lines"> | null>(null);
  const [lines, setLines] = useState<readonly Line[]>([]);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    if (link.roleType === "Vendor" && accountId === null) return;
    void intakeOnFileAction(token, accountId).then((result) => {
      if (result.ok) setOnFile(result.data);
    });
  }, [token, link.roleType, accountId]);

  const [companyState, companyAction, companyPending] = useStep(
    async (data) => {
      const name = String(data.get("newAccount") ?? "").trim();
      const picked = String(data.get("accountId") ?? "");
      if (name !== "") {
        const countryCode = String(data.get("newAccountCountry") ?? "");
        const made = await intakeCreateAccountAction(token, { name, countryCode });
        if (made.ok) setMadeAccounts((list) => [...list, { id: made.data, name }]);
        return made;
      }
      return picked === ""
        ? { ok: false as const, outcome: "refusals.vendor_intake_account" }
        : { ok: true as const, data: picked };
    },
    (id) => {
      // A tax form and payout reference belong to the account they were filed for: choosing another starts them again.
      if (id !== accountId) {
        setTax(null);
        setPayout(null);
        setOnFile(null);
      }
      setAccountId(id);
      next();
    },
  );
  const [taxState, taxAction, taxPending] = useStep(
    async (data) => {
      const kind = String(
        data.get("formKind") ?? "W-9",
      ) as Database["app"]["Enums"]["tax_form_kind"];
      const filed = await intakeTaxFormAction(token, {
        formKind: kind,
        tin: String(data.get("tin") ?? ""),
        withholding: data.get("withholding") === "on",
        accountId,
      });
      return filed.ok ? { ok: true as const, data: { ...filed.data, kind } } : filed;
    },
    (value) => {
      setTax({ id: value.taxFormId, last4: value.last4, kind: value.kind });
      next();
    },
  );
  const [payoutState, payoutAction, payoutPending] = useStep(
    async (data) => {
      const reference = String(data.get("reference") ?? "").trim();
      const added = await intakePayoutAction(token, { reference, accountId });
      return added.ok ? { ok: true as const, data: { id: added.data, reference } } : added;
    },
    (value) => {
      setPayout(value);
      next();
    },
  );
  const [submitState, submitAction, submitPending] = useStep(
    async () => {
      const draft: IntakeInvoiceDraft | null =
        link.collectInvoice && header && lines.length > 0
          ? {
              ...header,
              lines: lines.map((l) => ({
                description: l.description,
                quantity: l.quantity,
                unit_price_minor: l.unitPriceMinor,
              })),
            }
          : null;
      return intakeSubmitAction(token, {
        accountId,
        taxFormId: tax?.id ?? null,
        payoutAccountId: payout?.id ?? null,
        signerName: link.agreement ? signer.trim() || null : null,
        invoiceDraft: draft,
      });
    },
    () => setSent(true),
  );

  if (sent) {
    return (
      <p role="status" className="m-0 text-text-14 text-success-text" data-intake-sent="">
        {t("sent", { org: link.orgName })}
      </p>
    );
  }

  const nav = (forward: { label: string; pending?: boolean } | null) => (
    <div className="flex flex-wrap gap-8">
      {index > 0 ? (
        <Button type="button" variant="ghost" onClick={back}>
          {t("back")}
        </Button>
      ) : null}
      {forward ? (
        <Button type="submit" variant="secondary" loading={forward.pending ?? false}>
          {forward.label}
        </Button>
      ) : null}
    </div>
  );

  return (
    <section className="flex flex-col gap-16" aria-label={t(`steps.${step}`)}>
      <h2 className="m-0 text-heading-16 font-semibold">{t(`steps.${step}`)}</h2>

      {step === "company" ? (
        <form
          action={companyAction}
          onSubmit={keepInputOnSubmit(companyAction)}
          className="flex flex-col gap-12"
        >
          <Outcome outcome={companyState.outcome} />
          {accountChoices.length > 0 ? (
            <Select
              id="intake-account"
              name="accountId"
              label={t("account")}
              value={accountId ?? accountChoices[0]?.id ?? ""}
              options={accountChoices.map((a) => ({ value: a.id, label: a.name }))}
            />
          ) : null}
          <Input
            id="intake-new-account"
            name="newAccount"
            label={t("newAccount")}
            help={t("newAccountHelp")}
            maxLength={120}
            required={accountChoices.length === 0}
            width="100%"
          />
          <Select
            id="intake-new-account-country"
            name="newAccountCountry"
            label={t("newAccountCountry")}
            placeholder={t("newAccountCountryChoose")}
            options={countries}
          />
          {nav({ label: t("next"), pending: companyPending })}
        </form>
      ) : null}

      {step === "tax" ? (
        tax ? (
          <div className="flex flex-col gap-12">
            <p className="m-0 text-text-13">
              {t("taxOnFile", { kind: tax.kind, last4: tax.last4 })}
            </p>
            {tax.kind === "W-9" ? (
              <TaxAddressForm
                taxFormId={tax.id}
                copy={addressCopy}
                initial={{
                  legalName: null,
                  streetAddress: null,
                  locality: null,
                  regionCode: null,
                  postalCode: null,
                }}
              />
            ) : null}
            <div className="flex flex-wrap gap-8">
              <Button type="button" variant="ghost" onClick={back}>
                {t("back")}
              </Button>
              <Button type="button" variant="secondary" onClick={next}>
                {t("next")}
              </Button>
            </div>
          </div>
        ) : (
          <form
            action={taxAction}
            onSubmit={keepInputOnSubmit(taxAction)}
            className="flex flex-col gap-12"
          >
            <Outcome outcome={taxState.outcome} />
            {onFile?.taxForm ? (
              <div className="flex flex-col gap-8">
                <p className="m-0 text-text-13">
                  {t("taxReuse", { kind: onFile.taxForm.kind, last4: onFile.taxForm.last4 })}
                </p>
                <div>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      const form = onFile.taxForm;
                      if (form) setTax(form);
                      next();
                    }}
                  >
                    {t("useOnFile")}
                  </Button>
                </div>
              </div>
            ) : null}
            <Select
              id="intake-tax-kind"
              name="formKind"
              label={t("taxKind")}
              value="W-9"
              options={intakeTaxKinds(accountId !== null).map((k) => ({ value: k, label: k }))}
            />
            <Input
              id="intake-tin"
              name="tin"
              required
              autoComplete="off"
              inputMode="numeric"
              type="password"
              label={t("tin")}
              help={t("tinHelp")}
            />
            {accountId === null ? (
              <Checkbox id="intake-withholding" name="withholding" label={t("withholding")} />
            ) : null}
            {nav({ label: t("next"), pending: taxPending })}
          </form>
        )
      ) : null}

      {step === "payout" ? (
        <form
          action={payoutAction}
          onSubmit={keepInputOnSubmit(payoutAction)}
          className="flex flex-col gap-12"
        >
          <Outcome outcome={payoutState.outcome} />
          <p className="m-0 text-text-13 text-text-secondary">
            {t("payoutIntro", { org: link.orgName })}
          </p>
          {onFile?.payout && !payout ? (
            <div className="flex flex-wrap items-center gap-8">
              <span className="text-text-13">
                {t("payoutReuse", { reference: onFile.payout.reference })}
              </span>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => {
                  setPayout(onFile.payout);
                  next();
                }}
              >
                {t("useOnFile")}
              </Button>
            </div>
          ) : null}
          <Input
            id="intake-reference"
            name="reference"
            label={t("reference")}
            help={t("referenceHelp")}
            maxLength={200}
            required
            width="100%"
          />
          <div className="flex flex-wrap gap-8">
            <Button type="button" variant="ghost" onClick={back}>
              {t("back")}
            </Button>
            <Button type="button" variant="ghost" onClick={next}>
              {t("skip")}
            </Button>
            <Button type="submit" variant="secondary" loading={payoutPending}>
              {t("next")}
            </Button>
          </div>
        </form>
      ) : null}

      {step === "agreement" && link.agreement ? (
        <div className="flex flex-col gap-12">
          <p className="m-0 text-text-13">
            {t("agreementIntro", { title: link.agreement.title, version: link.agreement.version })}
          </p>
          <form method="post" action={`/onboard/${token}/agreement`}>
            <Button type="submit" size="sm" variant="secondary">
              {t("download")}
            </Button>
          </form>
          <Input
            id="intake-signer"
            label={t("signerName")}
            help={t("signerHelp")}
            value={signer}
            onChange={(event) => setSigner(event.target.value)}
            maxLength={200}
            width="100%"
          />
          <div className="flex flex-wrap gap-8">
            <Button type="button" variant="ghost" onClick={back}>
              {t("back")}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={signer.trim() === ""}
              onClick={next}
            >
              {t("next")}
            </Button>
          </div>
        </div>
      ) : null}

      {step === "invoice" ? (
        <InvoiceStep
          header={header}
          lines={lines}
          today={todayIn(link.timeZone)}
          currency={link.currencyCode}
          currencies={currencies}
          onHeader={setHeader}
          onLines={setLines}
          onBack={back}
          onNext={next}
        />
      ) : null}

      {step === "review" ? (
        <form
          action={submitAction}
          onSubmit={keepInputOnSubmit(submitAction)}
          className="flex flex-col gap-12"
        >
          <Outcome outcome={submitState.outcome} />
          <ul className="m-0 flex flex-col gap-4 ps-16 text-text-13">
            {accountId ? (
              <li>
                {t("reviewAccount", {
                  name: accountChoices.find((a) => a.id === accountId)?.name ?? t("newAccountName"),
                })}
              </li>
            ) : null}
            {tax ? <li>{t("taxOnFile", { kind: tax.kind, last4: tax.last4 })}</li> : null}
            {payout ? <li>{t("payoutOnFile", { reference: payout.reference })}</li> : null}
            {link.agreement && signer ? (
              <li>{t("reviewSigned", { name: signer, version: link.agreement.version })}</li>
            ) : null}
            {lines.length > 0 ? <li>{t("reviewInvoice", { count: lines.length })}</li> : null}
          </ul>
          <div className="flex flex-wrap gap-8">
            <Button type="button" variant="ghost" onClick={back}>
              {t("back")}
            </Button>
            <Button type="submit" variant="primary" loading={submitPending}>
              {t("submit")}
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

/**
 * The first invoice, in two windows so neither passes seven fields (gate 27): the header on its own, then an add-line
 * form above a read-only list with Remove. Optional: skipping sends no draft. Prices are minor units of the header's
 * currency, so going back to change the currency clears the lines rather than keep amounts meant for another one.
 */
function InvoiceStep({
  header,
  lines,
  today,
  currency,
  currencies,
  onHeader,
  onLines,
  onBack,
  onNext,
}: {
  header: Omit<IntakeInvoiceDraft, "lines"> | null;
  lines: readonly Line[];
  today: string;
  currency: string;
  currencies: readonly string[];
  onHeader: (value: Omit<IntakeInvoiceDraft, "lines"> | null) => void;
  onLines: (value: readonly Line[]) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const t = useTranslations(COPY) as unknown as Translate;
  const locale = useLocale();
  const [editing, setEditing] = useState(header === null);
  const [error, setError] = useState<string | null>(null);
  const [linesCleared, setLinesCleared] = useState(false);
  const lineCurrency = header?.currency_code ?? currency;
  const saveHeader = (data: FormData) => {
    const code = String(data.get("currency") ?? currency);
    const changed = header !== null && header.currency_code !== code && lines.length > 0;
    if (changed) onLines([]);
    setLinesCleared(changed);
    onHeader({
      invoice_number: String(data.get("number") ?? "").trim(),
      issue_date: String(data.get("issued") ?? today),
      due_date: String(data.get("due") ?? today),
      currency_code: code,
    });
    setEditing(false);
  };
  const addLine = (data: FormData) => {
    const quantity = Number(data.get("quantity") ?? 0);
    const description = String(data.get("description") ?? "").trim();
    if (description === "" || !(quantity > 0)) {
      setError(t("lineInvalid"));
      return;
    }
    const unitPriceMinor = parseLinePrice(String(data.get("price") ?? ""), lineCurrency);
    if (unitPriceMinor === "invalid") {
      setError(
        t("linePriceInvalid", { currency: lineCurrency, digits: minorDigits(lineCurrency) }),
      );
      return;
    }
    setError(null);
    setLinesCleared(false);
    onLines([...lines, { description, quantity, unitPriceMinor }]);
  };
  if (editing || !header) {
    return (
      <form
        action={saveHeader}
        onSubmit={keepInputOnSubmit(saveHeader)}
        className="flex flex-col gap-12"
      >
        <Input
          id="invoice-number"
          name="number"
          label={t("invoiceNumber")}
          defaultValue={header?.invoice_number ?? ""}
          maxLength={60}
          required
          width="100%"
        />
        <Input
          id="invoice-issued"
          name="issued"
          type="date"
          label={t("issueDate")}
          defaultValue={header?.issue_date ?? today}
          required
        />
        <Input
          id="invoice-due"
          name="due"
          type="date"
          label={t("dueDate")}
          defaultValue={header?.due_date ?? today}
          required
        />
        <Select
          id="invoice-currency"
          name="currency"
          label={t("currency")}
          value={lineCurrency}
          options={(currencies.includes(lineCurrency)
            ? currencies
            : [lineCurrency, ...currencies]
          ).map((c) => ({ value: c, label: c }))}
        />
        <div className="flex flex-wrap gap-8">
          <Button type="button" variant="ghost" onClick={onBack}>
            {t("back")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              onHeader(null);
              onLines([]);
              onNext();
            }}
          >
            {t("skip")}
          </Button>
          <Button type="submit" variant="secondary">
            {t("next")}
          </Button>
        </div>
      </form>
    );
  }
  return (
    <div className="flex flex-col gap-12">
      {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
      {linesCleared ? (
        <InlineAlert tone="warning">{t("linesCleared", { currency: lineCurrency })}</InlineAlert>
      ) : null}
      <form
        key={lines.length}
        action={addLine}
        onSubmit={keepInputOnSubmit(addLine)}
        className="flex flex-col gap-12"
      >
        <Input
          id="line-description"
          name="description"
          label={t("lineDescription")}
          maxLength={500}
          required
          width="100%"
        />
        <Input
          id="line-quantity"
          name="quantity"
          type="number"
          min={0}
          step="any"
          defaultValue={1}
          label={t("lineQuantity")}
          required
        />
        <Input
          id="line-price"
          name="price"
          inputMode="decimal"
          label={t("linePrice")}
          help={t("linePriceHelp", { currency: lineCurrency })}
        />
        <div>
          <Button type="submit" size="sm" variant="secondary">
            {t("addLine")}
          </Button>
        </div>
      </form>
      {lines.length > 0 ? (
        <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
          {lines.map((line, index) => (
            <li
              key={`${line.description}-${index}`}
              className="flex items-center justify-between gap-8 py-8 text-text-13"
            >
              <span>
                {t("lineSummary", {
                  description: line.description,
                  quantity: line.quantity,
                  price:
                    formatMoney(locale, line.unitPriceMinor, lineCurrency) ?? t("lineUnpriced"),
                })}
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => onLines(lines.filter((_, i) => i !== index))}
              >
                {t("removeLine")}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap gap-8">
        <Button type="button" variant="ghost" onClick={() => setEditing(true)}>
          {t("back")}
        </Button>
        <Button type="button" variant="secondary" disabled={lines.length === 0} onClick={onNext}>
          {t("next")}
        </Button>
      </div>
    </div>
  );
}
