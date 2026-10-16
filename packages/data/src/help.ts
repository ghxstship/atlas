import type { Database, XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Guided tours and contextual tips (Section 11.16): each person's progress, keyed by the help
 * content's tour and tip keys (migration 0642). A tour is offered once, can be replayed from Help and
 * is never forced; a tip is shown once and dismissed.
 */

export type TourState = Database["app"]["Enums"]["tour_state"];

export interface TourProgress {
  readonly id: string;
  readonly tourKey: string;
  readonly state: TourState;
  readonly step: number;
}

export interface HelpState {
  readonly tours: readonly TourProgress[];
  /** Tip keys the person has dismissed. */
  readonly dismissedTips: readonly string[];
}

/** The person's tour progress and dismissed tips in one membership. */
export async function getHelpState(
  db: XosClient,
  membershipId: string,
): Promise<Result<HelpState>> {
  const [tours, tips] = await Promise.all([
    db
      .from("tour_progress")
      .select("id, tour_key, tour_state, step")
      .eq("membership_id", membershipId)
      .is("deleted_at", null),
    db
      .from("tip_dismissals")
      .select("tip_key")
      .eq("membership_id", membershipId)
      .is("deleted_at", null),
  ]);
  if (tours.error) return fail(toDataError(tours.error));
  if (tips.error) return fail(toDataError(tips.error));
  return ok({
    tours: (tours.data ?? []).map((t) => ({
      id: t.id,
      tourKey: t.tour_key,
      state: t.tour_state,
      step: t.step,
    })),
    dismissedTips: (tips.data ?? []).map((t) => t.tip_key),
  });
}

/**
 * Records a tour's progress: the first call records that it was offered; later calls move its state
 * and step. A replay is `Started` at step 0. The database refuses offering a tour twice.
 */
export async function recordTour(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly membershipId: string;
    readonly tourKey: string;
    readonly state: TourState;
    readonly step?: number;
  },
): Promise<Result<null>> {
  const existing = await db
    .from("tour_progress")
    .select("id")
    .eq("membership_id", input.membershipId)
    .eq("tour_key", input.tourKey)
    .is("deleted_at", null)
    .maybeSingle();
  if (existing.error) return fail(toDataError(existing.error));
  const step = input.step ?? 0;
  const { error } = existing.data
    ? await db
        .from("tour_progress")
        .update({ tour_state: input.state, step })
        .eq("id", existing.data.id)
    : await db.from("tour_progress").insert({
        org_id: input.orgId,
        membership_id: input.membershipId,
        tour_key: input.tourKey,
        tour_state: input.state,
        step,
      });
  return error ? fail(toDataError(error)) : ok(null);
}

/** Dismisses a tip so it is never shown again. Dismissing twice is a no-op. */
export async function dismissTip(
  db: XosClient,
  input: { readonly orgId: string; readonly membershipId: string; readonly tipKey: string },
): Promise<Result<null>> {
  const { error } = await db.from("tip_dismissals").insert({
    org_id: input.orgId,
    membership_id: input.membershipId,
    tip_key: input.tipKey,
  });
  if (error && error.code !== "23505") return fail(toDataError(error));
  return ok(null);
}

/** Shows every tip again: the person's dismissals are reset (soft deleted). */
export async function resetTips(db: XosClient, membershipId: string): Promise<Result<null>> {
  const { error } = await db
    .from("tip_dismissals")
    .update({ deleted_at: new Date().toISOString() })
    .eq("membership_id", membershipId)
    .is("deleted_at", null);
  return error ? fail(toDataError(error)) : ok(null);
}
