import type { CustomFieldInput, CustomFieldTable } from "@xos/data/custom-fields";
import { observability } from "@/lib/observability";
import type { OrgContext } from "@/lib/shell/context";
import { saveCustomFields } from "./server";
import type { CustomFieldProblem, CustomFieldSaveResult } from "./types";
import { CUSTOM_FIELD_SHOWN, customFieldInputsOf } from "./names";

/**
 * Custom fields in a create form's server action (A117). The form's custom field inputs (`cf.<key>`, and
 * `cf.<key>.currency` for money, see names.ts) are checked before the row is created, so a required field the
 * person left blank refuses the create with nothing written, and saved right after it:
 *
 *   const custom = await customFieldsOf(ctx, "app.vendors", form);
 *   if (custom.fieldErrors) return { fieldErrors: custom.fieldErrors };
 *   ...create the row...
 *   await custom.save(created.id);
 *
 * Required is a form rule (custom_field_definitions.required: "True when forms require a value"): a create that
 * shows no custom fields at all, such as a quick-add row, is not held to it.
 */

export interface CustomFieldsStep {
  /** Problems by field key; null when the inputs can be saved. */
  readonly problems: Readonly<Record<string, CustomFieldProblem>> | null;
  /** The problems as form field errors (`cf.<key>` to the problem), for an ActionState; null when none. */
  readonly fieldErrors: Readonly<Record<string, string>> | null;
  /**
   * Writes the inputs on the new row; a no-op when the form showed no custom fields. The inputs passed the
   * checks already, so a failure here is logged and the create still stands.
   */
  readonly save: (targetId: string) => Promise<CustomFieldSaveResult>;
}

const NOTHING: CustomFieldsStep = {
  problems: null,
  fieldErrors: null,
  save: async () => ({ ok: true }),
};

/**
 * The custom fields step of a create action, from its FormData or from the inputs a typed action received
 * (`undefined` when the form showed none).
 */
export async function customFieldsOf(
  ctx: OrgContext,
  table: CustomFieldTable,
  source: FormData | Readonly<Record<string, CustomFieldInput>> | undefined,
): Promise<CustomFieldsStep> {
  if (source === undefined) return NOTHING;
  if (source instanceof FormData && source.get(CUSTOM_FIELD_SHOWN) !== "1") return NOTHING;
  const inputs = source instanceof FormData ? customFieldInputsOf(source) : source;
  // A dry run on no row checks every input without writing; the row id comes after the create.
  const checked = await saveCustomFields(ctx, {
    table,
    targetId: "",
    inputs,
    mode: "create",
    dryRun: true,
  });
  if (!checked.ok && checked.problems) {
    return {
      problems: checked.problems,
      fieldErrors: Object.fromEntries(
        Object.entries(checked.problems).map(([k, v]) => [`cf.${k}`, v]),
      ),
      save: async () => checked,
    };
  }
  return {
    problems: null,
    fieldErrors: null,
    save: async (targetId) => {
      const saved = await saveCustomFields(ctx, { table, targetId, inputs, mode: "create" });
      // The row exists by now, so the form still opens it; its custom fields section shows what is unset.
      if (!saved.ok)
        observability.logger.error("custom fields of a new row were not saved", { table, saved });
      return saved;
    },
  };
}
