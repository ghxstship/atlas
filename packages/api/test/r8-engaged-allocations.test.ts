/**
 * Contract tests for R8's allocations from the engaged party's side (RRR-188, migrations 2700 and 2701): the
 * engagement's allocations, what may be asked for and the caller's parking passes read back from their api_external
 * views, and request, split, unsplit and withdraw through their RPCs. Requests run through `contractApp` against the
 * in-memory client and every success is checked against openapi/v1.json with `expectContract`.
 */
import { describe, expect, it } from "vitest";
import { handlers as gateway } from "../src/handlers/gateway.ts";
import { contractApp, expectContract, testContext } from "./support/contract.ts";
import { memoryDb, refusal, requests, success } from "./support/memory-db.ts";
import type { MemoryDb, Row } from "./support/memory-db.ts";

const ME = testContext().personId as string;
const id = (n: number) => `0192f1e2-7c3a-7b4d-9e8f-${String(28800 + n).padStart(12, "0")}`;
const ENGAGEMENT = id(1);
const ENTRY = id(2);
const POOL = id(3);
const SHARE = id(4);
const CLASS = id(5);
const PASS = id(6);
const PROJECT = id(7);

const allocation = (allocationId: string, over: Row = {}): Row => ({
  allocation_id: allocationId,
  engagement_id: ENGAGEMENT,
  roster_entry_id: null,
  person_name: null,
  kind: "Asset",
  item_name: "Radios",
  quantity: 6,
  allocation_state: "Approved",
  display_status: "Reserved",
  reserved_quantity: 6,
  issued_quantity: 0,
  returned_quantity: 0,
  parent_allocation_id: null,
  needed_from: "2027-06-01T12:00:00.000Z",
  needed_to: "2027-06-05T12:00:00.000Z",
  needed_time_zone: "America/New_York",
  requested_by_me: true,
  decline_reason: null,
  ...over,
});

function world() {
  const db: MemoryDb = memoryDb(
    {
      "api_external.advance_allocations": [
        allocation(POOL),
        allocation(SHARE, {
          roster_entry_id: ENTRY,
          person_name: "Kai Morgan",
          parent_allocation_id: POOL,
          quantity: 1,
          reserved_quantity: 1,
          requested_by_me: false,
        }),
      ],
      "api_external.requestable_items": [
        {
          engagement_id: ENGAGEMENT,
          item_kind: "asset_class",
          item_id: CLASS,
          name: "Radios",
          offering: "Radios",
          cap_per_engagement: 6,
          cap_per_person: 2,
          requested_quantity: 6,
        },
        {
          engagement_id: ENGAGEMENT,
          item_kind: "service",
          item_id: null,
          name: "Per Diem",
          offering: "Per Diem",
          cap_per_engagement: null,
          cap_per_person: null,
          requested_quantity: 0,
        },
      ],
      "api_external.my_parking_passes": [
        {
          credential_id: PASS,
          project_id: PROJECT,
          credential_number: "P-0042",
          category_name: "Crew Parking",
          valid_from: "2027-06-01T00:00:00.000Z",
          valid_to: "2027-06-06T00:00:00.000Z",
          revoked_at: null,
          zone_codes: ["LOT-A"],
          zone_names: ["Lot A"],
          vehicle_make: "Ford",
          vehicle_model: "Transit",
          vehicle_color: "White",
          holder_person_id: ME,
        },
      ],
    },
    {
      request_engaged_allocation: (args) => {
        if (Number(args["p_quantity"]) > 6)
          throw refusal("allocation_cap_engagement", "Over the cap.");
        return POOL;
      },
      split_engaged_allocation: () => [SHARE],
      unsplit_engaged_allocation: () => 1,
      withdraw_engaged_allocation: () => null,
    },
  );
  const app = contractApp({ handlers: [gateway], db });
  return { db, app, http: requests(app) };
}

describe("Engaged allocations contract: reads", () => {
  it("lists and reads an engagement's allocations with the computed status", async () => {
    const { http } = world();
    const page = (await expectContract(
      await success(http.get("/engaged-allocations")),
      "engagedAllocations.list",
    )) as { data: Row[] };
    expect(page.data.map((r) => r["allocation_id"])).toEqual(expect.arrayContaining([POOL, SHARE]));
    const one = (await expectContract(
      await success(http.get(`/engaged-allocations/${SHARE}`)),
      "engagedAllocations.get",
    )) as Row;
    expect(one).toMatchObject({ display_status: "Reserved", person_name: "Kai Morgan" });
  });

  it("lists what may be asked for and the caller's parking passes, never a plate", async () => {
    const { http } = world();
    const items = (await expectContract(
      await success(http.get("/requestable-items")),
      "requestableItems.list",
    )) as { data: Row[] };
    expect(items.data.map((r) => r["item_kind"]).sort()).toEqual(["asset_class", "service"]);
    const passes = (await expectContract(
      await success(http.get("/my-parking-passes")),
      "myParkingPasses.list",
    )) as { data: Row[] };
    expect(passes.data[0]).toMatchObject({ zone_names: ["Lot A"], vehicle_make: "Ford" });
    expect(passes.data[0]).not.toHaveProperty("plate");
  });
});

describe("Engaged allocations contract: writes", () => {
  const body = {
    engagement_id: ENGAGEMENT,
    item_kind: "asset_class",
    item_id: CLASS,
    quantity: 6,
    needed_from: "2027-06-01T12:00:00Z",
    needed_to: "2027-06-05T12:00:00Z",
    time_zone: "America/New_York",
  };

  it("requests through its RPC and refuses with the rule", async () => {
    const { db, http } = world();
    const made = await success(http.post("/engaged-allocations/request", body));
    expect(made.status).toBe(201);
    await expectContract(made, "engagedAllocations.request");
    expect(db.calls.find((c) => c.name === "request_engaged_allocation")?.args).toMatchObject({
      p_engagement_id: ENGAGEMENT,
      p_item_kind: "asset_class",
      p_item_id: CLASS,
      p_quantity: 6,
    });
    const over = await http.post("/engaged-allocations/request", { ...body, quantity: 7 });
    expect(over.status).toBe(422);
    expect(await over.json()).toMatchObject({ rule: "allocation_cap_engagement" });
  });

  it("splits, unsplits and withdraws", async () => {
    const { db, http } = world();
    const splitting = await success(
      http.post(`/engaged-allocations/${POOL}/split`, {
        parts: [{ roster_entry_id: ENTRY, quantity: 1 }],
      }),
    );
    const split = (await expectContract(splitting, "engagedAllocations.split")) as Row;
    expect(split).toEqual({ allocation_ids: [SHARE] });
    expect(db.calls.find((c) => c.name === "split_engaged_allocation")?.args).toEqual({
      p_pool_allocation_id: POOL,
      p_parts: [{ roster_entry_id: ENTRY, quantity: 1 }],
    });
    const unsplitting = await success(http.post(`/engaged-allocations/${SHARE}/unsplit`, {}));
    const back = (await expectContract(unsplitting, "engagedAllocations.unsplit")) as Row;
    expect(back).toEqual({ quantity: 1 });
    const withdrawn = await success(
      http.post(`/engaged-allocations/${SHARE}/withdraw`, { reason: "Not needed." }),
    );
    await expectContract(withdrawn, "engagedAllocations.withdraw");
    expect(db.calls.find((c) => c.name === "withdraw_engaged_allocation")?.args).toEqual({
      p_allocation_id: SHARE,
      p_reason: "Not needed.",
    });
  });
});
