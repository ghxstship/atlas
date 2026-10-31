"use server";

import { listBudgetLineLodging, type BudgetLineLodging } from "@xos/data/lodging";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getOrgContext } from "@/lib/shell/context";

/**
 * Lodging drawn on a budget's lines (B5, app.budget_line_lodging), read when the budget editor asks: held and
 * assigned room nights and amounts of the blocks linked to each line. Withheld (every figure null) for a reader
 * without hospitality.fulfillment.read; nothing here writes to a line.
 */
export async function budgetLodgingAction(
  org: string,
  budgetId: string,
): Promise<readonly BudgetLineLodging[] | null> {
  const ctx = await getOrgContext(org);
  if (!ctx) notFound();
  if (!z.uuid().safeParse(budgetId).success) return null;
  const result = await listBudgetLineLodging(ctx.viewer.db, budgetId);
  return result.ok ? result.data : null;
}
