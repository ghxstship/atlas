"use client";

import { Button } from "@xos/ui";
import dynamic from "next/dynamic";
import { useState } from "react";
import { useAssetsCopy } from "./copy";
import type { Option } from "./forms";

const PlanCreateDialog = dynamic(() =>
  import("./maintenance-plan-dialogs").then((m) => m.PlanCreateDialog),
);
const CompletePlanDialog = dynamic(() =>
  import("./maintenance-plan-dialogs").then((m) => m.CompletePlanDialog),
);

/** New plan: its dialog, with the form's fields, loads when it opens. */
export function PlanCreateButton(props: {
  org: string;
  appliesTo: readonly Option[];
  units: readonly Option[];
  today: string;
}) {
  const t = useAssetsCopy();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        {t("schedule.create.open")}
      </Button>
      {open ? <PlanCreateDialog {...props} setOpen={setOpen} /> : null}
    </>
  );
}

/** Complete: its dialog loads when it opens. */
export function CompletePlanButton(props: {
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
        aria-label={t("schedule.completeLabel", { title: props.planTitle, unit: props.unitLabel })}
        onClick={() => setOpen(true)}
      >
        {t("schedule.complete")}
      </Button>
      {open ? <CompletePlanDialog {...props} setOpen={setOpen} /> : null}
    </>
  );
}
