import type { Database, XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * The sponsor's side of brand asset approvals (migration 1133, finding A38-005, journey 47): the
 * sponsor account's Owner or Admin approves or returns an asset the org submitted, or resubmits a
 * returned one, through app.respond_sponsor_asset. Gateway reads the assets from
 * api_external.sponsor_assets.
 *
 * R9 (migration 2713) adds the other direction: the sponsor supplies its own asset with files
 * uploaded to party-uploads (app.supply_sponsor_asset) and resubmits it with new files after the
 * org returns it (app.resubmit_sponsor_asset); the org approves those in Atlas.
 */

export type SponsorReviewState = Database["app"]["Enums"]["review_state"];
export type SponsorAssetKind = Database["app"]["Enums"]["sponsor_asset_kind"];
export type SponsorAssetSource = Database["app"]["Enums"]["sponsor_asset_source"];

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

/** The sponsor supplies a brand asset with 1 to 10 registered files (app.supply_sponsor_asset). */
export async function supplySponsorAsset(
  db: XosClient,
  input: {
    readonly entitlementId: string;
    readonly kind: SponsorAssetKind;
    readonly title: string;
    readonly usageNote: string | null;
    readonly dueOn: string | null;
    readonly documentIds: readonly string[];
  },
): Promise<Result<{ id: string }>> {
  const { data, error } = await db.rpc("supply_sponsor_asset", {
    p_sponsor_entitlement_id: input.entitlementId,
    p_asset_kind: input.kind,
    p_title: input.title.trim(),
    // NULL when not given; the generated Args type has no nullable parameters.
    p_usage_note: (input.usageNote?.trim() || null) as string,
    p_due_on: input.dueOn as string,
    p_document_ids: [...input.documentIds],
  });
  return error ? fail(toDataError(error)) : ok({ id: String(data) });
}

/** The sponsor resubmits a returned asset it supplied, with new files (app.resubmit_sponsor_asset). */
export async function resubmitSponsorAsset(
  db: XosClient,
  input: { readonly assetId: string; readonly documentIds: readonly string[]; readonly reason: string | null },
): Promise<Result<null>> {
  const { error } = await db.rpc("resubmit_sponsor_asset", {
    p_sponsor_asset_id: input.assetId,
    p_document_ids: [...input.documentIds],
    ...(input.reason?.trim() ? { p_reason: input.reason.trim() } : {}),
  });
  return error ? fail(toDataError(error)) : ok(null);
}
