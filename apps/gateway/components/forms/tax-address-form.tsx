"use client";

import { Button, InlineAlert, Input } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";
import { OutcomeAlert } from "@/components/actions/action-button";
import { keepInputOnSubmit } from "@/components/forms/keep-input";
import { setTaxFormAddressAction } from "@/lib/actions/payouts";
import type { FormResult } from "@/lib/actions/operations";

/** Copy the server passes in, so the form needs no namespace beyond Gateway's client set. */
export interface TaxAddressCopy {
  readonly title: string;
  readonly legalName: string;
  readonly legalNameHelp: string;
  readonly street: string;
  readonly locality: string;
  readonly region: string;
  readonly postal: string;
  readonly submit: string;
  readonly done: string;
  /** Field name to the sentence that says how to fix it. */
  readonly errors: Readonly<Record<string, string>>;
}

/** The name and mailing address on a W-9, which the 1099-NEC needs (A38-006). */
export function TaxAddressForm(props: {
  taxFormId: string;
  copy: TaxAddressCopy;
  initial: {
    readonly legalName: string | null;
    readonly streetAddress: string | null;
    readonly locality: string | null;
    readonly regionCode: string | null;
    readonly postalCode: string | null;
  };
}) {
  const { copy, initial } = props;
  const router = useRouter();
  const [state, action, pending] = useActionState<FormResult, FormData>(
    setTaxFormAddressAction,
    {},
  );
  useEffect(() => {
    if (state.done) router.refresh();
  }, [state.done, router]);
  if (state.done) {
    return (
      <p role="status" className="m-0 text-text-13 text-success-text">
        {copy.done}
      </p>
    );
  }
  const id = (field: string) => `${field}-${props.taxFormId}`;
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex w-full flex-col gap-12"
      aria-label={copy.title}
    >
      {state.fieldError ? (
        <InlineAlert tone="danger">
          {copy.errors[state.fieldError] ?? copy.errors["streetAddress"]}
        </InlineAlert>
      ) : null}
      <OutcomeAlert outcome={state.outcome} />
      <input type="hidden" name="taxFormId" value={props.taxFormId} />
      <Input
        id={id("legal-name")}
        name="legalName"
        autoComplete="name"
        label={copy.legalName}
        help={copy.legalNameHelp}
        defaultValue={initial.legalName ?? ""}
        width="100%"
      />
      <Input
        id={id("street")}
        name="streetAddress"
        required
        autoComplete="street-address"
        label={copy.street}
        defaultValue={initial.streetAddress ?? ""}
        width="100%"
      />
      <div className="flex flex-wrap gap-12">
        <Input
          id={id("locality")}
          name="locality"
          required
          autoComplete="address-level2"
          label={copy.locality}
          defaultValue={initial.locality ?? ""}
        />
        <Input
          id={id("region")}
          name="regionCode"
          required
          autoComplete="address-level1"
          maxLength={2}
          label={copy.region}
          defaultValue={initial.regionCode ?? ""}
          width={96}
        />
        <Input
          id={id("postal")}
          name="postalCode"
          required
          autoComplete="postal-code"
          inputMode="numeric"
          label={copy.postal}
          defaultValue={initial.postalCode ?? ""}
          width={140}
        />
      </div>
      <div>
        <Button type="submit" variant="primary" size="sm" disabled={pending} aria-busy={pending}>
          {copy.submit}
        </Button>
      </div>
    </form>
  );
}
