"use client";

import { Button, Combobox, Input, Select, Textarea } from "@xos/ui";
import { useState } from "react";
import { createMaintenancePlanAction } from "@/app/[org]/assets/actions";
import { useAssetsCopy } from "./copy";
import { ActionDialog } from "./dialog";
import { MaintenanceForm, type Option } from "./forms";

/** Add a maintenance plan (B11, G-95): what it applies to from one searchable picker, then six fields at most. */
export function PlanCreateDialog({
  org,
  appliesTo,
  units,
  today,
  setOpen,
}: {
  org: string;
  appliesTo: readonly Option[];
  units: readonly Option[];
  today: string;
  setOpen: (open: boolean) => void;
}) {
  const t = useAssetsCopy();
  const [target, setTarget] = useState("");
  return (
    <ActionDialog
      title={t("schedule.create.title")}
      description={t("schedule.create.description")}
      submitLabel={t("schedule.create.submit")}
      action={createMaintenancePlanAction}
      org={org}
      hidden={{ appliesTo: target }}
      open
      setOpen={setOpen}
    >
      <Combobox
        id="plan-applies-to"
        label={t("schedule.create.appliesTo")}
        options={[...appliesTo]}
        value={target}
        onChange={setTarget}
      />
      <Input
        id="plan-title"
        name="title"
        required
        width="100%"
        label={t("schedule.create.planTitle")}
      />
      <Input
        id="plan-first-due"
        name="firstDueOn"
        type="date"
        required
        defaultValue={today}
        label={t("schedule.create.firstDue")}
      />
      <Input
        id="plan-every"
        name="everyCount"
        inputMode="numeric"
        label={t("schedule.create.every")}
        help={t("schedule.create.everyHelp")}
      />
      <Select
        id="plan-unit"
        name="everyUnit"
        label={t("schedule.create.unit")}
        options={[{ value: "", label: t("schedule.create.once") }, ...units]}
      />
      <Textarea
        id="plan-instructions"
        name="instructions"
        width="100%"
        label={t("schedule.create.instructions")}
      />
    </ActionDialog>
  );
}

/** Complete: the maintenance form with the plan set, so the work it records moves the next due date. */
export function CompletePlanDialog({
  org,
  unitId,
  unitLabel,
  planId,
  planTitle,
  currency,
  today,
  setOpen,
}: {
  org: string;
  unitId: string;
  unitLabel: string;
  planId: string;
  planTitle: string;
  currency: string;
  today: string;
  setOpen: (open: boolean) => void;
}) {
  const t = useAssetsCopy();
  return (
    <MaintenanceForm
      org={org}
      units={[]}
      currency={currency}
      today={today}
      unitId={unitId}
      planId={planId}
      planTitle={planTitle}
      open
      setOpen={setOpen}
    />
  );
}
