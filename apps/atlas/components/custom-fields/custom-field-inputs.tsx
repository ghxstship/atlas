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
  /**
   * Checks required and malformed fields, shows the problems and focuses the first; true when all can save.
   * False while the fields still load: the check runs again when they arrive.
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
  const [loading, setLoading] = useState(true);
  // A submit while the fields still load is held: it goes ahead once they arrive, or their problems show.
  const waiting = useRef(false);
  const prefix = idPrefix ?? table.replace(/^app\./, "");

  /** Shows the problems of these inputs and focuses the first field that has one; true when none. */
  const report = useCallback(
    (loaded: CustomFieldForm, current: Inputs): boolean => {
      const result = checkCustomFieldInputs(
        loaded.fields,
        effectiveInputs(loaded, current),
        "create",
        parseContextOf(loaded),
      );
      setProblems(result.problems);
      const first = loaded.fields.find((f) => result.problems[f.key]);
      // After the render that draws the problem, so the field exists when it takes focus.
      if (first) setTimeout(() => document.getElementById(`${prefix}-cf-${first.key}`)?.focus(), 0);
      return first === undefined;
    },
    [prefix],
  );

  useEffect(() => {
    let live = true;
    const resubmit = () => setTimeout(() => box.current?.closest("form")?.requestSubmit(), 0);
    loadCustomFieldFormAction(org, table, null).then(
      (loaded) => {
        if (!live) return;
        setForm(loaded);
        setLoading(false);
        const held = waiting.current;
        waiting.current = false;
        // A held submit goes ahead when nothing is missing, else the problems show.
        if (held && (!loaded || loaded.fields.length === 0 || report(loaded, {}))) resubmit();
      },
      () => {
        // The form still submits; the action reports any required field it misses.
        if (!live) return;
        setForm(null);
        setLoading(false);
        if (waiting.current) resubmit();
        waiting.current = false;
      },
    );
    return () => {
      live = false;
    };
  }, [org, table, report]);

  const check = useCallback((): boolean => {
    if (loading) {
      waiting.current = true;
      return false;
    }
    if (!form || form.fields.length === 0) return true;
    return report(form, inputs);
  }, [loading, form, inputs, report]);

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
