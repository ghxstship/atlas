import type { XosClient } from "@xos/data/client";
import { fail, ok, toDataError, type Result } from "@xos/data/result";
import type { Database } from "@xos/data/database.types";

/**
 * The party's own halves of three engagement features (A32): the guest list kept through A10's RPCs
 * (app.engaged_guest_list and app.request_engaged_guest, migration 0965) and the settlement answer
 * through A15's app.respond_to_settlement (0991). Each RPC checks the engagement area itself, so a
 * person outside it gets not-found, never someone else's list.
 */

export type GuestEntryState = Database["app"]["Enums"]["guest_entry_state"];

export interface EngagedGuest {
  readonly id: string;
  readonly guestName: string;
  readonly plusOnes: number;
  readonly note: string | null;
  readonly state: GuestEntryState;
  readonly checkedInAt: string | null;
  readonly requestedAt: string;
}

/** The guest list of one engagement, oldest request first. */
export async function listEngagedGuests(
  db: XosClient,
  engagementId: string,
): Promise<Result<EngagedGuest[]>> {
  const { data, error } = await db.rpc("engaged_guest_list", { p_engagement_id: engagementId });
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((g) => ({
      id: g.id,
      guestName: g.guest_name,
      plusOnes: g.plus_ones,
      note: g.note,
      state: g.entry_state,
      checkedInAt: g.checked_in_at,
      requestedAt: g.created_at,
    })),
  );
}

/** Requests a guest on the engagement's list; the production approves or declines in Atlas. */
export async function requestEngagedGuest(
  db: XosClient,
  input: { engagementId: string; guestName: string; plusOnes: number; note: string | null },
): Promise<Result<{ id: string }>> {
  const { data, error } = await db.rpc("request_engaged_guest", {
    p_engagement_id: input.engagementId,
    p_guest_name: input.guestName,
    p_plus_ones: input.plusOnes,
    ...(input.note === null ? {} : { p_note: input.note }),
  });
  if (error) return fail(toDataError(error));
  return ok({ id: String(data) });
}

/** The party accepts or disputes a submitted settlement, with a reason. */
export async function respondToSettlement(
  db: XosClient,
  input: { settlementId: string; accept: boolean; reason: string },
): Promise<Result<null>> {
  const { error } = await db.rpc("respond_to_settlement", {
    p_settlement_id: input.settlementId,
    p_accept: input.accept,
    p_reason: input.reason,
  });
  return error ? fail(toDataError(error)) : ok(null);
}
