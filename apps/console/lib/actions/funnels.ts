"use server";

import { acknowledgeFunnelAlert } from "@xos/data/console-funnels";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { actionContext } from "@/lib/operator";
import { failed, field, fromResult, type ActionState } from "@/lib/action-state";

/** Workflow funnels (A146): an operator acknowledges a regression alert; the console ledger records who. */
export async function acknowledgeFunnelAlertAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await actionContext("tenants.read");
  if (!ctx.ok) return failed(ctx.key);
  const alertId = field(form, "alertId");
  if (!z.uuid().safeParse(alertId).success) return failed("errors.invalid");
  const result = await acknowledgeFunnelAlert(ctx.db, alertId);
  if (result.ok) revalidatePath("/funnels");
  return fromResult(result);
}
