import { describe, expect, it } from "vitest";
import {
  createSubmittal,
  getPoAcknowledgment,
  listSubmittals,
  transitionSubmittal,
  updateSubmittal,
} from "../src/procurement.ts";
import {
  createSponsorAsset,
  listEntitlementDeliveries,
  listProofOfPerformance,
  listSponsorAssets,
  recordEntitlementDelivery,
  transitionSponsorAsset,
} from "../src/vendors.ts";
import { commercialClient, errorResponse, okResponse } from "./commercial-fake.ts";

const project = { project_key: "NWL", name: "Summer" };
const vendor = { counterparty: { counterparty_name: "Harbor Audio" } };

describe("purchase order acknowledgment", () => {
  it("reads the vendor's acknowledgment or its absence", async () => {
    const { db } = commercialClient({
      "from:po_acknowledgments": [
        okResponse({ acknowledged_at: "2026-10-01T00:00:00Z", acknowledged_by: "p9" }),
        okResponse(null),
        errorResponse("08006", "down"),
      ],
    });
    expect(await getPoAcknowledgment(db, "po1")).toEqual({
      ok: true,
      data: { acknowledgedAt: "2026-10-01T00:00:00Z", acknowledgedBy: "p9" },
    });
    expect(await getPoAcknowledgment(db, "po2")).toEqual({ ok: true, data: null });
    expect((await getPoAcknowledgment(db, "po3")).ok).toBe(false);
  });
});

describe("submittals", () => {
  const row = {
    id: "s1",
    project_id: "p1",
    submittal_number: 4,
    vendor_id: "v1",
    purchase_order_id: null,
    submittal_kind: "Shop Drawing",
    title: "Deck framing",
    spec_reference: "S-101",
    due_on: null,
    revision: 1,
    submittal_state: "Submitted",
    decided_by: null,
    decided_at: null,
    created_by: "p2",
    project,
    vendor,
  };

  it("lists submittals with keys, optionally for one order", async () => {
    const { db, calls } = commercialClient({
      "from:submittals": [okResponse([row]), okResponse([])],
    });
    const result = await listSubmittals(db, "o1");
    expect(result.ok && result.data[0]).toMatchObject({
      key: "NWL-SUB4",
      vendorName: "Harbor Audio",
      revision: 1,
    });
    await listSubmittals(db, "o1", { purchaseOrderId: "po1" });
    expect(calls[1]?.steps).toContainEqual(["eq", ["purchase_order_id", "po1"]]);
  });

  it("creates, edits and transitions submittals", async () => {
    const { db, calls } = commercialClient({
      "from:submittals": [okResponse({ id: "s1" }), okResponse([{ id: "s1" }])],
      "rpc:transition_submittal": [
        okResponse("t"),
        errorResponse("XR001", "sod_approval_requester: No.", "sod_approval_requester"),
      ],
    });
    const input = {
      kind: "Sample" as const,
      title: " Fabric swatch ",
      specReference: " ",
      dueOn: "",
      purchaseOrderId: null,
    };
    expect((await createSubmittal(db, { ...input, projectId: "p1", vendorId: "v1" })).ok).toBe(
      true,
    );
    expect(calls[0]?.steps[0]?.[1]).toEqual([
      {
        submittal_kind: "Sample",
        title: "Fabric swatch",
        spec_reference: null,
        due_on: null,
        purchase_order_id: null,
        project_id: "p1",
        vendor_id: "v1",
      },
    ]);
    expect((await updateSubmittal(db, "s1", input)).ok).toBe(true);
    const move = { id: "s1", expected: "Proposed", next: "Submitted", reason: "Ready." } as const;
    expect(await transitionSubmittal(db, move)).toEqual({ ok: true, data: null });
    expect(calls[2]?.steps[0]).toEqual([
      "args",
      [{ p_submittal_id: "s1", p_expected: "Proposed", p_next: "Submitted", p_reason: "Ready." }],
    ]);
    expect((await transitionSubmittal(db, move)).ok).toBe(false);
  });
});

describe("sponsor assets and proof of performance", () => {
  it("lists, creates and transitions sponsor assets", async () => {
    const { db, calls } = commercialClient({
      "from:sponsor_assets": [
        okResponse([
          {
            id: "a1",
            sponsor_entitlement_id: "e1",
            asset_kind: "Logo",
            title: "Primary logo",
            usage_note: null,
            due_on: null,
            revision: 0,
            asset_state: "Proposed",
            decided_by: null,
            decided_at: null,
            created_by: "p1",
          },
        ]),
        okResponse({ id: "a2" }),
      ],
      "rpc:transition_sponsor_asset": [okResponse("t"), errorResponse("08006", "down")],
    });
    const list = await listSponsorAssets(db, "o1");
    expect(list.ok && list.data[0]?.entitlementId).toBe("e1");
    expect(
      (
        await createSponsorAsset(db, {
          entitlementId: "e1",
          kind: "Copy",
          title: " Tagline ",
          usageNote: "",
          dueOn: "2026-11-01",
        })
      ).ok,
    ).toBe(true);
    expect(calls[1]?.steps[0]?.[1]).toEqual([
      {
        sponsor_entitlement_id: "e1",
        asset_kind: "Copy",
        title: "Tagline",
        usage_note: null,
        due_on: "2026-11-01",
      },
    ]);
    const move = {
      id: "a2",
      expected: "Proposed",
      next: "Submitted",
      reason: "Uploaded.",
    } as const;
    expect((await transitionSponsorAsset(db, move)).ok).toBe(true);
    expect((await transitionSponsorAsset(db, move)).ok).toBe(false);
  });

  it("records deliveries and reads proof of performance", async () => {
    const { db, calls } = commercialClient({
      "from:entitlement_deliveries": [
        okResponse([
          {
            id: "d1",
            sponsor_entitlement_id: "e1",
            delivered_on: "2026-07-04",
            quantity_delivered: null,
            note: null,
            recorded_by: "p1",
          },
        ]),
        okResponse({ id: "d2" }),
      ],
      "from:sponsor_proof_of_performance": [
        okResponse([
          {
            sponsor_entitlement_id: "e1",
            quantity_owed: 4,
            quantity_delivered: 4,
            delivery_count: 2,
            last_delivered_on: "2026-07-05",
            is_met: true,
          },
          {
            sponsor_entitlement_id: null,
            quantity_owed: null,
            quantity_delivered: null,
            delivery_count: null,
            last_delivered_on: null,
            is_met: null,
          },
        ]),
      ],
    });
    const deliveries = await listEntitlementDeliveries(db, "o1");
    expect(deliveries.ok && deliveries.data[0]?.quantityDelivered).toBeNull();
    expect(
      (
        await recordEntitlementDelivery(db, {
          entitlementId: "e1",
          deliveredOn: "2026-07-06",
          quantityDelivered: 1,
          note: " ",
        })
      ).ok,
    ).toBe(true);
    expect(calls[1]?.steps[0]?.[1]).toEqual([
      {
        sponsor_entitlement_id: "e1",
        delivered_on: "2026-07-06",
        quantity_delivered: 1,
        note: null,
      },
    ]);
    const proof = await listProofOfPerformance(db);
    expect(proof.ok && proof.data.map((p) => [p.isMet, p.deliveryCount])).toEqual([
      [true, 2],
      [false, 0],
    ]);
  });
});
