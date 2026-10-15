"use client";

import { Button, Checkbox, InlineAlert, Input, Textarea } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useActionState, useEffect, useRef } from "react";
import { OutcomeAlert } from "@/components/actions/action-button";

type Translate = (key: string, values?: Record<string, string | number>) => string;

export interface FieldSpec {
  readonly name: string;
  readonly label: string;
  readonly kind?: "text" | "textarea" | "date" | "datetime-local" | "number" | "email" | "url" | "select" | "checkbox";
  readonly required?: boolean;
  readonly help?: string;
  readonly defaultValue?: string;
  readonly defaultChecked?: boolean;
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  readonly inputMode?: "text" | "decimal" | "numeric" | "email" | "url";
  readonly autoComplete?: string;
  readonly width?: number | string;
}

export interface SimpleFormState {
  readonly outcome?: string;
  /** A key under the form's `errorsNamespace`. */
  readonly fieldError?: string;
  readonly done?: boolean;
}

/**
 * One small form whose fields, labels and outcome copy come from the server page (Section 11.10:
 * at most 7 fields before More fields; errors name the field and the fix). It refreshes the page
 * after a successful save and resets when `resetOnDone` is set, so lists update in place.
 */
export function SimpleForm({
  id,
  action,
  fields,
  hidden = {},
  submitLabel,
  doneLabel,
  errorsNamespace,
  label,
  resetOnDone = false,
  variant = "primary",
}: {
  id: string;
  action: (state: SimpleFormState, form: FormData) => Promise<SimpleFormState>;
  fields: readonly FieldSpec[];
  hidden?: Readonly<Record<string, string>>;
  submitLabel: string;
  doneLabel: string;
  errorsNamespace: string;
  label: string;
  resetOnDone?: boolean;
  variant?: "primary" | "secondary";
}) {
  const te = useTranslations(errorsNamespace as never) as unknown as Translate;
  const router = useRouter();
  const ref = useRef<HTMLFormElement>(null);
  const [state, run, pending] = useActionState<SimpleFormState, FormData>(action, {});
  useEffect(() => {
    if (state.done) {
      if (resetOnDone) ref.current?.reset();
      router.refresh();
    }
  }, [state, resetOnDone, router]);
  return (
    <form ref={ref} action={run} className="flex flex-col gap-12" aria-label={label} noValidate>
      {state.fieldError ? <InlineAlert tone="danger">{te(state.fieldError)}</InlineAlert> : null}
      <OutcomeAlert outcome={state.outcome} />
      {state.done && !resetOnDone ? (
        <p role="status" className="m-0 text-text-13 text-success-text">
          {doneLabel}
        </p>
      ) : null}
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <div className="flex flex-wrap items-end gap-8">
        {fields.map((f) => {
          const fieldId = `${id}-${f.name}`;
          if (f.kind === "textarea") {
            return (
              <Textarea
                key={f.name}
                id={fieldId}
                name={f.name}
                label={f.label}
                rows={3}
                width="100%"
                required={f.required}
                defaultValue={f.defaultValue ?? ""}
                {...(f.help ? { help: f.help } : {})}
              />
            );
          }
          if (f.kind === "checkbox") {
            return <Checkbox key={f.name} id={fieldId} name={f.name} label={f.label} defaultChecked={f.defaultChecked ?? false} />;
          }
          if (f.kind === "select") {
            return (
              <label key={f.name} htmlFor={fieldId} className="flex flex-col gap-4 text-text-13">
                <span className="font-medium">{f.label}</span>
                <select
                  id={fieldId}
                  name={f.name}
                  required={f.required}
                  defaultValue={f.defaultValue ?? ""}
                  className="min-h-touch-min rounded-control border border-border-control bg-bg-surface px-8 text-text-14 text-text-primary"
                >
                  {(f.options ?? []).map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                {f.help ? <span className="text-text-12 text-text-secondary">{f.help}</span> : null}
              </label>
            );
          }
          return (
            <Input
              key={f.name}
              id={fieldId}
              name={f.name}
              label={f.label}
              type={f.kind ?? "text"}
              required={f.required}
              defaultValue={f.defaultValue ?? ""}
              {...(f.help ? { help: f.help } : {})}
              {...(f.inputMode ? { inputMode: f.inputMode } : {})}
              {...(f.autoComplete ? { autoComplete: f.autoComplete } : {})}
              {...(f.width !== undefined ? { width: f.width } : {})}
            />
          );
        })}
      </div>
      <div>
        <Button type="submit" variant={variant} size="sm" disabled={pending} aria-busy={pending}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
