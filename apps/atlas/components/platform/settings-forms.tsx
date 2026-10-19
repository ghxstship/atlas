"use client";

import type { CustomDataType } from "@xos/data/custom-objects";
import { Checkbox, Input, Select, Textarea } from "@xos/ui";
import { useState } from "react";
import { addObjectFieldAction, createObjectTypeAction } from "@/app/[org]/objects/actions";
import { ActionForm, usePlatformT } from "@/components/platform/kit";
import {
  cancelOrganizationAction,
  grantSupportSessionAction,
  reactivateOrganizationAction,
  startViewAsAction,
} from "@/lib/platform/settings-actions";
import { endSupportSessionAction } from "@/app/partner/[partnerSlug]/actions";

const DATA_TYPES: readonly CustomDataType[] = [
  "Text",
  "Number",
  "Money",
  "Date",
  "Timestamp",
  "Boolean",
  "Choice",
  "Email",
  "URL",
];
const VIEWS = ["List", "Board", "Table", "Calendar"] as const;

/** The client Owner grants the partner a support session of 1 to 24 hours with a reason. */
export function GrantSupportSessionForm({ org }: { org: string }) {
  const t = usePlatformT();
  const [hours, setHours] = useState("4");
  return (
    <ActionForm
      action={grantSupportSessionAction}
      hidden={{ org, hours }}
      label={t("access.support.grant")}
      submitLabel={t("access.support.grant")}
      success={t("access.support.granted")}
    >
      <Select
        label={t("access.support.hours")}
        value={hours}
        options={["1", "2", "4", "8", "24"].map((h) => ({
          value: h,
          label: t("access.support.hoursOption", { hours: Number(h) }),
        }))}
        onChange={(e) => setHours(e.target.value)}
      />
      <Textarea
        id="support-reason"
        name="reason"
        label={t("access.support.reason")}
        help={t("access.support.reasonHelp")}
        required
        maxLength={500}
        rows={2}
        width="100%"
      />
    </ActionForm>
  );
}

/** Ends a support session early, from the client side (the partner can too). */
export function EndSupportSessionForm({ org, session }: { org: string; session: string }) {
  const t = usePlatformT();
  return (
    <ActionForm
      action={endSupportSessionAction}
      hidden={{ org, session }}
      label={t("access.support.end")}
      submitLabel={t("access.support.end")}
      submitVariant="secondary"
    />
  );
}

/** Picks a role at or below the viewer's own band and starts the preview. */
export function ViewAsForm({
  org,
  roles,
}: {
  org: string;
  roles: readonly { value: string; label: string }[];
}) {
  const t = usePlatformT();
  const [role, setRole] = useState(roles[0]?.value ?? "");
  return (
    <ActionForm
      action={startViewAsAction}
      hidden={{ org, role }}
      label={t("access.viewAs.title")}
      submitLabel={t("access.viewAs.start")}
      inline
    >
      <Select
        label={t("access.viewAs.role")}
        value={role}
        options={[...roles]}
        onChange={(e) => setRole(e.target.value)}
      />
    </ActionForm>
  );
}

export function CreateObjectTypeForm({ org }: { org: string }) {
  const t = usePlatformT();
  const [view, setView] = useState<string>("Board");
  return (
    <ActionForm
      action={createObjectTypeAction}
      hidden={{ org, view }}
      label={t("objects.define.title")}
      submitLabel={t("objects.define.submit")}
      success={t("objects.define.done")}
    >
      <Input
        id="object-label"
        name="label"
        label={t("objects.define.label")}
        help={t("objects.define.labelHelp")}
        required
        maxLength={100}
        width="100%"
      />
      <Input
        id="object-icon"
        name="icon"
        label={t("objects.define.icon")}
        help={t("objects.define.iconHelp")}
        maxLength={64}
        width={240}
      />
      <Select
        label={t("objects.define.view")}
        value={view}
        options={VIEWS.map((v) => ({ value: v, label: t(`objects.views.${v}`) }))}
        onChange={(e) => setView(e.target.value)}
      />
    </ActionForm>
  );
}

export function AddFieldForm({
  org,
  typeId,
  label,
  next,
}: {
  org: string;
  typeId: string;
  label: string;
  next: number;
}) {
  const t = usePlatformT();
  const [dataType, setDataType] = useState<CustomDataType>("Text");
  return (
    <ActionForm
      action={addObjectFieldAction}
      hidden={{ org, type: typeId, dataType, order: String(next) }}
      label={t("objects.field.title", { object: label })}
      submitLabel={t("objects.field.submit")}
      submitVariant="secondary"
      success={t("objects.field.done")}
    >
      <Input
        id={`field-label-${typeId}`}
        name="label"
        label={t("objects.field.label")}
        required
        maxLength={100}
        width="100%"
      />
      <Select
        label={t("objects.field.type")}
        value={dataType}
        options={DATA_TYPES.map((d) => ({ value: d, label: t(`objects.dataTypes.${d}`) }))}
        onChange={(e) => setDataType(e.target.value as CustomDataType)}
      />
      {dataType === "Choice" ? (
        <Textarea
          id={`field-choices-${typeId}`}
          name="choices"
          label={t("objects.field.choices")}
          help={t("objects.field.choicesHelp")}
          required
          rows={3}
          width="100%"
        />
      ) : null}
      <Checkbox
        id={`field-required-${typeId}`}
        name="required"
        label={t("objects.field.required")}
      />
    </ActionForm>
  );
}

/** Cancels the org: the Owner types its name exactly and says why. */
export function CancelOrganizationForm({ org, name }: { org: string; name: string }) {
  const t = usePlatformT();
  return (
    <ActionForm
      action={cancelOrganizationAction}
      hidden={{ org }}
      label={t("lifecycle.cancel.title")}
      submitLabel={t("lifecycle.cancel.submit")}
      submitVariant="danger"
    >
      <Input
        id="cancel-confirm"
        name="confirm"
        label={t("lifecycle.cancel.confirm", { name })}
        required
        autoComplete="off"
        maxLength={200}
        width="100%"
      />
      <Textarea
        id="cancel-reason"
        name="reason"
        label={t("lifecycle.cancel.reason")}
        help={t("lifecycle.cancel.reasonHelp")}
        required
        maxLength={1000}
        rows={3}
        width="100%"
      />
    </ActionForm>
  );
}

export function ReactivateOrganizationForm({ org }: { org: string }) {
  const t = usePlatformT();
  return (
    <ActionForm
      action={reactivateOrganizationAction}
      hidden={{ org }}
      label={t("lifecycle.reactivate.title")}
      submitLabel={t("lifecycle.reactivate.submit")}
      submitVariant="secondary"
    />
  );
}
