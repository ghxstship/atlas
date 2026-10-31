"use server";

import {
  acknowledgeRosterTraining,
  assignRosterShift,
  unassignRosterShift,
} from "@xos/data/gateway";
import { z } from "zod";
import { outcomeFor, toAction, type ActionResult } from "@/lib/action-result";
import type { FormResult } from "@/lib/actions/operations";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * A staffing agency's staff on shifts in Gateway (R12, migrations 2750 to 2752): the agency's lead places the people
 * on its roster on the slots the production allocated (Positions) and takes them off again; the person on a roster
 * entry acknowledges the training due on it before their first shift. The database decides who may do each and
 * refuses with a named rule, such as roster_training_incomplete.
 */

const id = z.uuid();

export async function assignRosterShiftAction(_: FormResult, form: FormData): Promise<FormResult> {
  const parsed = z
    .object({ shiftId: z.uuid(), rosterEntryId: z.uuid() })
    .safeParse({ shiftId: form.get("shiftId"), rosterEntryId: form.get("rosterEntryId") });
  if (!parsed.success) return { fieldError: "rosterAssignee" };
  const result = await assignRosterShift(
    await createServerSupabase(),
    parsed.data.shiftId,
    parsed.data.rosterEntryId,
  );
  return result.ok ? { done: true } : { outcome: outcomeFor(result.error) };
}

export async function unassignRosterShiftAction(
  shiftId: string,
  reason: string,
): Promise<ActionResult> {
  return toAction(
    await unassignRosterShift(
      await createServerSupabase(),
      id.parse(shiftId),
      z.string().trim().min(1).max(500).parse(reason),
    ),
  );
}

export async function acknowledgeRosterTrainingAction(
  rosterEntryId: string,
  requirementId: string,
): Promise<ActionResult> {
  return toAction(
    await acknowledgeRosterTraining(await createServerSupabase(), {
      rosterEntryId: id.parse(rosterEntryId),
      requirementId: id.parse(requirementId),
    }),
  );
}
