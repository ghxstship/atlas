"use client";

import { Input, Select } from "@xos/ui";
import { useTranslations } from "next-intl";
import { usePathname } from "next/navigation";
import type {
  CustomField,
  CustomFieldForm,
  CustomFieldInput,
  CustomFieldProblem,
} from "@/lib/custom-fields/types";
import { customFieldCurrencyName, customFieldInputName } from "@/lib/custom-fields/names";

/**
 * The inputs of a table's custom fields (A117), one per field in form order, each the control its data type
 * takes: text, email and URL fields, decimals for Number, an amount and currency for Money, a date, a date and
 * time in the org's zone for Timestamp, and lists for Boolean, Choice and Person with a Not set entry. With
 * `named`, each input carries its FormData name (`cf.<key>`), so a server action receives it.
 */

export type CustomFieldInputs = Readonly<Record<string, CustomFieldInput>>;

/** Copy lookups take built keys (`problems.required`), so the catalog type is widened. */
type Translate = (key: string, values?: Record<string, string | number>) => string;

/** The org slug of an Atlas page: the first path segment. */
export function useOrgSlug(): string {
  return usePathname().split("/").filter(Boolean)[0] ?? "";
}

/** The inputs as they will be saved: a money amount without a chosen currency takes the default one. */
export function effectiveInputs(
  form: CustomFieldForm,
  inputs: CustomFieldInputs,
): CustomFieldInputs {
  const out: Record<string, CustomFieldInput> = {};
  for (const field of form.fields) {
    const input = inputs[field.key];
    if (!input) continue;
    out[field.key] =
      field.dataType === "Money" && input.value.trim() !== "" && !input.currency
        ? { value: input.value, currency: form.defaultCurrency }
        : input;
  }
  return out;
}

/** The parse context of a form's checks, from what the server sent with it. */
export function parseContextOf(form: CustomFieldForm) {
  return {
    timeZone: form.timeZone,
    exponents: new Map(form.currencies.map((c) => [c.code, c.exponent])),
  };
}

export function CustomFieldControls({
  form,
  inputs,
  problems,
  onInput,
  idPrefix,
  named = false,
  disabled = false,
}: {
  form: CustomFieldForm;
  inputs: CustomFieldInputs;
  problems: Readonly<Record<string, CustomFieldProblem>>;
  onInput: (key: string, input: CustomFieldInput) => void;
  idPrefix: string;
  named?: boolean;
  disabled?: boolean;
}) {
  const t = useTranslations("platform.customFields") as unknown as Translate;
  return (
    <>
      {form.fields.map((field) => (
        <Control
          key={field.id}
          field={field}
          form={form}
          input={inputs[field.key] ?? { value: "" }}
          error={
            problems[field.key] ? t(`problems.${problems[field.key]}`, { label: field.label }) : ""
          }
          onInput={(input) => onInput(field.key, input)}
          id={`${idPrefix}-cf-${field.key}`}
          named={named}
          disabled={disabled}
        />
      ))}
    </>
  );
}

function Control({
  field,
  form,
  input,
  error,
  onInput,
  id,
  named,
  disabled,
}: {
  field: CustomField;
  form: CustomFieldForm;
  input: CustomFieldInput;
  error: string;
  onInput: (input: CustomFieldInput) => void;
  id: string;
  named: boolean;
  disabled: boolean;
}) {
  const t = useTranslations("platform.customFields");
  const name = named ? customFieldInputName(field.key) : undefined;
  const required = field.required ? t("requiredHelp") : undefined;
  const notSet = { value: "", label: t("notSet") };
  const list = (options: { value: string; label: string }[]) => (
    <Select
      id={id}
      {...(name ? { name } : {})}
      label={field.label}
      value={input.value}
      options={[notSet, ...options]}
      disabled={disabled}
      {...(required ? { help: required } : {})}
      error={error}
      onChange={(e) => onInput({ value: e.target.value })}
    />
  );
  const text = (type: string, extra: { inputMode?: "decimal"; help?: string } = {}) => (
    <Input
      id={id}
      name={name}
      type={type}
      label={field.label}
      width="100%"
      value={input.value}
      required={field.required}
      disabled={disabled}
      maxLength={field.dataType === "Text" ? 10_000 : undefined}
      {...(extra.inputMode ? { inputMode: extra.inputMode } : {})}
      {...(extra.help || required
        ? { help: [required, extra.help].filter(Boolean).join(" ") }
        : {})}
      error={error}
      onChange={(e) => onInput({ ...input, value: e.target.value })}
    />
  );
  switch (field.dataType) {
    case "Choice":
      return list(field.choices.map((c) => ({ value: c.key, label: c.label })));
    case "Person":
      return list(form.people.map((p) => ({ value: p.id, label: p.name })));
    case "Boolean":
      return list([
        { value: "true", label: t("yes") },
        { value: "false", label: t("no") },
      ]);
    case "Money": {
      const currency = input.currency ?? form.defaultCurrency;
      return (
        <div className="flex flex-wrap items-start gap-8">
          <div className="min-w-0 flex-1">{text("text", { inputMode: "decimal" })}</div>
          <Select
            id={`${id}-currency`}
            {...(named ? { name: customFieldCurrencyName(field.key) } : {})}
            label={t("currency", { label: field.label })}
            value={currency}
            options={form.currencies.map((c) => ({ value: c.code, label: c.code }))}
            disabled={disabled}
            onChange={(e) => onInput({ value: input.value, currency: e.target.value })}
          />
        </div>
      );
    }
    case "Number":
      return text("text", { inputMode: "decimal" });
    case "Date":
      return text("date");
    case "Timestamp":
      return text("datetime-local", { help: t("timeZone", { zone: form.timeZone }) });
    case "Email":
      return text("email");
    case "URL":
      return text("url", { help: t("urlHelp") });
    default:
      return text("text");
  }
}
