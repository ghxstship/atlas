"use client";

import { checkCustomFieldInputs } from "@xos/data/custom-fields";
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { loadCustomFieldFormAction } from "@/lib/custom-fields/actions";
import type {
  CustomField,
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
  /** With `pageSize`, how many pages the fields take; 1 otherwise and until they load. */
  pageCount(): number;
  /** With `pageSize`, the page of the first field the last `check()` found a problem with; null when none. */
  problemPage(): number | null;
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
  page = 0,
  pageSize,
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
  /** Which page shows, with `pageSize`. The others stay mounted and hidden, so their named inputs still post. */
  page?: number;
  /** At most this many visible controls on a page, required fields first (gate 27). All on one page when absent. */
  pageSize?: number;
  ref?: Ref<CustomFieldInputsHandle>;
}) {
  const org = useOrgSlug();
  const box = useRef<HTMLDivElement>(null);
  const [form, setForm] = useState<CustomFieldForm | null>(null);
  const [inputs, setInputs] = useState<Inputs>({});
  const [problems, setProblems] = useState<Readonly<Record<string, CustomFieldProblem>>>({});
  // The submit check runs from a DOM listener and a parent's ref, between renders, so it reads these refs,
  // which change together with the state above, never a stale render's values.
  const current = useRef<{
    loading: boolean;
    form: CustomFieldForm | null;
    inputs: Inputs;
    problem: string | null;
  }>({
    loading: true,
    form: null,
    inputs: {},
    problem: null,
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
    current.current = { ...current.current, problem: first?.key ?? null };
    // After the render that draws the problem, so the field exists when it takes focus.
    if (first) setTimeout(() => document.getElementById(`${prefix}-cf-${first.key}`)?.focus(), 0);
    return first === undefined;
  }, [prefix]);

  const shownKeys = fieldKeys?.join("\u0000");
  const paged = pageSize !== undefined;
  const requiredKeyList = requiredKeys?.join("\u0000");
  useEffect(() => {
    let live = true;
    const shown = shownKeys === undefined ? null : new Set(shownKeys.split("\u0000"));
    const required = new Set(requiredKeyList ? requiredKeyList.split("\u0000") : []);
    const shownOrder = shownKeys === undefined ? [] : shownKeys.split("\u0000");
    const settle = (full: CustomFieldForm | null) => {
      if (!live) return;
      const narrowed = full ? narrowForm(full, shown, required) : null;
      const loaded =
        narrowed && paged
          ? { ...narrowed, fields: requiredFirst(narrowed.fields, shownOrder) }
          : narrowed;
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
  }, [org, table, shownKeys, requiredKeyList, paged]);

  useImperativeHandle(
    ref,
    () => ({
      check,
      inputs: () => {
        const { form: loaded, inputs: typed } = current.current;
        return loaded ? effectiveInputs(loaded, typed) : {};
      },
      pageCount: () => {
        const { form: loaded } = current.current;
        return loaded && pageSize ? Math.max(1, fieldPages(loaded.fields, pageSize).length) : 1;
      },
      problemPage: () => {
        const { form: loaded, problem } = current.current;
        if (!loaded || !problem) return null;
        if (!pageSize) return 0;
        const at = fieldPages(loaded.fields, pageSize).findIndex((p) =>
          p.some((f) => f.key === problem),
        );
        return at < 0 ? null : at;
      },
    }),
    [check, pageSize],
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

  const controls = (fields: CustomFieldForm["fields"]) =>
    form ? (
      <CustomFieldControls
        form={{ ...form, fields }}
        inputs={inputs}
        problems={problems}
        onInput={onInput}
        idPrefix={prefix}
        named
      />
    ) : null;
  return (
    <div ref={box} className="contents">
      {form && form.fields.length > 0
        ? pageSize
          ? fieldPages(form.fields, pageSize).map((fields, at) => (
              <div key={at} hidden={at !== page} className="flex flex-col gap-12">
                {controls(fields)}
              </div>
            ))
          : controls(form.fields)
        : null}
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

/**
 * Required fields first, each group in the given order (an event type's own sort order); fields it does not list keep
 * their form order after those.
 */
export function requiredFirst(
  fields: CustomFieldForm["fields"],
  order: readonly string[],
): CustomFieldForm["fields"] {
  const rank = (key: string) => {
    const at = order.indexOf(key);
    return at < 0 ? order.length : at;
  };
  return [...fields].sort(
    (a, b) => Number(b.required) - Number(a.required) || rank(a.key) - rank(b.key),
  );
}

/**
 * Splits fields into pages of at most `size` visible controls (gate 27 counts controls, and a Money field shows an
 * amount and a currency), in order.
 */
export function fieldPages(
  fields: CustomFieldForm["fields"],
  size: number,
): CustomFieldForm["fields"][] {
  const pages: CustomField[][] = [];
  let used = 0;
  for (const field of fields) {
    const weight = field.dataType === "Money" ? 2 : 1;
    const last = pages[pages.length - 1];
    if (!last || used + weight > size) {
      pages.push([field]);
      used = weight;
    } else {
      last.push(field);
      used += weight;
    }
  }
  return pages;
}
