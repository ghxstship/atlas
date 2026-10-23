"use client";

import { Button, Checkbox, Input } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useId, useRef, useState } from "react";
import { OutcomeAlert } from "@/components/actions/action-button";
import { useStepUpForm } from "@/components/auth/security/step-up";
import { keepInputOnSubmit } from "@/components/forms/keep-input";
import type { SecretFormState } from "@/lib/actions/surfaces";

/**
 * Gateway client forms of the A86 settings surfaces (RRR-131, finding A65-004). Labels arrive translated from
 * the server; outcomes use the shared `gateway.outcomes` copy.
 *   TokenForm      a personal API token for one org: name, areas and expiry, shown once after creation; a
 *                  missing second factor opens A77's step-up dialog and retries
 *   ChoicesForm    a row of checkboxes saved together, for the company's notification defaults
 */

export interface TokenFormCopy {
  readonly label: string;
  readonly name: string;
  readonly scopes: string;
  readonly scopesHelp: string;
  readonly expires: string;
  readonly submit: string;
  readonly secretTitle: string;
  readonly secretBody: string;
  readonly secretField: string;
  readonly copy: string;
  readonly copied: string;
}

const needsStepUp = (state: SecretFormState) => state.stepUp === true;

export function TokenForm({
  action,
  orgId,
  scopes,
  expiry,
  copy,
}: {
  action: (state: SecretFormState, form: FormData) => Promise<SecretFormState>;
  orgId: string;
  scopes: readonly string[];
  expiry: readonly { readonly value: string; readonly label: string }[];
  copy: TokenFormCopy;
}) {
  const id = useId();
  const router = useRouter();
  const ref = useRef<HTMLFormElement>(null);
  const [state, run, pending] = useActionState<SecretFormState, FormData>(action, {});
  const [copied, setCopied] = useState(false);
  const stepUpDialog = useStepUpForm(state, needsStepUp, ref);
  useEffect(() => {
    if (state.secret) {
      ref.current?.reset();
      router.refresh();
    }
  }, [state, router]);
  return (
    <div className="flex flex-col gap-12">
      <form
        ref={ref}
        action={run}
        onSubmit={keepInputOnSubmit(run)}
        aria-label={copy.label}
        noValidate
        className="flex flex-col gap-12"
      >
        <input type="hidden" name="orgId" value={orgId} />
        {state.stepUp ? null : <OutcomeAlert outcome={state.outcome} />}
        <Input
          id={`${id}-name`}
          name="name"
          label={copy.name}
          required
          maxLength={200}
          width="100%"
        />
        <fieldset className="m-0 flex min-w-0 flex-col gap-8 border-0 p-0">
          <legend className="mb-4 p-0 text-text-13 font-medium">{copy.scopes}</legend>
          <p className="m-0 text-text-12 text-text-secondary">{copy.scopesHelp}</p>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-x-16 gap-y-8">
            {scopes.map((s) => (
              <Checkbox key={s} id={`${id}-scope-${s}`} name="scopes" value={s} label={s} />
            ))}
          </div>
        </fieldset>
        <label htmlFor={`${id}-expires`} className="flex min-w-0 flex-col gap-4 text-text-13">
          <span className="font-medium">{copy.expires}</span>
          <select
            id={`${id}-expires`}
            name="expiresIn"
            defaultValue="90"
            className="min-h-touch-min w-full min-w-0 max-w-full rounded-control border border-border-control bg-bg-surface px-8 text-text-14 text-text-primary"
          >
            {expiry.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <div>
          <Button type="submit" variant="primary" size="sm" disabled={pending} aria-busy={pending}>
            {copy.submit}
          </Button>
        </div>
      </form>
      {state.secret ? (
        <div
          role="status"
          className="flex flex-col gap-8 rounded-card border border-border-strong bg-bg-raised p-12"
        >
          <p className="m-0 text-text-13 font-semibold text-warning-text">{copy.secretTitle}</p>
          <p className="m-0 text-text-13 text-text-secondary">{copy.secretBody}</p>
          <Input
            id={`${id}-secret`}
            readOnly
            width="100%"
            label={copy.secretField}
            value={state.secret}
            className="font-mono"
          />
          <div className="flex items-center gap-12">
            <Button
              size="sm"
              onClick={async () => {
                await navigator.clipboard.writeText(state.secret ?? "");
                setCopied(true);
              }}
            >
              {copy.copy}
            </Button>
            {copied ? <span className="text-text-13 text-success-text">{copy.copied}</span> : null}
          </div>
        </div>
      ) : null}
      {stepUpDialog}
    </div>
  );
}

export interface ChoiceRow {
  readonly name: string;
  readonly label: string;
  readonly checked: boolean;
}

/** A group of checkboxes saved together, with a saved line once stored. */
export function ChoicesForm({
  action,
  hidden,
  legend,
  help,
  rows,
  submit,
  saved,
  canEdit,
}: {
  action: (state: SecretFormState, form: FormData) => Promise<SecretFormState>;
  hidden: Readonly<Record<string, string>>;
  legend: string;
  help: string;
  rows: readonly ChoiceRow[];
  submit: string;
  saved: string;
  canEdit: boolean;
}) {
  const id = useId();
  const router = useRouter();
  const [state, run, pending] = useActionState<SecretFormState, FormData>(action, {});
  useEffect(() => {
    if (state.done) router.refresh();
  }, [state, router]);
  return (
    <form
      action={run}
      onSubmit={keepInputOnSubmit(run)}
      aria-label={legend}
      className="flex flex-col gap-12"
    >
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <OutcomeAlert outcome={state.outcome} />
      <fieldset
        disabled={!canEdit}
        className="m-0 flex flex-col gap-8 rounded-card border border-border-subtle p-12"
      >
        <legend className="px-4 text-text-14 font-semibold">{legend}</legend>
        <p className="m-0 text-text-13 text-text-secondary">{help}</p>
        <div className="flex flex-wrap gap-16">
          {rows.map((r) => (
            <Checkbox
              key={r.name}
              id={`${id}-${r.name}`}
              name={r.name}
              label={r.label}
              defaultChecked={r.checked}
            />
          ))}
        </div>
      </fieldset>
      {state.done ? (
        <p role="status" className="m-0 text-text-13 text-success-text">
          {saved}
        </p>
      ) : null}
      {canEdit ? (
        <div>
          <Button type="submit" variant="primary" size="sm" disabled={pending} aria-busy={pending}>
            {submit}
          </Button>
        </div>
      ) : null}
    </form>
  );
}
