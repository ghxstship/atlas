import type { CustomFieldInput } from "@xos/data/custom-fields";

/**
 * How custom field inputs are named in a form's FormData (A117): `cf.<key>` holds a field's text and
 * `cf.<key>.currency` a money field's currency; `cf:shown` says the form showed its custom fields, so the action
 * holds it to required ones (form.ts). The same `cf.` prefix names custom field filters in a query string
 * (lib/views/conditions.ts), where a form never sends them.
 */

export const CUSTOM_FIELD_SHOWN = "cf:shown";

export function customFieldInputName(key: string): string {
  return `cf.${key}`;
}

export function customFieldCurrencyName(key: string): string {
  return `cf.${key}.currency`;
}

/** A form's custom field inputs by field key. */
export function customFieldInputsOf(form: FormData): Record<string, CustomFieldInput> {
  const inputs: Record<string, CustomFieldInput> = {};
  for (const [name, value] of form.entries()) {
    const match = /^cf\.([a-z][a-z0-9_]{0,47})$/.exec(name);
    if (!match?.[1] || typeof value !== "string") continue;
    const currency = form.get(customFieldCurrencyName(match[1]));
    inputs[match[1]] = typeof currency === "string" ? { value, currency } : { value };
  }
  return inputs;
}
