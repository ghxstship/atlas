"use client";

import { checkCustomFieldInputs } from "@xos/data/custom-fields";
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { loadCustomFieldFormAction } from "@/lib/custom-fields/actions";
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
  /**
   * Checks required and malformed fields, shows the problems and focuses the first; true when all can save.
   * True while the fields still load, when only the action can judge the inputs.
   */
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
  fieldKeys,
  requiredKeys,
  ref,
}: {
  table: CustomFieldTable;
  /** Prefix of the inputs' ids, when one form shows the fields of two tables. */
  idPrefix?: string;
  /**
   * Only these fields, plus every field the org marked required, so the required check is never hidden (B14: an event
   * type's field set at intake). All fields when absent.
   */
  fieldKeys?: readonly string[];
  /** Fields this form requires beyond their own required flag, marked and checked as required. */
  requiredKeys?: readonly string[];
  ref?: Ref<CustomFieldInputsHandle>;
}) {
  const org = useOrgSlug();
  const box = useRef<HTMLDivElement>(null);
  const [form, setForm] = useState<CustomFieldForm | null>(null);
  const [inputs, setInputs] = useState<Inputs>({});
  const [problems, setProblems] = useState<Readonly<Record<string, CustomFieldProblem>>>({});
  // The submit check runs from a DOM listener and a parent's ref, between renders, so it reads these refs,
  // which change together with the state above, never a stale render's values.
  const current = useRef<{ loading: boolean; form: CustomFieldForm | null; inputs: Inputs }>({
    loading: true,
    form: null,
    inputs: {},
  });
  const prefix = idPrefix ?? table.replace(/^app\./, "");

  /** Shows the problems of the inputs and focuses the first field that has one; true when none. */
  const check = useCallback((): boolean => {
    const { loading, form: loaded, inputs: typed } = current.current;
    // Before the fields arrive the browser knows of no problem; the action checks the inputs on its own.
    if (loading || !loaded || loaded.fields.length === 0) return true;
    const result = checkCustomFieldInputs(
      loaded.fields,
      effectiveInputs(loaded, typed),
      "create",
      parseContextOf(loaded),
    );
    setProblems(result.problems);
    const first = loaded.fields.find((f) => result.problems[f.key]);
    // After the render that draws the problem, so the field exists when it takes focus.
    if (first) setTimeout(() => document.getElementById(`${prefix}-cf-${first.key}`)?.focus(), 0);
    return first === undefined;
  }, [prefix]);

  const shownKeys = fieldKeys?.join("\u0000");
  const requiredKeyList = requiredKeys?.join("\u0000");
  useEffect(() => {
    let live = true;
    const shown = shownKeys === undefined ? null : new Set(shownKeys.split("\u0000"));
    const required = new Set(requiredKeyList ? requiredKeyList.split("\u0000") : []);
    const settle = (full: CustomFieldForm | null) => {
      if (!live) return;
      const loaded = full ? narrowForm(full, shown, required) : null;
      current.current = { ...current.current, loading: false, form: loaded };
      setForm(loaded);
    };
    loadCustomFieldFormAction(org, table, null).then(settle, () => {
      // The form still submits; the action reports any required field it misses.
      settle(null);
    });
    return () => {
      live = false;
    };
  }, [org, table, shownKeys, requiredKeyList]);

  useImperativeHandle(
    ref,
    () => ({
      check,
      inputs: () => {
        const { form: loaded, inputs: typed } = current.current;
        return loaded ? effectiveInputs(loaded, typed) : {};
      },
    }),
    [check],
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
      current.current = { ...current.current, inputs: {} };
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
    const next = { ...current.current.inputs, [key]: input };
    current.current = { ...current.current, inputs: next };
    setInputs(next);
    setProblems((shown) =>
      shown[key] ? Object.fromEntries(Object.entries(shown).filter(([k]) => k !== key)) : shown,
    );
  };

  return (
    <div ref={box} className="contents">
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

/** The form with only the shown fields (and every required one), the extra required keys marked required. */
export function narrowForm(
  form: CustomFieldForm,
  shown: ReadonlySet<string> | null,
  required: ReadonlySet<string>,
): CustomFieldForm {
  return {
    ...form,
    fields: form.fields
      .filter((f) => shown === null || shown.has(f.key) || f.required || required.has(f.key))
      .map((f) => (required.has(f.key) && !f.required ? { ...f, required: true } : f)),
  };
}
