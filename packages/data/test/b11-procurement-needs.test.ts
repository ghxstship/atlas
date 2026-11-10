import { describe, expect, it } from "vitest";
import { getProcurementTimeZone, listProcurementNeeds } from "../src/procurement-needs.ts";
import { commercialClient, errorResponse, okResponse } from "./commercial-fake.ts";

/** Procurement needs (B11, RRR-235, G-180): a need's own window stays apart from the span it reads as. */

const row = {
  need_id: "n1",
  project_id: "p1",
  project_key: "NWS",
  time_zone: "America/New_York",
  need_number: 3,
  description: "Truss",
  quantity: 5,
  unit_basis: null,
  asset_class_id: null,
  element_id: null,
  note: null,
  requested_quantity: 15,
  needed_during: null,
  effective_during: '["2027-06-01 12:00:00+00","2027-06-05 12:00:00+00")',
  drafted_quantity: 0,
  ordered_quantity: 0,
  received_quantity: 0,
  need_status: "Needs Ordered",
};

describe("procurement needs", () => {
  it("reads the span of its requests without taking it as its own window", async () => {
    const { db } = commercialClient({ "from:procurement_need_status": [okResponse([row])] });
    const needs = await listProcurementNeeds(db, "o1");
    expect(needs.ok && needs.data[0]).toMatchObject({
      key: "NWS-NEED-3",
      neededFrom: "2027-06-01T12:00:00.000Z",
      neededTo: "2027-06-05T12:00:00.000Z",
      ownFrom: null,
      ownTo: null,
    });
  });

  it("keeps a need's own window when it has one", async () => {
    const during = '["2027-07-01 12:00:00+00","2027-07-02 12:00:00+00")';
    const { db } = commercialClient({
      "from:procurement_need_status": [
        okResponse([{ ...row, needed_during: during, effective_during: during }]),
      ],
    });
    const needs = await listProcurementNeeds(db, "o1");
    expect(needs.ok && needs.data[0]?.ownFrom).toBe("2027-07-01T12:00:00.000Z");
  });

  it("answers a buyer's time zone, null without a capability, and passes on a failure", async () => {
    const { db } = commercialClient({
      "rpc:procurement_time_zone": [
        okResponse("America/New_York"),
        okResponse(null),
        errorResponse("08006", "down"),
      ],
    });
    expect(await getProcurementTimeZone(db, "p1")).toEqual({
      ok: true,
      data: "America/New_York",
    });
    expect(await getProcurementTimeZone(db, "p1")).toEqual({ ok: true, data: null });
    expect((await getProcurementTimeZone(db, "p1")).ok).toBe(false);
  });
});
