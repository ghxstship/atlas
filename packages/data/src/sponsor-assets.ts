import type { Database, XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * The sponsor's side of brand asset approvals (migration 1133, finding A38-005, journey 47): the
 * sponsor account's Owner or Admin approves or returns an asset the org submitted, or resubmits a
 * returned one, through app.respond_sponsor_asset. Gateway reads the assets from
 * api_external.sponsor_assets.
 */

export type SponsorReviewState = Database["app"]["Enums"]["review_state"];

/** The moves a sponsor makes, by the state the sponsor sees. */
export const SPONSOR_ASSET_MOVES: Readonly<
  Partial<Record<SponsorReviewState, readonly SponsorReviewState[]>>
> = {
  Submitted: ["Approved", "Returned"],
  Returned: ["Submitted"],
};

export async function respondSponsorAsset(
  db: XosClient,
  input: {
    readonly assetId: string;
    readonly expected: SponsorReviewState;
    readonly next: SponsorReviewState;
    readonly reason: string | null;
  },
): Promise<Result<null>> {
  const { error } = await db.rpc("respond_sponsor_asset", {
    p_sponsor_asset_id: input.assetId,
    p_expected: input.expected,
    p_next: input.next,
    p_reason: input.reason ?? "",
  });
  return error ? fail(toDataError(error)) : ok(null);
}
