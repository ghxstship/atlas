"use client";

import { Select, Textarea } from "@xos/ui";
import { useActionState } from "react";
import type { FormResult } from "@/lib/actions/operations";
import { assignRosterShiftAction, markRosterNoShowAction } from "@/lib/actions/staffing";
import { FormShell, useCopy } from "./forms";
import type { Option } from "./roster-forms";

/**
 * Positions (R12): the agency's lead places one person from its roster on an agency slot. One field, the person, whose
 * options carry the training and conflict hints; the database refuses anyone not ready (roster_training_incomplete,
 * roster_shift_overlap). Each slot's form is one of several in the list, so its submit is secondary.
 */
export function AssignRosterShiftForm(props: { shiftId: string; options: readonly Option[] }) {
  const t = useCopy();
  const [state, action, pending] = useActionState<FormResult, FormData>(
    assignRosterShiftAction,
    {},
  );
  return (
    <FormShell
      row
      state={state}
      pending={pending}
      action={action}
      submitLabel={t("staffing.assign")}
      doneLabel={t("staffing.assigned")}
      label={t("staffing.assignTitle")}
    >
      <input type="hidden" name="shiftId" value={props.shiftId} />
      <Select
        id={`assign-${props.shiftId}`}
        name="rosterEntryId"
        label={t("staffing.person")}
        placeholder={t("staffing.personHint")}
        options={[...props.options]}
      />
    </FormShell>
  );
}

/**
 * Positions (B9): the agency's lead marks a person of its roster who did not arrive for a started shift. The id is chosen
 * when the page renders, so submitting twice is the same mark.
 */
export function MarkNoShowForm(props: { shiftId: string; noShowId: string }) {
  const t = useCopy();
  const [state, action, pending] = useActionState<FormResult, FormData>(
    markRosterNoShowAction,
    {},
  );
  return (
    <FormShell
      row
      state={state}
      pending={pending}
      action={action}
      submitLabel={t("staffing.noShow")}
      doneLabel={t("staffing.noShowDone")}
      label={t("staffing.noShowTitle")}
    >
      <input type="hidden" name="shiftId" value={props.shiftId} />
      <input type="hidden" name="noShowId" value={props.noShowId} />
      <Textarea
        id={`no-show-${props.shiftId}`}
        name="reason"
        label={t("staffing.noShowReason")}
        required
        maxLength={500}
        rows={2}
      />
    </FormShell>
  );
}
