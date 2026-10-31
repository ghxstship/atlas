"use server";

import {
  parseRequestableValue,
  requestEngagedAllocation,
  unsplitEngagedAllocation,
  withdrawEngagedAllocation,
} from "@xos/data/gateway-allocations";
import { z } from "zod";
import { outcomeFor, toAction, type ActionResult } from "@/lib/action-result";
import type { FormResult } from "@/lib/actions/operations";
import { localToInstant } from "@/lib/local-time";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Allocations in Gateway (R8, migration 2700): the party side asks for what its pool or one person
 * needs, gives a share back to the pool and withdraws a request; assigning from a pool to several
 * people at once is the bulk action engaged_allocation_assignments (lib/bulk/catalog.ts). The database decides who may (private.can_advance_engagement) and refuses with a
 * named rule; these actions only shape the input. A credential need is a request: Gateway never
 * issues (Section 4.5.8).
 */

const requestSchema = z.object({
  engagementId: z.uuid(),
  holder: z.union([z.literal("pool"), z.uuid()]),
  item: z.string().min(3).max(80),
  quantity: z.coerce.number().positive().max(100000),
  neededFrom: z.string().trim().min(1).max(40),
  neededTo: z.string().trim().min(1).max(40),
  timeZone: z.string().trim().min(1).max(64),
  note: z.string().trim().max(1000),
});

export async function requestAllocationAction(_: FormResult, form: FormData): Promise<FormResult> {
  const parsed = requestSchema.safeParse({
    engagementId: form.get("engagementId"),
    holder: form.get("holder"),
    item: form.get("item") ?? "",
    quantity: form.get("quantity"),
    neededFrom: form.get("neededFrom") ?? "",
    neededTo: form.get("neededTo") ?? "",
    timeZone: form.get("timeZone") ?? "",
    note: form.get("note") ?? "",
  });
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    return {
      fieldError:
        field === "quantity"
          ? "allocationQuantity"
          : field === "item" || field === "holder"
            ? "allocationItem"
            : "allocationWindow",
    };
  }
  const item = parseRequestableValue(parsed.data.item);
  if (!item) return { fieldError: "allocationItem" };
  const f = parsed.data;
  const result = await requestEngagedAllocation(await createServerSupabase(), {
    engagementId: f.engagementId,
    rosterEntryId: f.holder === "pool" ? null : f.holder,
    itemKind: item.itemKind,
    itemId: item.itemId,
    serviceKind: item.serviceKind,
    quantity: f.quantity,
    neededFrom: localToInstant(f.neededFrom, f.timeZone),
    neededTo: localToInstant(f.neededTo, f.timeZone),
    timeZone: f.timeZone,
    note: f.note === "" ? null : f.note,
  });
  return result.ok ? { done: true } : { outcome: outcomeFor(result.error) };
}

export async function withdrawAllocationAction(allocationId: string): Promise<ActionResult> {
  const id = z.uuid().parse(allocationId);
  return toAction(
    await withdrawEngagedAllocation(await createServerSupabase(), id, "Withdrawn from Gateway."),
  );
}

export async function returnShareAction(shareId: string): Promise<ActionResult> {
  const id = z.uuid().parse(shareId);
  return toAction(await unsplitEngagedAllocation(await createServerSupabase(), id));
}
