"use client";

import { checkCustomFieldInputs } from "@xos/data/custom-fields";
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { loadCustomFieldFormAction } from "@/lib/custom-fields/actions";
import { CUSTOM_FIELD_SHOWN } from "@/lib/custom-fields/names";
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
  useOrgSlug,
  type CustomFieldInputs as Inputs,
} from "./controls";

/** What a typed form reads from the inputs: run the checks, then send `inputs()` with its own input. */
export interface CustomFieldInputsHandle {
  /** Checks required and malformed fields, shows the problems and focuses the first; true when all can save. */
  check(): boolean;
  /** The inputs by field key; none until the fields have loaded, so the action still holds required ones. */
  inputs(): Inputs;
}

/**
 * The org's custom fields of a table in a create form (A117): one line in the form,
 * `<CustomFieldInputs table="app.vendors" />`. The inputs load when the form opens, carry their FormData names
 * (`cf.<key>`, read by the action through `customFieldsOf`, lib/custom-fields/form.ts) and stop the form's submit
 * while a required field is blank or a value is malformed, naming the field; the action checks again before it
 * creates the row. A typed form that does not post FormData takes a `ref` and calls `check()` and `inputs()`.
 * Renders nothing when the table has no custom fields.
 */
export function CustomFieldInputs({
  table,
  idPrefix,
  ref,
}: {
  table: CustomFieldTable;
  /** Prefix of the inputs' ids, when one form shows the fields of two tables. */
  idPrefix?: string;
  ref?: Ref<CustomFieldInputsHandle>;
}) {
  const org = useOrgSlug();
  const box = useRef<HTMLDivElement>(null);
  const [form, setForm] = useState<CustomFieldForm | null>(null);
  const [inputs, setInputs] = useState<Inputs>({});
  const [problems, setProblems] = useState<Readonly<Record<string, CustomFieldProblem>>>({});
  const prefix = idPrefix ?? table.replace(/^app\./, "");

  useEffect(() => {
    let live = true;
    loadCustomFieldFormAction(org, table, null).then(
      (loaded) => {
        if (live) setForm(loaded);
      },
      () => {
        // The form still submits; the action reports any required field it misses.
        if (live) setForm(null);
      },
    );
    return () => {
      live = false;
    };
  }, [org, table]);

  const check = useCallback((): boolean => {
    if (!form || form.fields.length === 0) return true;
    const result = checkCustomFieldInputs(
      form.fields,
      effectiveInputs(form, inputs),
      "create",
      parseContextOf(form),
    );
    setProblems(result.problems);
    const first = form.fields.find((f) => result.problems[f.key]);
    if (first) document.getElementById(`${prefix}-cf-${first.key}`)?.focus();
    return first === undefined;
  }, [form, inputs, prefix]);

  useImperativeHandle(
    ref,
    () => ({ check, inputs: () => (form ? effectiveInputs(form, inputs) : {}) }),
    [check, form, inputs],
  );

  // The form's own submit is stopped while a field has a problem, before React's action sees it.
  useEffect(() => {
    const element = box.current?.closest("form");
    if (!element) return;
    const onSubmit = (event: SubmitEvent) => {
      if (check()) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const onReset = () => {
      setInputs({});
      setProblems({});
    };
    element.addEventListener("submit", onSubmit);
    element.addEventListener("reset", onReset);
    return () => {
      element.removeEventListener("submit", onSubmit);
      element.removeEventListener("reset", onReset);
    };
  }, [check]);

  const onInput = (key: string, input: CustomFieldInput) => {
    setInputs((current) => ({ ...current, [key]: input }));
    setProblems((current) =>
      current[key]
        ? Object.fromEntries(Object.entries(current).filter(([k]) => k !== key))
        : current,
    );
  };

  return (
    <div ref={box} className="contents">
      <input type="hidden" name={CUSTOM_FIELD_SHOWN} value="1" />
      {form && form.fields.length > 0 ? (
        <CustomFieldControls
          form={form}
          inputs={inputs}
          problems={problems}
          onInput={onInput}
          idPrefix={prefix}
          named
        />
      ) : null}
    </div>
  );
}
