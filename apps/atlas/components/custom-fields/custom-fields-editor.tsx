"use client";

import { checkCustomFieldInputs } from "@xos/data/custom-fields";
import { Button, InlineAlert } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { loadCustomFieldFormAction, saveCustomFieldsAction } from "@/lib/custom-fields/actions";
import type {
  CustomFieldForm,
  CustomFieldInput,
  CustomFieldProblem,
  CustomFieldTable,
} from "@/lib/custom-fields/types";
import {
  CustomFieldControls,
  effectiveInputs,
  parseContextOf,
  type CustomFieldInputs,
} from "./controls";

/** Copy lookups take built keys (`errors.denied`), so the catalog type is widened. */
type Translate = (key: string, values?: Record<string, string | number>) => string;

/** Refusals and errors the section explains in words; anything else reads as the general refusal. */
const EXPLAINED = new Set(["custom_value_required", "denied", "invalid", "unexpected"]);

/**
 * A row's custom fields as inputs with Save and Cancel (A117), from custom-fields-section.tsx. Saving
 * checks required and malformed fields first, then writes through saveCustomFieldsAction, which
 * checks them again and leaves the database's refusals by rule.
 */
export function CustomFieldsEditor({
  org,
  table,
  id,
  form,
  idPrefix,
  onCancel,
  onSaved,
}: {
  org: string;
  table: CustomFieldTable;
  id: string;
  form: CustomFieldForm;
  idPrefix: string;
  onCancel: () => void;
  /** After a save, with the fields read again, or null when that read found none. */
  onSaved: (fresh: CustomFieldForm | null) => void;
}) {
  const t = useTranslations("platform.customFields") as unknown as Translate;
  const [inputs, setInputs] = useState<CustomFieldInputs>(form.inputs);
  const [problems, setProblems] = useState<Readonly<Record<string, CustomFieldProblem>>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const save = () => {
    // Every field is sent, so a required one left blank is caught here and by the server.
    const all: Record<string, CustomFieldInput> = {};
    for (const field of form.fields) all[field.key] = inputs[field.key] ?? { value: "" };
    const sent = effectiveInputs(form, all);
    const checked = checkCustomFieldInputs(form.fields, sent, "update", parseContextOf(form));
    setProblems(checked.problems);
    const first = form.fields.find((f) => checked.problems[f.key]);
    if (first) {
      document.getElementById(`${idPrefix}-cf-${first.key}`)?.focus();
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await saveCustomFieldsAction(org, table, id, sent, "update");
      if (!result.ok) {
        if (result.problems) setProblems(result.problems);
        const key = result.problems
          ? "invalid"
          : result.error && EXPLAINED.has(result.error)
            ? result.error
            : "refused";
        setError(t(`errors.${key}`));
        return;
      }
      onSaved(await loadCustomFieldFormAction(org, table, id));
    });
  };

  return (
    <form
      className="flex flex-col gap-12"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
      <CustomFieldControls
        form={form}
        inputs={inputs}
        problems={problems}
        onInput={(key, input) => setInputs((current) => ({ ...current, [key]: input }))}
        idPrefix={idPrefix}
        disabled={pending}
      />
      <div className="flex flex-wrap items-center gap-8">
        <Button type="submit" size="sm" variant="primary" loading={pending}>
          {t("save")}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          {t("cancel")}
        </Button>
      </div>
    </form>
  );
}
