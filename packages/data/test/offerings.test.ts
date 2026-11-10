import { describe, expect, it } from "vitest";
import {
  createOfferingRule,
  listEngagementOfferings,
  listOfferingRules,
  OFFERING_KINDS,
  OFFERING_MODES,
  removeOfferingRule,
} from "../src/offerings.ts";
import { errorResponse, okResponse } from "./fake-client.ts";
import { moduleClient, stepsOf } from "./module-client.ts";

const rule = {
  id: "r1",
  project_id: null,
  offering: "Catering",
  external_role_type: "Vendor",
  vendor_class_id: "c1",
  offering_mode: "Provided",
  cap_per_engagement: 10,
  cap_per_person: null,
  vendor_classes: { name: "Backline" },
};

describe("offerings", () => {
  it("lists every offering and mode in the enums' order", () => {
    expect(OFFERING_KINDS).toEqual([
      "Travel",
      "Lodging",
      "Catering",
      "Parking",
      "Uniforms",
      "Per Diem",
      "Radios",
      "Carts",
      "Guest List",
    ]);
    expect(OFFERING_MODES).toEqual(["Not Offered", "Provided", "Reimbursed", "Buyout"]);
  });

  it("reads an engagement's offerings from the external view", async () => {
    const { db, calls } = moduleClient({
      "api_external:from:engagement_offerings": [
        okResponse([
          {
            offering: "Travel",
            offering_mode: "Provided",
            cap_per_engagement: null,
            cap_per_person: 2,
          },
          { offering: null, offering_mode: null, cap_per_engagement: null, cap_per_person: null },
        ]),
        errorResponse("42501", "denied"),
      ],
    });
    expect(await listEngagementOfferings(db, "e1")).toEqual({
      ok: true,
      data: [{ offering: "Travel", mode: "Provided", capPerEngagement: null, capPerPerson: 2 }],
    });
    expect(stepsOf(calls[0], "eq")).toEqual([["engagement_id", "e1"]]);
    expect(await listEngagementOfferings(db, "e1")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
  });

  it("lists the org's rules or one project's", async () => {
    const { db, calls } = moduleClient({
      "from:offering_rules": [okResponse([rule]), okResponse([])],
    });
    expect(await listOfferingRules(db, { orgId: "o1", projectId: null })).toEqual({
      ok: true,
      data: [
        {
          id: "r1",
          projectId: null,
          offering: "Catering",
          roleType: "Vendor",
          vendorClassId: "c1",
          vendorClassName: "Backline",
          mode: "Provided",
          capPerEngagement: 10,
          capPerPerson: null,
        },
      ],
    });
    expect(stepsOf(calls[0], "is")).toEqual([
      ["deleted_at", null],
      ["project_id", null],
    ]);
    await listOfferingRules(db, { orgId: "o1", projectId: "p1" });
    expect(stepsOf(calls[1], "eq")).toEqual([
      ["org_id", "o1"],
      ["project_id", "p1"],
    ]);
  });

  it("creates a rule and explains a duplicate audience", async () => {
    const { db, calls } = moduleClient({
      "from:offering_rules": [
        okResponse({ id: "r2" }),
        errorResponse("23505", "duplicate key value violates unique constraint"),
        errorResponse("23514", "violates check constraint offering_rules_caps_need_offer"),
      ],
    });
    const input = {
      orgId: "o1",
      projectId: "p1",
      offering: "Travel" as const,
      roleType: "Crew" as const,
      vendorClassId: null,
      mode: "Not Offered" as const,
      capPerEngagement: null,
      capPerPerson: null,
    };
    expect(await createOfferingRule(db, input)).toEqual({ ok: true, data: { id: "r2" } });
    expect(stepsOf(calls[0], "insert")).toEqual([
      [
        {
          org_id: "o1",
          project_id: "p1",
          offering: "Travel",
          external_role_type: "Crew",
          vendor_class_id: null,
          offering_mode: "Not Offered",
          cap_per_engagement: null,
          cap_per_person: null,
        },
      ],
    ]);
    expect((await createOfferingRule(db, input)).ok).toBe(false);
    const invalid = await createOfferingRule(db, { ...input, capPerPerson: 3 });
    expect(invalid.ok === false && invalid.error.kind).toBe("invalid");
  });

  it("removes a rule by soft delete", async () => {
    const { db, calls } = moduleClient({
      "from:offering_rules": [okResponse([{ id: "r1" }]), okResponse([])],
    });
    expect(await removeOfferingRule(db, "r1")).toEqual({ ok: true, data: null });
    const update = stepsOf(calls[0], "update")[0]?.[0] as { deleted_at: string };
    expect(typeof update.deleted_at).toBe("string");
    expect(await removeOfferingRule(db, "r1")).toEqual({ ok: false, error: { kind: "not-found" } });
  });
});
