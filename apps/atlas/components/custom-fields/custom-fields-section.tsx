"use client";

import { checkCustomFieldInputs } from "@xos/data/custom-fields";
import { Button, InlineAlert, PropertyList } from "@xos/ui";
import { useFormatter, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
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
  useOrgSlug,
  type CustomFieldInputs,
} from "./controls";
import { formatCustomFieldValue } from "./format";

/** Copy lookups take built keys (`errors.denied`), so the catalog type is widened. */
type Translate = (key: string, values?: Record<string, string | number>) => string;

/** Refusals and errors the section explains in words; anything else reads as the general refusal. */
const EXPLAINED = new Set(["custom_value_required", "denied", "invalid", "unexpected"]);

/**
 * A row's custom fields on its record page and peek (A117): the org's fields of the table with their values, and
 * for a Collaborator or higher an Edit that turns them into inputs with Save and Cancel. Saving checks required
 * and malformed fields first, then writes through saveCustomFieldsAction, which checks them again and leaves the
 * database's refusals by rule. Renders nothing when the table has no custom fields.
 *
 * `initial` comes from the server panel (custom-fields-panel.tsx); a client-rendered peek leaves it out and the
 * section loads its fields itself.
 */
export function CustomFieldsSection({
  table,
  id,
  initial,
  editable = true,
}: {
  table: CustomFieldTable;
  id: string;
  initial?: CustomFieldForm | null;
  /** False on a surface that shows values only. */
  editable?: boolean;
}) {
  const t = useTranslations("platform.customFields") as unknown as Translate;
  const format = useFormatter();
  const router = useRouter();
  const org = useOrgSlug();
  const [loaded, setLoaded] = useState<CustomFieldForm | null>(null);
  const [editing, setEditing] = useState(false);
  const [inputs, setInputs] = useState<CustomFieldInputs>({});
  const [problems, setProblems] = useState<Readonly<Record<string, CustomFieldProblem>>>({});
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [pending, startTransition] = useTransition();
  const form = loaded ?? initial ?? null;

  useEffect(() => {
    if (initial !== undefined) return;
    let live = true;
    loadCustomFieldFormAction(org, table, id).then(
      (next) => {
        if (live) setLoaded(next);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [org, table, id, initial]);

  if (!form || form.fields.length === 0) return null;
  const headingId = `custom-fields-${id}`;
  const context = {
    format,
    yes: t("yes"),
    no: t("no"),
    someone: t("someone"),
    people: Object.fromEntries(form.people.map((p) => [p.id, p.name])),
    timeZone: form.timeZone,
  };

  const startEditing = () => {
    setInputs(form.inputs);
    setProblems({});
    setError(null);
    setStatus("");
    setEditing(true);
  };

  const save = () => {
    // Every field is sent, so a required one left blank is caught here and by the server.
    const all: Record<string, CustomFieldInput> = {};
    for (const field of form.fields) all[field.key] = inputs[field.key] ?? { value: "" };
    const sent = effectiveInputs(form, all);
    const checked = checkCustomFieldInputs(form.fields, sent, "update", parseContextOf(form));
    setProblems(checked.problems);
    const first = form.fields.find((f) => checked.problems[f.key]);
    if (first) {
      document.getElementById(`${headingId}-cf-${first.key}`)?.focus();
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
      const fresh = await loadCustomFieldFormAction(org, table, id);
      if (fresh) setLoaded(fresh);
      setEditing(false);
      setStatus(t("saved"));
      router.refresh();
    });
  };

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center justify-between gap-8">
        <h3 id={headingId} className="m-0 text-label-13 font-semibold">
          {t(table === "app.counterparties" ? "companyTitle" : "title")}
        </h3>
        {editable && form.canWrite && !editing ? (
          <Button size="sm" variant="ghost" icon="Pencil" onClick={startEditing}>
            {t("edit")}
          </Button>
        ) : null}
      </div>
      {editing ? (
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
            idPrefix={headingId}
            disabled={pending}
          />
          <div className="flex flex-wrap items-center gap-8">
            <Button type="submit" size="sm" variant="primary" loading={pending}>
              {t("save")}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
              {t("cancel")}
            </Button>
          </div>
        </form>
      ) : (
        <PropertyList
          items={form.fields.map((field) => {
            const value = form.values[field.key];
            return {
              label: field.label,
              value: value ? formatCustomFieldValue(field, value, context) : t("notSet"),
            };
          })}
        />
      )}
      <p role="status" className="sr-only">
        {status}
      </p>
    </section>
  );
}
