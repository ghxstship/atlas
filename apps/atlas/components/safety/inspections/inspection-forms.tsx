"use client";

import type { CanonEnumValue, InspectionItem } from "@xos/data/safety-permits";
import { Input, Select, Textarea } from "@xos/ui";
import { recordResultAction, startInspectionAction } from "@/app/[org]/safety/actions";
import { ActionForm, useCopy } from "@/components/places/kit/form";

/** Starts an inspection of a project from a template; the inspector is the person signed in. */
export function StartInspectionForm({
  org,
  projects,
  templates,
  defaultProjectId,
}: {
  org: string;
  projects: readonly { id: string; label: string }[];
  templates: readonly { id: string; name: string }[];
  defaultProjectId?: string;
}) {
  const t = useCopy("permits");
  return (
    <ActionForm
      action={startInspectionAction}
      org={org}
      submitLabel={t("inspections.start")}
      onSuccess={(state) => ({ create: undefined, peek: state.id, full: "1" })}
    >
      {(error) => (
        <>
          <Select
            id="inspection-project"
            name="projectId"
            label={t("inspections.fields.project")}
            value={defaultProjectId ?? projects[0]?.id ?? ""}
            options={projects.map((p) => ({ value: p.id, label: p.label }))}
            error={error("projectId")}
          />
          <Select
            id="inspection-template"
            name="templateId"
            label={t("inspections.fields.template")}
            value={templates[0]?.id ?? ""}
            options={templates.map((tpl) => ({ value: tpl.id, label: tpl.name }))}
            error={error("templateId")}
          />
          <Input
            id="inspection-when"
            name="inspectedAt"
            type="datetime-local"
            label={t("inspections.fields.when")}
            help={t("inspections.fields.whenHelp")}
            error={error("inspectedAt")}
          />
        </>
      )}
    </ActionForm>
  );
}

/**
 * One item of the inspection runner: a canon Inspection Result and a note. A Failed result opens
 * the punch item that corrects it (journey 17).
 */
export function ResultForm({
  org,
  inspectionId,
  item,
  n,
  values,
  current,
}: {
  org: string;
  inspectionId: string;
  item: InspectionItem;
  n: number;
  values: readonly CanonEnumValue[];
  current: { resultEnumId: string; note: string | null } | null;
}) {
  const t = useCopy("permits");
  const fallback = values.find((v) => v.isDefault)?.id ?? values[0]?.id ?? "";
  return (
    <ActionForm
      action={recordResultAction}
      org={org}
      hidden={{ inspectionId, itemId: item.id }}
      submitLabel={t("inspections.saveResult", { n })}
      successMessage={t("inspections.resultSaved")}
      className="flex flex-col gap-8"
    >
      {(error) => (
        <>
          <Select
            id={`result-${item.id}`}
            name="resultEnumId"
            label={t("inspections.fields.result", { n })}
            value={current?.resultEnumId ?? fallback}
            options={values.map((v) => ({ value: v.id, label: t(`results.${v.code}`) }))}
            error={error("resultEnumId")}
          />
          <Textarea
            id={`note-${item.id}`}
            name="note"
            rows={2}
            width="100%"
            label={t("inspections.fields.note", { n })}
            defaultValue={current?.note ?? ""}
          />
        </>
      )}
    </ActionForm>
  );
}
