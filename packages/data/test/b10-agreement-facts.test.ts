import { describe, expect, it } from "vitest";
import { previewBatch } from "../src/engagement-document-batches.ts";
import { fakeClient, okResponse, type Response } from "./fake-client.ts";

/**
 * B10 (G-130, C15): the facts a generated document merges, read as the caller. Whether the caller may read the project's
 * shifts decides whether a shift field can merge at all, so the question must reach a capability that can answer it:
 * app.my_capabilities_on_project (2994), asserted against the database in pgTAP 2994.
 */

const PROJECT = "0b8f3a52-2f5c-4f0e-9a51-5d1b1c7f0a11";
const ENGAGEMENT = "6f1c2d4e-8a9b-4c3d-9e2f-1a2b3c4d5e6f";
const TEMPLATE = {
  titleTemplate: "Agreement for {{party.name}}",
  bodyTemplate: "Your shifts:\n{{shifts.table}}\n{{shifts.count}} in all.",
  locale: "en-US",
};

function queues(capabilities: readonly string[], shifts: Response[] = []) {
  return {
    "from:projects": [
      okResponse({
        name: "Northwind",
        project_key: "NWS",
        time_zone: "America/New_York",
        org_id: "org",
        organizations: { name: "Demo Productions" },
      }),
    ],
    "from:engagement_resolved": [
      okResponse([
        {
          engagement_id: ENGAGEMENT,
          job_title: "Rigger",
          rate_minor: 85000,
          rate_currency_code: "USD",
          is_masked: false,
          pay_basis: "Day",
          start_date: "2027-06-04",
          end_date: "2027-06-06",
        },
      ]),
    ],
    "from:engagements": [okResponse([{ id: ENGAGEMENT, applications: null }])],
    "from:currencies": [okResponse([{ currency_code: "USD", minor_unit_exponent: 2 }])],
    "rpc:my_capabilities_on_project": [okResponse(capabilities)],
    "rpc:engaged_person_name": [okResponse("Demo Crew")],
    "from:shifts": shifts,
    "from:xpms.role": [okResponse([{ role_code: "5000.51.02", job_title: "Rigger" }])],
  };
}

const SHIFT = {
  engagement_id: ENGAGEMENT,
  starts_at: "2027-06-04T12:00:00Z",
  ends_at: "2027-06-04T22:00:00Z",
  time_zone: "America/New_York",
  role_code: "5000.51.02",
};

describe("previewBatch's shift fields", () => {
  it("merges shifts for a caller who may read them", async () => {
    const { db, calls } = fakeClient(queues(["crew.shift.read"], [okResponse([SHIFT])]));
    const result = await previewBatch(db, {
      projectId: PROJECT,
      template: TEMPLATE,
      engagementIds: [ENGAGEMENT],
    });
    expect(calls.find((c) => c.target === "rpc:my_capabilities_on_project")?.steps[0]).toEqual([
      "args",
      [{ p_project_id: PROJECT, p_capabilities: ["crew.shift.read"] }],
    ]);
    expect(result.ok && result.data[0]?.missing).toEqual([]);
    expect(result.ok && result.data[0]?.body).toContain("Rigger");
    expect(result.ok && result.data[0]?.body).toContain("1 in all.");
    expect(result.ok && result.data[0]?.name).toBe("Demo Crew");
  });

  it("lists every shift field as missing for a caller who may not, and reads no shifts", async () => {
    const { db, calls } = fakeClient(queues([]));
    const result = await previewBatch(db, {
      projectId: PROJECT,
      template: TEMPLATE,
      engagementIds: [ENGAGEMENT],
    });
    expect(result.ok && [...(result.data[0]?.missing ?? [])].sort()).toEqual([
      "shifts.count",
      "shifts.table",
    ]);
    expect(calls.some((c) => c.target === "from:shifts")).toBe(false);
  });

  it("holds back a person with no shift on a template that needs the table", async () => {
    const { db } = fakeClient(queues(["crew.shift.read"], [okResponse([])]));
    const result = await previewBatch(db, {
      projectId: PROJECT,
      template: TEMPLATE,
      engagementIds: [ENGAGEMENT],
    });
    expect(result.ok && result.data[0]?.missing).toEqual(["shifts.table"]);
  });
});
