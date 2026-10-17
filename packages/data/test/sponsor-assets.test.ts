import { describe, expect, it } from "vitest";
import { respondSponsorAsset, SPONSOR_ASSET_MOVES } from "../src/sponsor-assets.ts";
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
