"use client";

import { Button, PropertyList } from "@xos/ui";
import { useFormatter, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { loadCustomFieldFormAction } from "@/lib/custom-fields/actions";
import type { CustomFieldForm, CustomFieldTable } from "@/lib/custom-fields/types";
import { onDemand, useOnDemand } from "@/components/shell/on-demand";
import { formatCustomFieldValue } from "./format";
import { useOrgSlug } from "./org-slug";

/** Copy lookups take built keys (`errors.denied`), so the catalog type is widened. */
type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * The inputs and their checks load with Edit (custom-fields-editor.tsx). The press is held in
 * `editing`, so a press before the code arrives still opens the editor (ADR 0027).
 */
const editor = onDemand(() => import("./custom-fields-editor"));
const prepareEditor = () => void editor.load().catch(() => undefined);

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
  const editorModule = useOnDemand(editor, editing);
  const [status, setStatus] = useState("");
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
    setStatus("");
    setEditing(true);
  };

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center justify-between gap-8">
        <h3 id={headingId} className="m-0 text-label-13 font-semibold">
          {t(table === "app.counterparties" ? "companyTitle" : "title")}
        </h3>
        {editable && form.canWrite && !editing ? (
          <Button
            size="sm"
            variant="ghost"
            icon="Pencil"
            onPointerEnter={prepareEditor}
            onFocus={prepareEditor}
            onClick={startEditing}
          >
            {t("edit")}
          </Button>
        ) : null}
      </div>
      {editing && editorModule ? (
        <editorModule.CustomFieldsEditor
          org={org}
          table={table}
          id={id}
          form={form}
          idPrefix={headingId}
          onCancel={() => setEditing(false)}
          onSaved={(fresh) => {
            if (fresh) setLoaded(fresh);
            setEditing(false);
            setStatus(t("saved"));
            router.refresh();
          }}
        />
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
