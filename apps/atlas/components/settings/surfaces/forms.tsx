"use client";

import { Button, Checkbox, Dialog, InlineAlert, Input, Select, Textarea } from "@xos/ui";
import { useTranslations } from "next-intl";
import {
  useActionState,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useStepUpForm } from "@/components/auth/security/step-up";
import { keepInputOnSubmit, useKeepInput } from "@/components/collection-kit/keep-input";
import type { SurfaceState } from "./state";

/**
 * Client forms of the settings surfaces A86 contributes (RRR-131, finding A65-004). Every label arrives
 * translated from the server, and every outcome comes back from the server action already in words, so these
 * forms carry no catalog of their own. Three shapes:
 *   SurfaceForm     a create form: fields, one submit, an error in words, and for keys and endpoints the secret
 *                   shown once with a copy button
 *   SurfaceButton   a one-click action on a row (revoke, replay, release), optionally confirmed in a dialog
 *                   with a required reason
 *   SaveBarForm     an edit form with the settings save bar (A59-018, A60): no Save until something differs from
 *                   what is saved, then a count of changes, Discard and Save
 */

type ServerAction = (state: SurfaceState, form: FormData) => Promise<SurfaceState>;

const INITIAL: SurfaceState = {};

export interface Option {
  readonly value: string;
  readonly label: string;
}

export type SurfaceField =
  | {
      readonly kind: "text" | "email" | "url" | "number" | "date" | "datetime-local";
      readonly name: string;
      readonly label: string;
      readonly help?: string;
      readonly required?: boolean;
      readonly defaultValue?: string;
      readonly inputMode?: "decimal" | "numeric" | "text";
      readonly min?: string;
      readonly max?: string;
      readonly maxLength?: number;
    }
  | {
      readonly kind: "textarea";
      readonly name: string;
      readonly label: string;
      readonly help?: string;
      readonly required?: boolean;
      readonly defaultValue?: string;
      readonly maxLength?: number;
    }
  | {
      readonly kind: "select";
      readonly name: string;
      readonly label: string;
      readonly help?: string;
      readonly options: readonly Option[];
      /** Undefined selects the first option (or the prompt). */
      readonly defaultValue?: string | undefined;
      /** Shown first and unselectable, so a choice is required. */
      readonly prompt?: string;
    }
  | {
      readonly kind: "checkbox";
      readonly name: string;
      readonly label: string;
      readonly help?: string;
      readonly defaultChecked?: boolean;
    }
  | {
      readonly kind: "checkboxes";
      readonly name: string;
      readonly label: string;
      readonly help?: string;
      readonly options: readonly Option[];
      readonly defaultValues?: readonly string[];
    };

/** The secret a create action returns once, and how to present it. */
export interface SecretCopy {
  readonly title: string;
  readonly body: string;
  readonly field: string;
  readonly copy: string;
  readonly copied: string;
}

function Hidden({ values }: { values: Readonly<Record<string, string>> }) {
  return (
    <>
      {Object.entries(values).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
    </>
  );
}

function Field({
  field,
  formId,
  error,
}: {
  field: SurfaceField;
  formId: string;
  error: string | undefined;
}) {
  const id = `${formId}-${field.name}`;
  const help = field.help ? { help: field.help } : {};
  switch (field.kind) {
    case "textarea":
      return (
        <Textarea
          id={id}
          name={field.name}
          label={field.label}
          required={field.required}
          defaultValue={field.defaultValue ?? ""}
          maxLength={field.maxLength}
          width="100%"
          error={error ?? ""}
          {...help}
        />
      );
    case "select":
      return (
        <Select
          id={id}
          name={field.name}
          label={field.label}
          options={[...field.options]}
          error={error ?? ""}
          {...(field.defaultValue !== undefined ? { value: field.defaultValue } : {})}
          {...(field.prompt && field.defaultValue === undefined
            ? { placeholder: field.prompt }
            : {})}
          {...help}
        />
      );
    case "checkbox":
      return (
        <div className="flex flex-col gap-4">
          <Checkbox
            id={id}
            name={field.name}
            label={field.label}
            defaultChecked={field.defaultChecked}
          />
          {field.help ? <p className="m-0 text-text-12 text-text-secondary">{field.help}</p> : null}
        </div>
      );
    case "checkboxes":
      return (
        <fieldset className="m-0 flex min-w-0 flex-col gap-8 border-0 p-0">
          <legend className="mb-4 p-0 text-text-13 font-medium text-text-primary">
            {field.label}
          </legend>
          {field.help ? <p className="m-0 text-text-12 text-text-secondary">{field.help}</p> : null}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-x-16 gap-y-8">
            {field.options.map((o) => (
              <Checkbox
                key={o.value}
                id={`${id}-${o.value}`}
                name={field.name}
                value={o.value}
                label={o.label}
                defaultChecked={field.defaultValues?.includes(o.value)}
              />
            ))}
          </div>
          {error ? (
            <p role="alert" className="m-0 text-text-12 text-danger-text">
              {error}
            </p>
          ) : null}
        </fieldset>
      );
    default:
      return (
        <Input
          id={id}
          name={field.name}
          type={field.kind}
          label={field.label}
          required={field.required}
          defaultValue={field.defaultValue ?? ""}
          inputMode={field.inputMode}
          min={field.min}
          max={field.max}
          maxLength={field.maxLength}
          width="100%"
          error={error ?? ""}
          {...help}
        />
      );
  }
}

function SecretReveal({ secret, copy }: { secret: string; copy: SecretCopy }) {
  const [copied, setCopied] = useState(false);
  const id = useId();
  return (
    <div
      role="status"
      className="flex flex-col gap-8 rounded-card border border-border-strong bg-bg-raised p-12"
    >
      <p className="m-0 text-text-13 font-semibold text-warning-text">{copy.title}</p>
      <p className="m-0 text-text-13 text-text-secondary">{copy.body}</p>
      <Input
        id={`${id}-secret`}
        readOnly
        width="100%"
        label={copy.field}
        value={secret}
        className="font-mono"
      />
      <div className="flex items-center gap-12">
        <Button
          onClick={async () => {
            await navigator.clipboard.writeText(secret);
            setCopied(true);
          }}
        >
          {copy.copy}
        </Button>
        {copied ? <span className="text-text-13 text-success-text">{copy.copied}</span> : null}
      </div>
    </div>
  );
}

const needsStepUp = (state: SurfaceState) => state.stepUp === true;

/**
 * A create form; resets after a save unless the action refused it, so typed input survives a refusal. When the
 * action answers that a recent second factor is needed (A77's step-up), the step-up dialog opens, and verifying
 * submits the form again.
 */
export function SurfaceForm({
  id,
  action,
  label,
  hidden = {},
  fields,
  submitLabel,
  doneLabel,
  secret,
  children,
}: {
  id: string;
  action: ServerAction;
  label: string;
  hidden?: Readonly<Record<string, string>>;
  fields: readonly SurfaceField[];
  submitLabel: string;
  doneLabel?: string;
  secret?: SecretCopy;
  /** Shown above the fields, for example a sentence explaining the rule. */
  children?: ReactNode;
}) {
  const [state, dispatch, pending] = useActionState(action, INITIAL);
  const keep = useKeepInput(state, dispatch, (s) => s.ok === true);
  const stepUpDialog = useStepUpForm(state, needsStepUp, keep.ref);
  return (
    <div className="flex flex-col gap-12">
      <form
        id={id}
        action={dispatch}
        {...keep}
        aria-label={label}
        noValidate
        className="flex flex-col gap-12"
      >
        <Hidden values={hidden} />
        {children}
        {state.message ? <InlineAlert tone="danger">{state.message}</InlineAlert> : null}
        {fields.map((f) => (
          <Field key={f.name} field={f} formId={id} error={state.fieldErrors?.[f.name]} />
        ))}
        <div className="flex flex-wrap items-center gap-12">
          <Button type="submit" variant="primary" loading={pending}>
            {submitLabel}
          </Button>
          {state.ok && doneLabel && !state.secret ? (
            <p role="status" className="m-0 text-text-13 text-success-text">
              {doneLabel}
            </p>
          ) : null}
        </div>
      </form>
      {state.ok && state.secret && secret ? (
        <SecretReveal key={state.at} secret={state.secret} copy={secret} />
      ) : null}
      {stepUpDialog}
    </div>
  );
}

/** A one-click action on a row, confirmed first when it cannot be undone. */
export function SurfaceButton({
  action,
  hidden,
  label,
  variant = "ghost",
  confirm,
}: {
  action: ServerAction;
  hidden: Readonly<Record<string, string>>;
  label: string;
  variant?: "ghost" | "secondary" | "danger";
  confirm?: {
    readonly title: string;
    readonly body: string;
    readonly confirmLabel: string;
    readonly cancelLabel: string;
    /** A required reason recorded with the action. */
    readonly reason?: { readonly name: string; readonly label: string };
  };
}) {
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [state, dispatch, pending] = useActionState<SurfaceState, FormData>(async (prev, form) => {
    const result = await action(prev, form);
    if (result.ok) setOpen(false);
    return result;
  }, INITIAL);
  const error = state.message ? (
    <p role="alert" className="m-0 text-text-12 text-danger-text">
      {state.message}
    </p>
  ) : null;
  if (!confirm) {
    return (
      <form
        action={dispatch}
        onSubmit={keepInputOnSubmit(dispatch)}
        className="flex flex-col gap-4"
      >
        <Hidden values={hidden} />
        <Button type="submit" size="sm" variant={variant} loading={pending}>
          {label}
        </Button>
        {error}
      </form>
    );
  }
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button size="sm" variant={variant}>
          {label}
        </Button>
      }
      title={confirm.title}
      description={confirm.body}
      actions={
        <>
          <Button onClick={() => setOpen(false)}>{confirm.cancelLabel}</Button>
          <Button type="submit" form={formId} variant="danger" loading={pending}>
            {confirm.confirmLabel}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        action={dispatch}
        onSubmit={keepInputOnSubmit(dispatch)}
        className="flex flex-col gap-8"
      >
        <Hidden values={hidden} />
        {confirm.reason ? (
          <Textarea
            id={`${formId}-${confirm.reason.name}`}
            name={confirm.reason.name}
            label={confirm.reason.label}
            required
            maxLength={500}
            width="100%"
          />
        ) : null}
        {error}
      </form>
    </Dialog>
  );
}

/** The form's values as comparable text, one entry per name. */
function snapshot(form: HTMLFormElement): Map<string, string> {
  const out = new Map<string, string[]>();
  for (const [name, value] of new FormData(form)) {
    if (typeof value !== "string") continue;
    out.set(name, [...(out.get(name) ?? []), value]);
  }
  return new Map([...out].map(([name, values]) => [name, [...values].sort().join("\u0000")]));
}

function changedNames(before: Map<string, string>, after: Map<string, string>): number {
  let count = 0;
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    if ((before.get(name) ?? "") !== (after.get(name) ?? "")) count += 1;
  }
  return count;
}

/**
 * An edit form with the settings save bar: the bar appears once a value differs from what is saved, counts the
 * changed fields, and saves them together or discards them. Fields are the server-rendered children; a field
 * group of checkboxes counts as one change.
 */
export function SaveBarForm({
  action,
  label,
  hidden = {},
  canEdit,
  children,
}: {
  action: ServerAction;
  label: string;
  hidden?: Readonly<Record<string, string>>;
  canEdit: boolean;
  children: ReactNode;
}) {
  const t = useTranslations("settings");
  const [state, dispatch, pending] = useActionState(action, INITIAL);
  const formRef = useRef<HTMLFormElement>(null);
  const saved = useRef<Map<string, string>>(new Map());
  const [changes, setChanges] = useState(0);
  const [seen, setSeen] = useState(state.at);

  useEffect(() => {
    if (formRef.current) saved.current = snapshot(formRef.current);
  }, []);
  // A finished save that succeeded makes the saved values the new baseline (the server re-rendered them).
  if (state.at !== seen) {
    setSeen(state.at);
    if (state.ok) setChanges(0);
  }
  useEffect(() => {
    if (state.ok && formRef.current) {
      formRef.current.reset();
      saved.current = snapshot(formRef.current);
    }
  }, [state.at, state.ok]);

  const recompute = () => {
    if (formRef.current) setChanges(changedNames(saved.current, snapshot(formRef.current)));
  };
  const discard = () => {
    formRef.current?.reset();
    setChanges(0);
  };
  const submit = (event: FormEvent<HTMLFormElement>) => keepInputOnSubmit(dispatch)(event);

  return (
    <form
      ref={formRef}
      action={dispatch}
      onSubmit={submit}
      aria-label={label}
      noValidate
      onInput={recompute}
      onChange={recompute}
      className="flex flex-col gap-16"
    >
      <Hidden values={hidden} />
      {state.message ? <InlineAlert tone="danger">{state.message}</InlineAlert> : null}
      <fieldset disabled={!canEdit} className="m-0 flex min-w-0 flex-col gap-16 border-0 p-0">
        {children}
      </fieldset>
      {canEdit && changes > 0 ? (
        <div className="sticky bottom-0 z-sticky flex flex-wrap items-center justify-end gap-8 border-t border-border-subtle bg-bg-canvas py-12">
          <span role="status" className="me-auto text-text-12 text-text-secondary">
            {t("unsaved", { count: changes })}
          </span>
          <Button variant="ghost" onClick={discard}>
            {t("discard")}
          </Button>
          <Button type="submit" variant="primary" loading={pending}>
            {t("save")}
          </Button>
        </div>
      ) : state.ok ? (
        <p role="status" className="m-0 py-12 text-text-12 text-success-text">
          {t("saved")}
        </p>
      ) : null}
    </form>
  );
}

/** Server-rendered checkbox groups and selects for a SaveBarForm, so the form reads them as plain fields. */
export function SaveBarFields({
  formId,
  fields,
}: {
  formId: string;
  fields: readonly SurfaceField[];
}) {
  return (
    <>
      {fields.map((f) => (
        <Field key={f.name} field={f} formId={formId} error={undefined} />
      ))}
    </>
  );
}
