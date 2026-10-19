"use client";

import { Button, Checkbox, InlineAlert, Input, Select, Textarea } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import {
  addLegalEntityAction,
  addNetworkAction,
  blockProfileAction,
  cancelAccessReviewAction,
  decideAccessReviewAction,
  endBreakGlassAction,
  legalEntityAction,
  openAccessReviewAction,
  removeNetworkAction,
  startBreakGlassAction,
  unblockAction,
  type AccessControlFormState,
} from "@/app/[org]/settings/access-control-actions";
import { useKeepInput } from "@/components/collection-kit/keep-input";

/**
 * Client forms for the A52 settings panels (legal entities, IP allow-list, break-glass, access
 * reviews and blocks). Each keeps what the person typed after a refusal and clears after a save.
 * None uses the primary button: the page's registry section owns the one primary action (gate 27).
 */

type Translate = (key: string, values?: Record<string, string | number>) => string;
type Option = { readonly value: string; readonly label: string };
type FormAction = (
  state: AccessControlFormState,
  form: FormData,
) => Promise<AccessControlFormState>;

const INITIAL: AccessControlFormState = {};
const succeeded = (state: AccessControlFormState) => state.ok === true;

function useCopy(): Translate {
  const t = useTranslations("settings.accessControls" as "settings");
  return (key, values) => (t as unknown as Translate)(key, values);
}

function Status({ state }: { state: AccessControlFormState }) {
  const t = useCopy();
  if (state.error) return <InlineAlert tone="danger">{t(`errors.${state.error}`)}</InlineAlert>;
  if (state.ok) {
    return (
      <p role="status" className="m-0 text-text-13 text-success-text">
        {t("saved")}
      </p>
    );
  }
  return null;
}

function useForm(action: FormAction) {
  const [state, dispatch, pending] = useActionState(action, INITIAL);
  const keep = useKeepInput(state, dispatch, succeeded);
  const t = useCopy();
  const fieldError = (name: string, key = "invalid") =>
    state.fieldErrors?.[name] ? t(`fieldErrors.${key}`) : "";
  return { state, dispatch, pending, keep, fieldError, t };
}

/** One submit button with hidden fields, for row actions (make primary, remove, decide, unblock). */
function RowAction({
  org,
  action,
  fields,
  buttons,
}: {
  org: string;
  action: FormAction;
  fields: Readonly<Record<string, string>>;
  buttons: readonly {
    readonly label: string;
    readonly ariaLabel: string;
    readonly name?: string;
    readonly value?: string;
    readonly variant?: "secondary" | "ghost" | "danger";
    readonly disabled?: boolean;
  }[];
}) {
  const { state, dispatch, pending, keep } = useForm(action);
  return (
    <form action={dispatch} {...keep} className="flex flex-col items-end gap-4">
      <input type="hidden" name="org" value={org} />
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <div className="flex flex-wrap justify-end gap-8">
        {buttons.map((b) => (
          <Button
            key={b.label}
            type="submit"
            size="sm"
            variant={b.variant ?? "ghost"}
            loading={pending}
            disabled={b.disabled}
            aria-label={b.ariaLabel}
            {...(b.name ? { name: b.name, value: b.value } : {})}
          >
            {b.label}
          </Button>
        ))}
      </div>
      {state.error ? <Status state={state} /> : null}
    </form>
  );
}

// Legal entities ------------------------------------------------------------------------------------------

export function AddLegalEntityForm({
  org,
  months,
  currencies,
  defaultMonth,
  defaultCurrency,
}: {
  org: string;
  months: readonly Option[];
  currencies: readonly Option[];
  defaultMonth: string;
  defaultCurrency: string;
}) {
  const { state, dispatch, pending, keep, fieldError, t } = useForm(addLegalEntityAction);
  return (
    <form
      action={dispatch}
      {...keep}
      aria-label={t("legalEntities.addLabel")}
      className="flex max-w-layout-form flex-col gap-12"
      noValidate
    >
      <input type="hidden" name="org" value={org} />
      <Status state={state} />
      <Input
        id="legal-entity-name"
        name="legalName"
        label={t("legalEntities.legalName")}
        width="100%"
        autoComplete="organization"
        error={fieldError("legalName")}
      />
      <div className="flex flex-wrap items-end gap-12">
        <Input
          id="legal-entity-country"
          name="countryCode"
          label={t("legalEntities.country")}
          help={t("legalEntities.countryHelp")}
          maxLength={2}
          width={120}
          autoComplete="country"
          error={fieldError("countryCode")}
        />
        <Select
          id="legal-entity-month"
          name="fiscalYearStartMonth"
          label={t("legalEntities.fiscalYearStart")}
          value={defaultMonth}
          options={[...months]}
        />
        <Select
          id="legal-entity-currency"
          name="baseCurrency"
          label={t("legalEntities.baseCurrency")}
          value={defaultCurrency}
          options={[...currencies]}
        />
      </div>
      <Input
        id="legal-entity-tax"
        name="taxIdentifier"
        label={t("legalEntities.taxIdentifier")}
        help={t("legalEntities.taxIdentifierHelp")}
        autoComplete="off"
        spellCheck={false}
        error={fieldError("taxIdentifier")}
      />
      <div>
        <Button type="submit" loading={pending}>
          {t("legalEntities.add")}
        </Button>
      </div>
    </form>
  );
}

export function LegalEntityActions({
  org,
  id,
  name,
  isPrimary,
}: {
  org: string;
  id: string;
  name: string;
  isPrimary: boolean;
}) {
  const t = useCopy();
  return (
    <RowAction
      org={org}
      action={legalEntityAction}
      fields={{ legalEntityId: id }}
      buttons={[
        ...(isPrimary
          ? []
          : [
              {
                label: t("legalEntities.makePrimary"),
                ariaLabel: t("legalEntities.makePrimaryNamed", { name }),
                name: "intent",
                value: "primary",
              },
            ]),
        {
          label: t("legalEntities.remove"),
          ariaLabel: t("legalEntities.removeNamed", { name }),
          name: "intent",
          value: "remove",
        },
      ]}
    />
  );
}

// IP allow-list ---------------------------------------------------------------------------------------------

export function AddNetworkForm({ org }: { org: string }) {
  const { state, dispatch, pending, keep, fieldError, t } = useForm(addNetworkAction);
  return (
    <form
      action={dispatch}
      {...keep}
      aria-label={t("network.addLabel")}
      className="flex flex-col gap-12"
      noValidate
    >
      <input type="hidden" name="org" value={org} />
      <Status state={state} />
      <div className="flex flex-wrap items-end gap-12">
        <Input
          id="network-cidr"
          name="cidr"
          label={t("network.cidr")}
          help={t("network.cidrHelp")}
          spellCheck={false}
          autoComplete="off"
          error={fieldError("cidr", "cidr")}
        />
        <Input
          id="network-label"
          name="label"
          label={t("network.label")}
          error={fieldError("label")}
        />
      </div>
      <div>
        <Button type="submit" loading={pending}>
          {t("network.add")}
        </Button>
      </div>
    </form>
  );
}

export function RemoveNetworkButton({
  org,
  id,
  label,
}: {
  org: string;
  id: string;
  label: string;
}) {
  const t = useCopy();
  return (
    <RowAction
      org={org}
      action={removeNetworkAction}
      fields={{ networkId: id }}
      buttons={[{ label: t("network.remove"), ariaLabel: t("network.removeNamed", { label }) }]}
    />
  );
}

// Break-glass -----------------------------------------------------------------------------------------------

export function BreakGlassForm({ org }: { org: string }) {
  const { state, dispatch, pending, keep, fieldError, t } = useForm(startBreakGlassAction);
  return (
    <form
      action={dispatch}
      {...keep}
      aria-label={t("breakGlass.startLabel")}
      className="flex max-w-layout-form flex-col gap-12"
      noValidate
    >
      <input type="hidden" name="org" value={org} />
      <Status state={state} />
      <Textarea
        id="break-glass-reason"
        name="reason"
        label={t("breakGlass.reason")}
        help={t("breakGlass.reasonHelp")}
        rows={3}
        width="100%"
        maxLength={2000}
        error={fieldError("reason", "reason")}
      />
      <div>
        <Button type="submit" variant="danger" loading={pending}>
          {t("breakGlass.start")}
        </Button>
      </div>
    </form>
  );
}

export function EndBreakGlassButton({ org, sessionId }: { org: string; sessionId: string }) {
  const t = useCopy();
  return (
    <RowAction
      org={org}
      action={endBreakGlassAction}
      fields={{ sessionId }}
      buttons={[
        { label: t("breakGlass.end"), ariaLabel: t("breakGlass.end"), variant: "secondary" },
      ]}
    />
  );
}

// Access reviews ---------------------------------------------------------------------------------------------

export function OpenReviewForm({
  org,
  defaultName,
  defaultDue,
  defaultAutoRemove,
}: {
  org: string;
  defaultName: string;
  defaultDue: string;
  defaultAutoRemove: boolean;
}) {
  const { state, dispatch, pending, keep, fieldError, t } = useForm(openAccessReviewAction);
  return (
    <form
      action={dispatch}
      {...keep}
      aria-label={t("reviews.openLabel")}
      className="flex max-w-layout-form flex-col gap-12"
      noValidate
    >
      <input type="hidden" name="org" value={org} />
      <Status state={state} />
      <div className="flex flex-wrap items-end gap-12">
        <Input
          id="review-name"
          name="name"
          label={t("reviews.name")}
          defaultValue={defaultName}
          error={fieldError("name")}
        />
        <Input
          id="review-due"
          name="dueOn"
          type="date"
          label={t("reviews.dueOn")}
          defaultValue={defaultDue}
          width={180}
          error={fieldError("dueOn")}
        />
      </div>
      <Checkbox
        id="review-auto-remove"
        name="autoRemove"
        label={t("reviews.autoRemove")}
        defaultChecked={defaultAutoRemove}
      />
      <div>
        <Button type="submit" loading={pending}>
          {t("reviews.open")}
        </Button>
      </div>
    </form>
  );
}

export function CancelReviewButton({ org, campaignId }: { org: string; campaignId: string }) {
  const t = useCopy();
  return (
    <RowAction
      org={org}
      action={cancelAccessReviewAction}
      fields={{ campaignId }}
      buttons={[{ label: t("reviews.cancel"), ariaLabel: t("reviews.cancel") }]}
    />
  );
}

export function ReviewDecision({
  org,
  itemId,
  subject,
  self,
}: {
  org: string;
  itemId: string;
  subject: string;
  self: boolean;
}) {
  const t = useCopy();
  return (
    <RowAction
      org={org}
      action={decideAccessReviewAction}
      fields={{ itemId }}
      buttons={[
        {
          label: t("reviews.confirm"),
          ariaLabel: t("reviews.confirmNamed", { subject }),
          name: "decision",
          value: "Confirmed",
          variant: "secondary",
          disabled: self,
        },
        {
          label: t("reviews.remove"),
          ariaLabel: t("reviews.removeNamed", { subject }),
          name: "decision",
          value: "Removed",
          disabled: self,
        },
      ]}
    />
  );
}

// Blocks ------------------------------------------------------------------------------------------------------

export function BlockForm({ org }: { org: string }) {
  const { state, dispatch, pending, keep, fieldError, t } = useForm(blockProfileAction);
  return (
    <form
      action={dispatch}
      {...keep}
      aria-label={t("blocks.addLabel")}
      className="flex flex-col gap-12"
      noValidate
    >
      <input type="hidden" name="org" value={org} />
      <Status state={state} />
      <div className="flex flex-wrap items-end gap-12">
        <Select
          id="block-kind"
          name="kind"
          label={t("blocks.kind")}
          value="person"
          options={[
            { value: "person", label: t("blocks.kinds.person") },
            { value: "organization", label: t("blocks.kinds.organization") },
          ]}
        />
        <Input
          id="block-handle"
          name="handle"
          label={t("blocks.handle")}
          help={t("blocks.handleHelp")}
          spellCheck={false}
          autoComplete="off"
          error={fieldError("handle")}
        />
      </div>
      <div>
        <Button type="submit" loading={pending}>
          {t("blocks.block")}
        </Button>
      </div>
    </form>
  );
}

export function UnblockButton({ org, id, name }: { org: string; id: string; name: string }) {
  const t = useCopy();
  return (
    <RowAction
      org={org}
      action={unblockAction}
      fields={{ blockId: id }}
      buttons={[{ label: t("blocks.unblock"), ariaLabel: t("blocks.unblockNamed", { name }) }]}
    />
  );
}
