"use client";

import { Button, Checkbox, Field, InlineAlert, Input, Select, Textarea } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useActionState, useId } from "react";
import type { OpportunityActionState } from "@/lib/opportunities/action-state";

import { useKeepInput } from "@/components/collection-kit/keep-input";
/**
 * One declarative form for every Opportunities write (Section 11.10 rule 11: errors say how to fix). Server pages
 * describe the fields; the server action validates, calls the repository and answers with a catalog key. The form keeps
 * what was typed after a refusal, announces success, and shows a signing link once when the action returns one.
 */

export interface FieldOption {
  readonly value: string;
  readonly label: string;
}

export interface FieldSpec {
  readonly name: string;
  readonly label: string;
  readonly kind:
    "text" | "textarea" | "number" | "date" | "datetime-local" | "select" | "checkbox" | "email";
  readonly options?: readonly FieldOption[];
  readonly required?: boolean;
  readonly defaultValue?: string;
  readonly help?: string;
  readonly min?: number;
  readonly max?: number;
  readonly step?: string;
  /** Shown but not editable, for example a choice a published record no longer allows (the help says why). */
  readonly disabled?: boolean;
}

const INITIAL: OpportunityActionState = {};

type Translate = (key: string, values?: Record<string, string | number>) => string;

export function ActionForm({
  action,
  hidden,
  fields,
  submitLabel,
  title,
  variant = "secondary",
  inline = false,
  successLabel,
}: {
  action: (state: OpportunityActionState, form: FormData) => Promise<OpportunityActionState>;
  hidden: Readonly<Record<string, string>>;
  fields: readonly FieldSpec[];
  submitLabel: string;
  title?: string;
  variant?: "primary" | "secondary" | "danger";
  inline?: boolean;
  successLabel?: string;
}) {
  const t = useTranslations("opportunities") as unknown as Translate;
  const [state, formAction, pending] = useActionState(action, INITIAL);
  const keep = useKeepInput(state, formAction, (done) => Boolean(done.ok));
  const id = useId();
  const values = state.values ?? {};
  return (
    <form
      action={formAction}
      {...keep}
      noValidate
      aria-labelledby={title ? `${id}-title` : undefined}
      className={inline ? "flex flex-wrap items-end gap-8" : "flex flex-col gap-12"}
    >
      {title ? (
        <h3 id={`${id}-title`} className="m-0 text-label-13 font-semibold text-text-primary">
          {title}
        </h3>
      ) : null}
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {state.error ? (
        <InlineAlert tone="danger">
          {t(`errors.${state.error}`, { rule: state.rule ?? "" })}
        </InlineAlert>
      ) : null}
      {fields.map((field) => {
        const fieldId = `${id}-${field.name}`;
        const error = state.fieldErrors?.[field.name]
          ? t(`fieldErrors.${state.fieldErrors[field.name]}`)
          : "";
        const value = values[field.name] ?? field.defaultValue ?? "";
        switch (field.kind) {
          case "textarea":
            return (
              <Textarea
                key={field.name}
                id={fieldId}
                name={field.name}
                label={field.label}
                required={field.required}
                defaultValue={value}
                error={error}
                width="100%"
                {...(field.help ? { help: field.help } : {})}
              />
            );
          case "select":
            return (
              <Select
                key={field.name}
                id={fieldId}
                name={field.name}
                label={field.label}
                value={value}
                options={[...(field.options ?? [])]}
                error={error}
                {...(field.help ? { help: field.help } : {})}
              />
            );
          case "checkbox": {
            const box = (
              <Checkbox
                key={field.name}
                id={fieldId}
                name={field.name}
                label={field.label}
                defaultChecked={value === "true"}
                value="true"
                {...(field.disabled ? { disabled: true } : {})}
                {...(error || field.help
                  ? { "aria-describedby": error ? `${fieldId}-err` : `${fieldId}-help` }
                  : {})}
                {...(error ? { "aria-invalid": true } : {})}
              />
            );
            return error || field.help ? (
              <Field key={field.name} id={fieldId} help={field.help} error={error || undefined}>
                {box}
              </Field>
            ) : (
              box
            );
          }
          default:
            return (
              <Input
                key={field.name}
                id={fieldId}
                name={field.name}
                type={field.kind}
                label={field.label}
                required={field.required}
                defaultValue={value}
                error={error}
                {...(inline ? {} : { width: "100%" })}
                {...(field.min !== undefined ? { min: field.min } : {})}
                {...(field.max !== undefined ? { max: field.max } : {})}
                {...(field.step ? { step: field.step } : {})}
                {...(field.help ? { help: field.help } : {})}
              />
            );
        }
      })}
      <div className="flex flex-wrap items-center gap-12">
        <Button type="submit" variant={variant} loading={pending}>
          {submitLabel}
        </Button>
        {state.ok && !state.link ? (
          <p role="status" className="m-0 text-text-13 text-success-text">
            {successLabel ?? t("saved")}
          </p>
        ) : null}
      </div>
      {state.link ? (
        <div
          role="status"
          className="flex flex-col gap-4 rounded-card border border-border-subtle p-12 text-text-13"
        >
          <p className="m-0 font-medium">{t("signing.issued")}</p>
          <p className="m-0 break-all font-mono text-text-12">{state.link.url}</p>
          <p className="m-0">{t("signing.code", { code: state.link.accessCode })}</p>
          <p className="m-0 text-text-secondary">{t("signing.once")}</p>
        </div>
      ) : null}
    </form>
  );
}
