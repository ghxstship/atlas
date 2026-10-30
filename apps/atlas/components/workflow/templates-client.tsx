"use client";

import { Input, Select, Textarea } from "@xos/ui";
import type { Route } from "next";
import Link from "next/link";
import { useState } from "react";
import {
  addItemAction,
  applyTemplateAction,
  createTemplateAction,
  deleteTemplateAction,
  newDraftAction,
  publishAction,
  removeItemAction,
  saveProjectAsTemplateAction,
  updateVersionAction,
} from "@/app/[org]/projects/templates/actions";
import type { WorkflowActionState } from "@/lib/workflow/state";
import { ActionForm, useWorkflowT } from "./kit";
import type { Database } from "@xos/data/database.types";

export interface Choice {
  readonly value: string;
  readonly label: string;
}

/** Project defaults shared by the create and draft forms. */
function Defaults({
  zones,
  currencies,
  initial,
}: {
  zones: readonly string[];
  currencies: readonly string[];
  initial?: { timeZone: string | null; currency: string | null; durationDays: number | null };
}) {
  const t = useWorkflowT();
  const [zone, setZone] = useState(initial?.timeZone ?? "");
  const [currency, setCurrency] = useState(initial?.currency ?? "");
  return (
    <div className="grid grid-cols-3 gap-8 max-md:grid-cols-1">
      <input type="hidden" name="timeZone" value={zone} />
      <input type="hidden" name="currency" value={currency} />
      <Select
        label={t("templates.fields.timeZone")}
        help={t("templates.fields.timeZoneHelp")}
        value={zone}
        options={[
          { value: "", label: t("templates.fields.notSet") },
          ...zones.map((z) => ({ value: z, label: z })),
        ]}
        onChange={(e) => setZone(e.target.value)}
      />
      <Select
        label={t("templates.fields.currency")}
        value={currency}
        options={[
          { value: "", label: t("templates.fields.notSet") },
          ...currencies.map((c) => ({ value: c, label: c })),
        ]}
        onChange={(e) => setCurrency(e.target.value)}
      />
      <Input
        name="durationDays"
        type="number"
        min={1}
        max={3660}
        label={t("templates.fields.durationDays")}
        help={t("templates.fields.durationDaysHelp")}
        defaultValue={initial?.durationDays ?? ""}
        width="100%"
      />
    </div>
  );
}

/**
 * Create template is the page's primary action until a template is open; then applying it is, and
 * this form steps back to secondary, so the page keeps one primary action (A59-029).
 */
export function CreateTemplateForm({
  org,
  zones,
  currencies,
  primary = true,
}: {
  org: string;
  zones: readonly string[];
  currencies: readonly string[];
  primary?: boolean;
}) {
  const t = useWorkflowT();
  return (
    <ActionForm
      action={createTemplateAction}
      hidden={{ org }}
      label={t("templates.create.label")}
      submitLabel={t("templates.create.submit")}
      submitVariant={primary ? "primary" : "secondary"}
      success={t("templates.create.done")}
    >
      <Input name="name" label={t("templates.fields.name")} maxLength={200} required width="100%" />
      <Textarea
        name="description"
        label={t("templates.fields.description")}
        help={t("templates.fields.descriptionHelp")}
        maxLength={2000}
        rows={2}
        width="100%"
      />
      <Defaults zones={zones} currencies={currencies} />
    </ActionForm>
  );
}

export function SaveProjectForm({ org, projects }: { org: string; projects: readonly Choice[] }) {
  const t = useWorkflowT();
  const [project, setProject] = useState(projects[0]?.value ?? "");
  return (
    <ActionForm
      action={saveProjectAsTemplateAction}
      hidden={{ org, projectId: project }}
      label={t("templates.fromProject.label")}
      submitLabel={t("templates.fromProject.submit")}
      submitVariant="secondary"
      success={t("templates.fromProject.done")}
    >
      <Select
        label={t("templates.fromProject.project")}
        value={project}
        options={projects.map((p) => ({ value: p.value, label: p.label }))}
        onChange={(e) => setProject(e.target.value)}
      />
      <Input name="name" label={t("templates.fields.name")} maxLength={200} required width="100%" />
    </ActionForm>
  );
}

export function ApplyTemplateForm({
  org,
  templateId,
  zones,
  needsZone,
}: {
  org: string;
  templateId: string;
  zones: readonly string[];
  needsZone: boolean;
}) {
  const t = useWorkflowT();
  const [zone, setZone] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-8">
      <ActionForm
        action={applyTemplateAction}
        hidden={{ org, templateId, timeZone: zone }}
        label={t("templates.apply.label")}
        submitLabel={t("templates.apply.submit")}
        onDone={(state: WorkflowActionState) => setCreated(state.id ?? null)}
      >
        <div className="grid grid-cols-2 gap-8 max-md:grid-cols-1">
          <Input
            name="projectKey"
            label={t("templates.apply.key")}
            help={t("templates.apply.keyHelp")}
            maxLength={5}
            pattern="[A-Za-z]{2,5}"
            required
            width="100%"
          />
          <Input
            name="name"
            label={t("templates.apply.name")}
            maxLength={200}
            required
            width="100%"
          />
          <Input
            name="startsOn"
            type="date"
            label={t("templates.apply.startsOn")}
            help={t("templates.apply.startsOnHelp")}
            width="100%"
          />
          <Select
            label={t("templates.apply.timeZone")}
            help={
              needsZone
                ? t("templates.apply.timeZoneRequired")
                : t("templates.apply.timeZoneDefault")
            }
            value={zone}
            options={[
              {
                value: "",
                label: needsZone
                  ? t("templates.apply.chooseZone")
                  : t("templates.apply.useDefault"),
              },
              ...zones.map((z) => ({ value: z, label: z })),
            ]}
            onChange={(e) => setZone(e.target.value)}
          />
        </div>
      </ActionForm>
      {created ? (
        <p role="status" className="m-0 text-text-13">
          {t("templates.apply.done", { key: created })}{" "}
          <Link
            href={`/${org}/p/${created}` as Route}
            className="font-medium text-accent-text underline"
          >
            {t("templates.apply.open")}
          </Link>
        </p>
      ) : null}
    </div>
  );
}

export function VersionDefaultsForm({
  org,
  version,
  zones,
  currencies,
}: {
  org: string;
  version: {
    id: string;
    notes: string | null;
    timeZone: string | null;
    currency: string | null;
    durationDays: number | null;
  };
  zones: readonly string[];
  currencies: readonly string[];
}) {
  const t = useWorkflowT();
  return (
    <ActionForm
      action={updateVersionAction}
      hidden={{ org, id: version.id }}
      label={t("templates.draft.defaultsLabel")}
      submitLabel={t("templates.draft.saveDefaults")}
      submitVariant="secondary"
      success={t("templates.draft.saved")}
    >
      <Textarea
        name="notes"
        label={t("templates.fields.notes")}
        defaultValue={version.notes ?? ""}
        maxLength={2000}
        rows={2}
        width="100%"
      />
      <Defaults zones={zones} currencies={currencies} initial={version} />
    </ActionForm>
  );
}

export function AddItemForm({
  org,
  versionId,
  recordKinds,
  phases,
}: {
  org: string;
  versionId: string;
  recordKinds: readonly Choice[];
  phases: readonly Choice[];
}) {
  const t = useWorkflowT();
  const [kind, setKind] = useState<Database["app"]["Enums"]["template_item_kind"]>("Record");
  const [scopeKind, setScopeKind] = useState("Show");
  const [recordKind, setRecordKind] = useState(recordKinds[0]?.value ?? "");
  const [xyz, setXyz] = useState("Y");
  const [phase, setPhase] = useState("");
  return (
    <ActionForm
      action={addItemAction}
      hidden={{ org, versionId, kind, scopeKind, recordKind, xyz, phaseCode: phase }}
      label={t("templates.items.addLabel")}
      submitLabel={t("templates.items.add")}
      submitVariant="secondary"
      success={t("templates.items.added")}
    >
      <Select
        label={t("templates.items.kind")}
        value={kind}
        options={[
          { value: "Record", label: t("templates.items.kinds.Record") },
          { value: "Scope Node", label: t("templates.items.kinds.Scope Node") },
        ]}
        onChange={(e) => setKind(e.target.value as Database["app"]["Enums"]["template_item_kind"])}
      />
      <Input
        name="name"
        label={kind === "Record" ? t("templates.items.recordTitle") : t("templates.items.nodeName")}
        maxLength={200}
        required
        width="100%"
      />
      {kind === "Scope Node" ? (
        <div className="grid grid-cols-2 gap-8 max-md:grid-cols-1">
          <Select
            label={t("templates.items.scopeKind")}
            value={scopeKind}
            options={[
              { value: "Show", label: t("templates.items.scopeKinds.Show") },
              { value: "Standing Venue", label: t("templates.items.scopeKinds.Standing Venue") },
            ]}
            onChange={(e) => setScopeKind(e.target.value)}
          />
          <Input
            name="scopeCodeSuffix"
            label={t("templates.items.suffix")}
            help={t("templates.items.suffixHelp")}
            maxLength={16}
            pattern="[A-Za-z0-9][A-Za-z0-9-]{0,15}"
            required
            width="100%"
          />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-8 max-md:grid-cols-1">
          <Select
            label={t("templates.items.recordKind")}
            value={recordKind}
            options={recordKinds.map((k) => ({ value: k.value, label: k.label }))}
            onChange={(e) => setRecordKind(e.target.value)}
          />
          <Select
            label={t("templates.items.xyz")}
            help={t("templates.items.xyzHelp")}
            value={xyz}
            options={(["X", "Y", "Z"] as const).map((v) => ({
              value: v,
              label: t(`templates.items.families.${v}`),
            }))}
            onChange={(e) => setXyz(e.target.value)}
          />
          <Select
            label={t("templates.items.phase")}
            value={phase}
            options={[
              { value: "", label: t("templates.items.noPhase") },
              ...phases.map((p) => ({ value: p.value, label: p.label })),
            ]}
            onChange={(e) => setPhase(e.target.value)}
          />
          <Input
            name="dueOffsetDays"
            type="number"
            min={-3660}
            max={3660}
            label={t("templates.items.dueOffset")}
            help={t("templates.items.dueOffsetHelp")}
            width="100%"
          />
        </div>
      )}
    </ActionForm>
  );
}

export function RemoveItemButton({ org, id, name }: { org: string; id: string; name: string }) {
  const t = useWorkflowT();
  return (
    <ActionForm
      action={removeItemAction}
      hidden={{ org, id }}
      label={t("templates.items.removeNamed", { name })}
      submitLabel={t("templates.items.remove")}
      submitVariant="ghost"
      inline
    />
  );
}

/** Publishing is primary for a template with no published version, secondary beside Apply. */
export function PublishButton({
  org,
  versionId,
  primary = true,
}: {
  org: string;
  versionId: string;
  primary?: boolean;
}) {
  const t = useWorkflowT();
  return (
    <ActionForm
      action={publishAction}
      hidden={{ org, versionId }}
      label={t("templates.draft.publishLabel")}
      submitLabel={t("templates.draft.publish")}
      submitVariant={primary ? "primary" : "secondary"}
      success={t("templates.draft.published")}
      inline
    />
  );
}

export function NewDraftButton({ org, templateId }: { org: string; templateId: string }) {
  const t = useWorkflowT();
  return (
    <ActionForm
      action={newDraftAction}
      hidden={{ org, templateId }}
      label={t("templates.draft.newLabel")}
      submitLabel={t("templates.draft.new")}
      submitVariant="secondary"
      success={t("templates.draft.created")}
      inline
    />
  );
}

export function DeleteTemplateButton({ org, id }: { org: string; id: string }) {
  const t = useWorkflowT();
  return (
    <ActionForm
      action={deleteTemplateAction}
      hidden={{ org, id }}
      label={t("templates.delete.label")}
      submitLabel={t("templates.delete.submit")}
      submitVariant="danger"
      success={t("templates.delete.done")}
      inline
    />
  );
}
