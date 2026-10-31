import { describe, expect, it } from "vitest";
import {
  respondSponsorAsset,
  resubmitSponsorAsset,
  SPONSOR_ASSET_MOVES,
  supplySponsorAsset,
} from "../src/sponsor-assets.ts";
import { commercialClient, errorResponse, okResponse } from "./commercial-fake.ts";

describe("sponsor asset responses", () => {
  it("answers through app.respond_sponsor_asset and types refusals", async () => {
    const { db, calls } = commercialClient({
      "rpc:respond_sponsor_asset": [
        okResponse("t1"),
        errorResponse(
          "XR001",
          "sponsor_asset_return_reason: Say what to change when returning an asset.",
        ),
      ],
    });
    expect(
      await respondSponsorAsset(db, {
        assetId: "a1",
        expected: "Submitted",
        next: "Approved",
        reason: null,
      }),
    ).toEqual({ ok: true, data: null });
    expect(calls[0]?.steps[0]).toEqual([
      "args",
      [{ p_sponsor_asset_id: "a1", p_expected: "Submitted", p_next: "Approved", p_reason: "" }],
    ]);
    const refused = await respondSponsorAsset(db, {
      assetId: "a1",
      expected: "Submitted",
      next: "Returned",
      reason: "",
    });
    expect(!refused.ok && refused.error.kind).toBe("refusal");
  });

  it("offers approve or return on a submitted asset and resubmit on a returned one", () => {
    expect(SPONSOR_ASSET_MOVES.Submitted).toEqual(["Approved", "Returned"]);
    expect(SPONSOR_ASSET_MOVES.Returned).toEqual(["Submitted"]);
    expect(SPONSOR_ASSET_MOVES.Approved).toBeUndefined();
  });
});

describe("sponsor-supplied assets (R9)", () => {
  it("supplies an asset with its files through app.supply_sponsor_asset", async () => {
    const { db, calls } = commercialClient({
      "rpc:supply_sponsor_asset": [
        okResponse("asset1"),
        errorResponse("XR001", "sponsor_asset_files_required: Attach 1 to 10 files."),
      ],
    });
    const input = {
      entitlementId: "e1",
      kind: "Logo" as const,
      title: " Brightwave logo ",
      usageNote: null,
      dueOn: null,
      documentIds: ["d1"],
    };
    expect(await supplySponsorAsset(db, input)).toEqual({ ok: true, data: { id: "asset1" } });
    expect(calls[0]?.steps[0]).toEqual([
      "args",
      [
        {
          p_sponsor_entitlement_id: "e1",
          p_asset_kind: "Logo",
          p_title: "Brightwave logo",
          p_usage_note: null,
          p_due_on: null,
          p_document_ids: ["d1"],
        },
      ],
    ]);
    const refused = await supplySponsorAsset(db, { ...input, documentIds: [] });
    expect(!refused.ok && refused.error.kind).toBe("refusal");
  });

  it("resubmits a returned asset with new files", async () => {
    const { db, calls } = commercialClient({ "rpc:resubmit_sponsor_asset": [okResponse("t2")] });
    expect(
      await resubmitSponsorAsset(db, {
        assetId: "a1",
        documentIds: ["d2"],
        reason: " White version. ",
      }),
    ).toEqual({
      ok: true,
      data: null,
    });
    expect(calls[0]?.steps[0]).toEqual([
      "args",
      [{ p_sponsor_asset_id: "a1", p_document_ids: ["d2"], p_reason: "White version." }],
    ]);
  });
});
