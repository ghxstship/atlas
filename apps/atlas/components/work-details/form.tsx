"use client";

import { Accordion, Button, Checkbox, InlineAlert, Input, Select, Textarea } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useActionState, useId } from "react";
import { useKeepInput } from "@/components/collection-kit/keep-input";
import type { WorkDetailsFormState } from "@/lib/work-details/actions";

/**
 * One declarative form for every Work Details write (Section 4.5.6 item 10). Server panels
 * describe the fields; the server action validates, writes as the viewer and answers with a
 * `workDetails.errors.*` key. A group of choices sits in a disclosure so a form shows at most seven
 * fields before it is opened (gate 27). Buttons are secondary: the page's registry section owns the
 * one primary action.
 */

type Translate = (key: string, values?: Record<string, string | number>) => string;
type FormAction = (state: WorkDetailsFormState, form: FormData) => Promise<WorkDetailsFormState>;

export interface ChoiceOption {
  readonly value: string;
  readonly label: string;
  readonly checked: boolean;
}

export type WorkDetailsField =
  | {
      readonly kind: "text" | "email" | "tel" | "date";
      readonly name: string;
      readonly label: string;
      readonly help?: string;
      readonly defaultValue?: string;
      readonly width?: number | string;
      readonly autoComplete?: string;
    }
  | {
      readonly kind: "textarea";
      readonly name: string;
      readonly label: string;
      readonly help?: string;
      readonly defaultValue?: string;
    }
  | {
      readonly kind: "select";
      readonly name: string;
      readonly label: string;
      readonly defaultValue: string;
      readonly options: readonly { readonly value: string; readonly label: string }[];
    }
  | {
      /** Checkboxes sharing one name, collapsed under a summary. */
      readonly kind: "choices";
      readonly name: string;
      readonly label: string;
      readonly summary: string;
      readonly open?: boolean;
      readonly options: readonly ChoiceOption[];
    };

const INITIAL: WorkDetailsFormState = {};

export function WorkDetailsForm({
  action,
  hidden,
  fields,
  submitLabel,
  label,
  resetOnSuccess = false,
  inline = false,
}: {
  action: FormAction;
  hidden: Readonly<Record<string, string>>;
  fields: readonly WorkDetailsField[];
  submitLabel: string;
  label: string;
  resetOnSuccess?: boolean;
  inline?: boolean;
}) {
  const t = useTranslations("workDetails") as unknown as Translate;
  const [state, dispatch, pending] = useActionState(action, INITIAL);
  const keep = useKeepInput(state, dispatch, (s) => resetOnSuccess && s.ok === true);
  const id = useId();
  const fieldError = (name: string) => {
    const code = state.fieldErrors?.[name];
    return code ? t(`errors.${code}`) : undefined;
  };
  const render = (f: WorkDetailsField) => {
    const fieldId = `${id}-${f.name}`;
    const error = fieldError(f.name);
    switch (f.kind) {
      case "select":
        return (
          <Select
            key={f.name}
            id={fieldId}
            name={f.name}
            label={f.label}
            value={f.defaultValue}
            options={[...f.options]}
            {...(error ? { error } : {})}
          />
        );
      case "textarea":
        return (
          <Textarea
            key={f.name}
            id={fieldId}
            name={f.name}
            label={f.label}
            rows={2}
            width="100%"
            defaultValue={f.defaultValue ?? ""}
            {...(f.help ? { help: f.help } : {})}
            {...(error ? { error } : {})}
          />
        );
      case "choices":
        return (
          <div key={f.name} className="w-full">
            <Accordion
              keepMounted
              items={[
                {
                  title: f.label,
                  meta: f.summary,
                  open: f.open ?? false,
                  content: (
                    <fieldset className="m-0 flex flex-wrap gap-x-16 gap-y-8 border-0 p-0 text-text-primary">
                      <legend className="sr-only">{f.label}</legend>
                      {f.options.map((o) => (
                        <Checkbox
                          key={o.value}
                          name={f.name}
                          value={o.value}
                          label={o.label}
                          defaultChecked={o.checked}
                        />
                      ))}
                    </fieldset>
                  ),
                },
              ]}
            />
          </div>
        );
      default:
        return (
          <Input
            key={f.name}
            id={fieldId}
            name={f.name}
            type={f.kind}
            label={f.label}
            defaultValue={f.defaultValue ?? ""}
            {...(f.width !== undefined ? { width: f.width } : {})}
            {...(f.help ? { help: f.help } : {})}
            {...(f.autoComplete ? { autoComplete: f.autoComplete } : {})}
            {...(error ? { error } : {})}
          />
        );
    }
  };
  return (
    <form
      action={dispatch}
      {...keep}
      noValidate
      aria-label={label}
      className={inline ? "flex flex-wrap items-end gap-8" : "flex flex-col gap-12"}
    >
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {state.error ? <InlineAlert tone="danger">{t(`errors.${state.error}`)}</InlineAlert> : null}
      {state.ok ? (
        <p role="status" className="m-0 text-text-13 text-success-text">
          {t("saved")}
        </p>
      ) : null}
      {state.revealed ? (
        <p role="status" className="m-0 text-text-13">
          {t("passport.revealed", { number: state.revealed })}
        </p>
      ) : null}
      {fields.length > 0 ? (
        <div className="flex flex-wrap items-end gap-12">{fields.map(render)}</div>
      ) : null}
      <div>
        <Button type="submit" size={inline ? "sm" : "md"} variant="secondary" loading={pending}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
