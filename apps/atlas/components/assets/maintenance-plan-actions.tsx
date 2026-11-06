"use client";

import { Button, Combobox, Input, Select, Textarea } from "@xos/ui";
import { useState } from "react";
import { createMaintenancePlanAction } from "@/app/[org]/assets/actions";
import { useAssetsCopy } from "./copy";
import { ActionDialog } from "./dialog";
import { MaintenanceForm, type Option } from "./forms";

/** Add a maintenance plan (B11, G-95): what it applies to from one searchable picker, then six fields at most. */
export function PlanCreateButton({
  org,
  appliesTo,
  units,
  today,
}: {
  org: string;
  appliesTo: readonly Option[];
  units: readonly Option[];
  today: string;
}) {
  const t = useAssetsCopy();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState("");
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        {t("schedule.create.open")}
      </Button>
      {open ? (
        <ActionDialog
          title={t("schedule.create.title")}
          description={t("schedule.create.description")}
          submitLabel={t("schedule.create.submit")}
          action={createMaintenancePlanAction}
          org={org}
          hidden={{ appliesTo: target }}
          open={open}
          setOpen={setOpen}
        >
          <Combobox
            id="plan-applies-to"
            label={t("schedule.create.appliesTo")}
            options={[...appliesTo]}
            value={target}
            onChange={setTarget}
          />
          <Input id="plan-title" name="title" required width="100%" label={t("schedule.create.planTitle")} />
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
      ) : null}
    </>
  );
}

/** Complete: the maintenance form with the plan set, so the work it records moves the next due date. */
export function CompletePlanButton({
  org,
  unitId,
  unitLabel,
  planId,
  planTitle,
  currency,
  today,
}: {
  org: string;
  unitId: string;
  unitLabel: string;
  planId: string;
  planTitle: string;
  currency: string;
  today: string;
}) {
  const t = useAssetsCopy();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        aria-label={t("schedule.completeLabel", { title: planTitle, unit: unitLabel })}
        onClick={() => setOpen(true)}
      >
        {t("schedule.complete")}
      </Button>
      {open ? (
        <MaintenanceForm
          org={org}
          units={[]}
          currency={currency}
          today={today}
          unitId={unitId}
          planId={planId}
          planTitle={planTitle}
          open={open}
          setOpen={setOpen}
        />
      ) : null}
    </>
  );
}
