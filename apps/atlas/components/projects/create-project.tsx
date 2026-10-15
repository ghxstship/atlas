"use client";

import { Button, Dialog, Input, Select } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import { createProjectAction, type ActionState } from "@/lib/projects/actions";
import { ActionError, echoed, fieldError } from "./action-error";

export interface ProjectFormOptions {
  readonly jurisdictions: readonly { readonly value: string; readonly label: string }[];
  readonly tiers: readonly { readonly value: string; readonly label: string }[];
  readonly regions: readonly { readonly value: string; readonly label: string }[];
  readonly venues: readonly { readonly value: string; readonly label: string }[];
  readonly timeZones: readonly string[];
  readonly defaultTimeZone: string;
}

export interface ProjectFormValues {
  readonly key: string;
  readonly name: string;
  readonly timeZone: string;
  readonly jurisdictionId: string | null;
  readonly tierCode: string | null;
  readonly regionCode: string | null;
  readonly venueId: string | null;
  readonly startsOn: string | null;
  readonly endsOn: string | null;
}

/**
 * The project fields shared by creation and project settings (Section 4.5.4 Settings): key, name,
 * time zone, jurisdiction, tier, region, venue and dates. Lists come from canon and the org.
 */
export function ProjectFields({
  idPrefix,
  options,
  values,
  state,
  disabled = false,
}: {
  idPrefix: string;
  options: ProjectFormOptions;
  values?: ProjectFormValues;
  state: ActionState;
  disabled?: boolean;
}) {
  const t = useTranslations("projects");
  const err = (name: string) => fieldError(t, state, name);
  const choose = { value: "", label: t("create.choose") };
  return (
    <div className="flex flex-col gap-12">
      <div className="flex flex-wrap gap-12">
        <Input
          id={`${idPrefix}-key`}
          name="key"
          required
          autoComplete="off"
          maxLength={5}
          width={120}
          label={t("create.key")}
          defaultValue={echoed(state, "key", values?.key ?? "")}
          disabled={disabled}
          error={err("key")}
        />
        <div className="min-w-0 flex-1">
          <Input
            id={`${idPrefix}-name`}
            name="name"
            required
            width="100%"
            maxLength={200}
            label={t("create.name")}
            defaultValue={echoed(state, "name", values?.name ?? "")}
            disabled={disabled}
            error={err("name")}
          />
        </div>
      </div>
      <p className="m-0 text-text-12 text-text-secondary">{t("create.keyHelp")}</p>
      <Select
        id={`${idPrefix}-tz`}
        name="timeZone"
        label={t("create.timeZone")}
        help={t("create.timeZoneHelp")}
        value={echoed(state, "timeZone", values?.timeZone ?? options.defaultTimeZone)}
        options={options.timeZones.map((z) => ({ value: z, label: z }))}
        disabled={disabled}
        error={err("timeZone")}
      />
      <Select
        id={`${idPrefix}-jurisdiction`}
        name="jurisdictionId"
        label={t("create.jurisdiction")}
        help={t("create.jurisdictionHelp")}
        value={echoed(state, "jurisdictionId", values?.jurisdictionId ?? "")}
        options={[choose, ...options.jurisdictions]}
        disabled={disabled}
      />
      <div className="flex flex-wrap gap-12">
        <Select
          id={`${idPrefix}-tier`}
          name="tierCode"
          label={t("create.tier")}
          value={echoed(state, "tierCode", values?.tierCode ?? "")}
          options={[choose, ...options.tiers]}
          disabled={disabled}
        />
        <Select
          id={`${idPrefix}-region`}
          name="regionCode"
          label={t("create.region")}
          value={echoed(state, "regionCode", values?.regionCode ?? "")}
          options={[choose, ...options.regions]}
          disabled={disabled}
        />
      </div>
      {options.venues.length > 0 ? (
        <Select
          id={`${idPrefix}-venue`}
          name="venueId"
          label={t("create.venue")}
          value={echoed(state, "venueId", values?.venueId ?? "")}
          options={[choose, ...options.venues]}
          disabled={disabled}
        />
      ) : (
        <input type="hidden" name="venueId" value={values?.venueId ?? ""} />
      )}
      <div className="flex flex-wrap gap-12">
        <Input
          id={`${idPrefix}-starts`}
          name="startsOn"
          type="date"
          width={200}
          label={t("create.startsOn")}
          defaultValue={echoed(state, "startsOn", values?.startsOn ?? "")}
          disabled={disabled}
          error={err("startsOn")}
        />
        <Input
          id={`${idPrefix}-ends`}
          name="endsOn"
          type="date"
          width={200}
          label={t("create.endsOn")}
          defaultValue={echoed(state, "endsOn", values?.endsOn ?? "")}
          disabled={disabled}
          error={err("endsOn")}
        />
      </div>
    </div>
  );
}

/** New project dialog; opened from the primary action or by `?create=1` (ADR 0017 item 4). */
export function CreateProjectDialog({
  org,
  options,
  defaultOpen,
}: {
  org: string;
  options: ProjectFormOptions;
  defaultOpen: boolean;
}) {
  const t = useTranslations("projects");
  const [open, setOpen] = useState(defaultOpen);
  const [state, action, pending] = useActionState(createProjectAction, {});
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button variant="primary" icon="Plus">
          {t("list.newProject")}
        </Button>
      }
      title={t("create.title")}
      description={t("create.description")}
      actions={
        <>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            {t("create.cancel")}
          </Button>
          <Button type="submit" form="create-project" variant="primary" loading={pending}>
            {t("create.submit")}
          </Button>
        </>
      }
    >
      <form id="create-project" action={action} className="flex flex-col gap-12" noValidate>
        <input type="hidden" name="org" value={org} />
        <ActionError state={state} />
        <ProjectFields idPrefix="create" options={options} state={state} />
      </form>
    </Dialog>
  );
}
