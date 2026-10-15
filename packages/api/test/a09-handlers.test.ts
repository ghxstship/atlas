/**
 * Contract tests for A09's Places and Safety (permit engine and inspections) handlers (Section 18,
 * gate 5). Requests run through `contractApp` against the in-memory client; every response is checked
 * against openapi/v1.json with `expectContract`. Refusals (422), hidden rows (404), stale state (409)
 * and stale If-Match (412) are checked too.
 */
import { describe, expect, it } from "vitest";
import { handlers as places } from "../src/handlers/places.ts";
import { handlers as safety } from "../src/handlers/safety.ts";
import { contractApp, expectContract, testContext } from "./support/contract.ts";
import { memoryDb, refusal, requests, success, tenantRow } from "./support/memory-db.ts";
import type { MemoryDb, Row } from "./support/memory-db.ts";

const ORG = testContext().org?.id as string;
const ME = testContext().personId as string;
const id = (n: number) => `0192f1e2-7c3a-7b4d-9e8f-${String(9000 + n).padStart(12, "0")}`;
const PROJECT = id(1);
const VENUE = id(2);
const SPACE = id(3);
const ZONE = id(4);
const DOC = id(5);
const PLAN = id(6);
const PIN = id(7);
const FENCE = id(8);
const REQ = id(9);
const CAP = id(10);
const REC = id(11);
const LINE = id(12);
const TPL = id(13);
const ITEM = id(14);
const INSP = id(15);
const RESULT = id(16);
const PERMIT = id(17);
const RECORD = id(18);
const POLYGON = {
  type: "Polygon",
  coordinates: [
    [
      [-80.19, 25.77],
      [-80.18, 25.77],
      [-80.18, 25.78],
      [-80.19, 25.77],
    ],
  ],
};

function world() {
  const db: MemoryDb = memoryDb(
    {
      venues: [
        tenantRow(VENUE, ORG, {
          name: "Northwind Pier Pavilion",
          street_address: "1 Pier Way",
          locality: "Miami",
          postal_code: "33132",
          jurisdiction_id: "US-FL-MIAMI-DADE",
          time_zone: "America/New_York",
          venue_latitude: 25.7743,
          venue_longitude: -80.1937,
        }),
      ],
      spaces: [
        tenantRow(SPACE, ORG, {
          venue_id: VENUE,
          name: "Main Deck",
          urid: null,
          capacity: 1200,
          area_sq_ft: null,
        }),
      ],
      zones: [
        tenantRow(ZONE, ORG, {
          venue_id: VENUE,
          space_id: SPACE,
          code: "FOH",
          name: "Front of House",
        }),
      ],
      capability_documents: [
        tenantRow(DOC, ORG, {
          venue_id: VENUE,
          title: "Tech Pack",
          document_uri: "https://docs.example.com/tech-pack.pdf",
          valid_from: "2027-01-01",
          valid_to: null,
          is_frozen: false,
        }),
      ],
      site_plans: [
        tenantRow(PLAN, ORG, {
          project_id: PROJECT,
          venue_id: VENUE,
          title: "Ground Plan",
          image_uri: "plans/ground.png",
        }),
      ],
      site_plan_pins: [
        tenantRow(PIN, ORG, {
          site_plan_id: PLAN,
          label: "FOH Mix",
          x_ratio: 0.5,
          y_ratio: 0.625,
          zone_id: ZONE,
          record_id: null,
        }),
      ],
      geofences: [tenantRow(FENCE, ORG, { venue_id: VENUE, zone_id: null, name: "Pier Fence" })],
      geofence_shapes: [{ id: FENCE, boundary_geojson: POLYGON }],
      capability_statements: [
        tenantRow(REQ, ORG, {
          project_id: PROJECT,
          direction: "Require",
          venue_id: null,
          counterparty_id: null,
          urid: "4000.01.01",
          description: "Seats for 1,200.",
          quantity: 1200,
          unit_basis: null,
          is_critical: true,
          assertion_word: "UNKNOWN",
        }),
        tenantRow(CAP, ORG, {
          project_id: PROJECT,
          direction: "Provide",
          venue_id: VENUE,
          counterparty_id: null,
          urid: "4000.01.01",
          description: "Pavilion seats 1,200.",
          quantity: 1200,
          unit_basis: null,
          is_critical: false,
          assertion_word: "DOCUMENTED",
        }),
      ],
      reconciliations: [
        tenantRow(REC, ORG, {
          project_id: PROJECT,
          reconciled_at: "2026-10-01T12:00:00.000Z",
          note: null,
        }),
      ],
      reconciliation_lines: [
        tenantRow(LINE, ORG, {
          reconciliation_id: REC,
          requirement_id: REQ,
          capability_id: CAP,
          result: "Met",
        }),
      ],
      inspection_templates: [tenantRow(TPL, ORG, { name: "Stage Walk" })],
      inspection_items: [
        tenantRow(ITEM, ORG, {
          inspection_template_id: TPL,
          position: 1,
          prompt: "Deck edges guarded",
          is_critical: true,
        }),
      ],
      inspections: [
        tenantRow(INSP, ORG, {
          project_id: PROJECT,
          inspection_template_id: TPL,
          record_id: null,
          inspector_person_id: ME,
          inspected_at: "2027-03-12T10:00:00.000Z",
          signed_off_by: null,
          signed_off_at: null,
        }),
      ],
      inspection_results: [
        tenantRow(RESULT, ORG, {
          inspection_id: INSP,
          inspection_item_id: ITEM,
          project_id: PROJECT,
          result_enum_id: "ENM-082",
          note: null,
          photo_uri: null,
        }),
      ],
      permit_requirements: [
        tenantRow(PERMIT, ORG, {
          project_id: PROJECT,
          permit_rule: "Special event",
          record_id: null,
        }),
      ],
      records: [],
      "xpms.dim_permit_rule": [
        {
          rule: "Special event",
          permit: "Special Events Permit",
          ahj: "City of Miami Special Events Office",
          lead_time: "4-6 wks",
          trigger_type: "project",
          jurisdiction_id: "US-FL-MIAMI-DADE",
        },
      ],
    },
    {
      set_venue_location: (args, self) => {
        const v = self.tables["venues"]?.find((r) => r["id"] === args["p_venue_id"]) as Row;
        v["venue_latitude"] = args["p_latitude"];
        v["venue_longitude"] = args["p_longitude"];
        return v["id"];
      },
      save_geofence: (args, self) => {
        if ((args["p_boundary_geojson"] as Row)["type"] !== "Polygon")
          throw refusal("geofence_polygon");
        const newId = (args["p_id"] as string | null) ?? id(80);
        if (args["p_id"] === null) {
          self.tables["geofences"]?.push(
            tenantRow(newId, ORG, {
              venue_id: args["p_venue_id"],
              zone_id: args["p_zone_id"],
              name: args["p_name"],
            }),
          );
          self.tables["geofence_shapes"]?.push({
            id: newId,
            boundary_geojson: args["p_boundary_geojson"],
          });
        } else {
          const g = self.tables["geofences"]?.find((r) => r["id"] === newId) as Row;
          g["name"] = args["p_name"];
        }
        return newId;
      },
      reconcile_project: (args, self) => {
        self.tables["reconciliations"]?.push(
          tenantRow(id(81), ORG, {
            project_id: args["p_project_id"],
            reconciled_at: "2026-10-02T09:00:00.000Z",
            note: args["p_note"],
          }),
        );
        self.tables["reconciliation_lines"]?.push(
          tenantRow(id(82), ORG, {
            reconciliation_id: id(81),
            requirement_id: REQ,
            capability_id: null,
            result: "Unknown",
          }),
        );
        return id(81);
      },
      start_inspection: (args, self) => {
        self.tables["inspections"]?.push(
          tenantRow(id(83), ORG, {
            project_id: args["p_project_id"],
            inspection_template_id: args["p_template_id"],
            record_id: null,
            inspector_person_id: ME,
            inspected_at: args["p_inspected_at"] ?? "2026-10-02T09:00:00.000Z",
            signed_off_by: null,
            signed_off_at: null,
          }),
        );
        return id(83);
      },
      sign_off_inspection: (args, self) => {
        const i = self.tables["inspections"]?.find(
          (r) => r["id"] === args["p_inspection_id"],
        ) as Row;
        if (i["inspector_person_id"] === ME) throw refusal("sod_approval_requester");
        i["signed_off_by"] = id(99);
        i["signed_off_at"] = "2026-10-02T09:00:00.000Z";
        return i["id"];
      },
      record_inspection_result: (args, self) => {
        const existing = self.tables["inspection_results"]?.find(
          (r) =>
            r["inspection_id"] === args["p_inspection_id"] &&
            r["inspection_item_id"] === args["p_item_id"],
        );
        if (existing) {
          existing["result_enum_id"] = args["p_result_enum_id"];
          existing["note"] = args["p_note"];
          return existing["id"];
        }
        self.tables["inspection_results"]?.push(
          tenantRow(id(84), ORG, {
            inspection_id: args["p_inspection_id"],
            inspection_item_id: args["p_item_id"],
            project_id: PROJECT,
            result_enum_id: args["p_result_enum_id"],
            note: args["p_note"],
            photo_uri: args["p_photo_uri"],
          }),
        );
        return id(84);
      },
      generate_permit_requirements: () => 0,
      track_permit_requirement: (args, self) => {
        const r = self.tables["permit_requirements"]?.find(
          (x) => x["id"] === args["p_requirement_id"],
        ) as Row;
        if (r["record_id"] !== null) throw refusal("permit_requirement_tracked");
        r["record_id"] = RECORD;
        self.tables["records"]?.push({ id: RECORD, record_state: "Proposed" });
        return RECORD;
      },
      transition_record: (args, self) => {
        const r = self.tables["records"]?.find((x) => x["id"] === args["p_record_id"]) as Row;
        if (args["p_next"] === "Complete") throw refusal("record_transition_not_allowed");
        r["record_state"] = args["p_next"];
        return id(85);
      },
    },
    {
      capability_documents: { is_frozen: false, valid_to: null },
      capability_statements: {
        is_critical: false,
        assertion_domain: "capability",
        assertion_word: "UNKNOWN",
        quantity: null,
        unit_basis: null,
        counterparty_id: null,
      },
      inspection_items: { is_critical: false },
    },
  );
  const app = contractApp({ handlers: [places, safety], db });
  return { db, http: requests(app) };
}

const STALE = 'W/"MjAyMC0wMS0wMQ"';

/**
 * The five table operations of one resource, each as a success response, plus the stale and missing
 * checks. The caller names every operationId in its own expectContract call (gate 5 coverage).
 */
async function exercise(path: string, existing: string, create: Row, update: Row) {
  const { http } = world();
  const list = await success(http.get(path));
  const get = await success(http.get(`${path}/${existing}`));
  const created = await success(http.post(path, create));
  const updated = await success(http.patch(`${path}/${existing}`, update));
  const stale = await http.patch(`${path}/${existing}`, update, STALE);
  const removed = await success(http.delete(`${path}/${existing}`));
  const missing = await http.get(`${path}/${existing}`);
  expect(stale.status).toBe(412);
  expect(missing.status).toBe(404);
  return { list, get, created, updated, removed };
}

describe("Places contract: venues", () => {
  it("lists, reads, creates with a location, edits, relocates and archives venues", async () => {
    const { db, http } = world();
    const listed = await success(http.get("/venues"));
    const page = (await expectContract(listed, "venues.list")) as { data: Row[] };
    expect(page.data[0]?.["latitude"]).toBe(25.7743);
    const read = await success(http.get(`/venues/${VENUE}`));
    await expectContract(read, "venues.get");
    const made = await success(
      http.post("/venues", {
        name: "Harbor Hall",
        jurisdiction_id: "US-FL-MIAMI-DADE",
        time_zone: "America/New_York",
        street_address: null,
        locality: "Miami",
        postal_code: null,
        latitude: 25.78,
        longitude: -80.19,
      }),
    );
    const venue = (await expectContract(made, "venues.create")) as Row;
    expect(venue["longitude"]).toBe(-80.19);
    expect(db.calls.some((c) => c.name === "set_venue_location")).toBe(true);
    const moved = await success(
      http.patch(`/venues/${VENUE}`, { locality: "Miami Beach", latitude: null, longitude: null }),
    );
    const after = (await expectContract(moved, "venues.update")) as Row;
    expect(after["latitude"]).toBeNull();
    expect((await http.patch(`/venues/${VENUE}`, { latitude: 10 })).status).toBe(422);
    expect((await http.patch(`/venues/${VENUE}`, { name: "Late" }, STALE)).status).toBe(412);
    const removed = await success(http.delete(`/venues/${VENUE}`));
    await expectContract(removed, "venues.delete");
    expect((await http.get(`/venues/${VENUE}`)).status).toBe(404);
  });
});

describe("Places contract: spaces, zones, documents, plans and pins", () => {
  it("serves spaces", async () => {
    const r = await exercise(
      "/spaces",
      SPACE,
      { venue_id: VENUE, name: "Lower Deck", capacity: null, area_sq_ft: 900 },
      { name: "Upper Deck" },
    );
    await expectContract(r.list, "spaces.list");
    await expectContract(r.get, "spaces.get");
    await expectContract(r.created, "spaces.create");
    await expectContract(r.updated, "spaces.update");
    await expectContract(r.removed, "spaces.delete");
  });

  it("serves zones", async () => {
    const r = await exercise(
      "/zones",
      ZONE,
      { venue_id: VENUE, code: "DOCK-1", name: "Loading Dock" },
      { name: "Front of House North", space_id: null },
    );
    await expectContract(r.list, "zones.list");
    await expectContract(r.get, "zones.get");
    await expectContract(r.created, "zones.create");
    await expectContract(r.updated, "zones.update");
    await expectContract(r.removed, "zones.delete");
  });

  it("serves capability documents and freezes one", async () => {
    const r = await exercise(
      "/capability-documents",
      DOC,
      {
        venue_id: VENUE,
        title: "Rigging Plot",
        document_uri: "https://docs.example.com/rigging.pdf",
        valid_from: "2027-01-01",
      },
      { title: "Tech Pack 2027" },
    );
    await expectContract(r.list, "capabilityDocuments.list");
    await expectContract(r.get, "capabilityDocuments.get");
    await expectContract(r.created, "capabilityDocuments.create");
    await expectContract(r.updated, "capabilityDocuments.update");
    await expectContract(r.removed, "capabilityDocuments.delete");
    const { db, http } = world();
    const frozen = await success(http.post(`/capability-documents/${DOC}/freeze`));
    const doc = (await expectContract(frozen, "capabilityDocuments.freeze")) as Row;
    expect(doc["frozen"]).toBe(true);
    db.fail("capability_documents", refusal("capability_document_frozen"));
    expect((await http.patch(`/capability-documents/${DOC}`, { title: "Changed" })).status).toBe(
      422,
    );
    expect((await http.post(`/capability-documents/${id(70)}/freeze`)).status).toBe(404);
  });

  it("serves site plans", async () => {
    const r = await exercise(
      "/site-plans",
      PLAN,
      { project_id: PROJECT, title: "Upper Plan", image_uri: "plans/upper.png" },
      { venue_id: null },
    );
    await expectContract(r.list, "sitePlans.list");
    await expectContract(r.get, "sitePlans.get");
    await expectContract(r.created, "sitePlans.create");
    await expectContract(r.updated, "sitePlans.update");
    await expectContract(r.removed, "sitePlans.delete");
  });

  it("serves site plan pins with fractional positions", async () => {
    const r = await exercise(
      "/site-plan-pins",
      PIN,
      { site_plan_id: PLAN, label: "First Aid", x: 0.1, y: 0.9 },
      { x: 0.2 },
    );
    await expectContract(r.list, "sitePlanPins.list");
    await expectContract(r.get, "sitePlanPins.get");
    const pin = (await expectContract(r.created, "sitePlanPins.create")) as Row;
    expect(pin["x"]).toBe(0.1);
    await expectContract(r.updated, "sitePlanPins.update");
    await expectContract(r.removed, "sitePlanPins.delete");
  });
});

describe("Places contract: geofences", () => {
  it("reads and writes GeoJSON polygons and refuses other shapes", async () => {
    const { db, http } = world();
    const listed = await success(http.get("/geofences"));
    const page = (await expectContract(listed, "geofences.list")) as { data: Row[] };
    expect((page.data[0]?.["boundary"] as Row)["type"]).toBe("Polygon");
    const read = await success(http.get(`/geofences/${FENCE}`));
    await expectContract(read, "geofences.get");
    const made = await success(
      http.post("/geofences", { name: "Dock Fence", venue_id: VENUE, boundary: POLYGON }),
    );
    await expectContract(made, "geofences.create");
    const edited = await success(http.patch(`/geofences/${FENCE}`, { name: "Pier Fence North" }));
    const fence = (await expectContract(edited, "geofences.update")) as Row;
    expect(fence["name"]).toBe("Pier Fence North");
    db.fail("rpc:save_geofence", refusal("geofence_polygon"));
    expect((await http.patch(`/geofences/${FENCE}`, { name: "Again" })).status).toBe(422);
    const removed = await success(http.delete(`/geofences/${FENCE}`));
    await expectContract(removed, "geofences.delete");
    expect((await http.get(`/geofences/${FENCE}`)).status).toBe(404);
  });
});

describe("Places contract: requirements and reconciliation", () => {
  it("serves requirements and capabilities in one shape", async () => {
    const r = await exercise(
      "/requirements",
      REQ,
      {
        project_id: PROJECT,
        direction: "Provide",
        venue_id: VENUE,
        urid: "4000.01.01",
        description: "Rigging points rated 1 t.",
        assertion_word: "CLAIMED",
      },
      { quantity: 1000 },
    );
    await expectContract(r.list, "requirements.list");
    await expectContract(r.get, "requirements.get");
    await expectContract(r.created, "requirements.create");
    await expectContract(r.updated, "requirements.update");
    await expectContract(r.removed, "requirements.delete");
  });

  it("runs a reconciliation and derives its counts from the lines", async () => {
    const { db, http } = world();
    const listed = await success(http.get("/reconciliations"));
    const page = (await expectContract(listed, "reconciliations.list")) as { data: Row[] };
    expect(page.data[0]?.["met_count"]).toBe(1);
    const read = await success(http.get(`/reconciliations/${REC}`));
    await expectContract(read, "reconciliations.get");
    const ran = await success(
      http.post("/reconciliations", { project_id: PROJECT, note: "Walk." }),
    );
    const run = (await expectContract(ran, "reconciliations.create")) as Row;
    expect(run["unknown_count"]).toBe(1);
    db.fail("rpc:reconcile_project", { code: "42501", message: "no" });
    expect((await http.post("/reconciliations", { project_id: PROJECT })).status).toBe(404);
    const lines = await success(http.get("/reconciliation-lines"));
    await expectContract(lines, "reconciliationLines.list");
    const line = await success(http.get(`/reconciliation-lines/${LINE}`));
    await expectContract(line, "reconciliationLines.get");
  });
});

describe("Safety contract: templates, items and inspections", () => {
  it("serves inspection templates", async () => {
    const r = await exercise(
      "/inspection-templates",
      TPL,
      { name: "Exit Walk" },
      { name: "Daily" },
    );
    await expectContract(r.list, "inspectionTemplates.list");
    await expectContract(r.get, "inspectionTemplates.get");
    await expectContract(r.created, "inspectionTemplates.create");
    await expectContract(r.updated, "inspectionTemplates.update");
    await expectContract(r.removed, "inspectionTemplates.delete");
  });

  it("serves inspection items", async () => {
    const r = await exercise(
      "/inspection-items",
      ITEM,
      { inspection_template_id: TPL, position: 2, prompt: "Exits clear" },
      { is_critical: false },
    );
    await expectContract(r.list, "inspectionItems.list");
    await expectContract(r.get, "inspectionItems.get");
    await expectContract(r.created, "inspectionItems.create");
    await expectContract(r.updated, "inspectionItems.update");
    await expectContract(r.removed, "inspectionItems.delete");
  });

  it("starts, reads, links and signs off inspections with separation of duties", async () => {
    const { db, http } = world();
    const listed = await success(http.get("/inspections"));
    await expectContract(listed, "inspections.list");
    const read = await success(http.get(`/inspections/${INSP}`));
    await expectContract(read, "inspections.get");
    const started = await success(
      http.post("/inspections", { project_id: PROJECT, inspection_template_id: TPL }),
    );
    const inspection = (await expectContract(started, "inspections.create")) as Row;
    expect(inspection["inspector_person_id"]).toBe(ME);
    const linked = await success(http.patch(`/inspections/${INSP}`, { record_id: null }));
    await expectContract(linked, "inspections.update");
    const own = await http.post(`/inspections/${INSP}/sign-off`);
    expect(own.status).toBe(422);
    await expectContract(own, "inspections.signOff");
    (db.tables["inspections"]?.find((r) => r["id"] === INSP) as Row)["inspector_person_id"] =
      id(98);
    const signed = await success(http.post(`/inspections/${INSP}/sign-off`));
    const after = (await expectContract(signed, "inspections.signOff")) as Row;
    expect(after["signed_off_at"]).not.toBeNull();
  });

  it("records results through the RPC that opens punch items", async () => {
    const { db, http } = world();
    const listed = await success(http.get("/inspection-results"));
    await expectContract(listed, "inspectionResults.list");
    const read = await success(http.get(`/inspection-results/${RESULT}`));
    await expectContract(read, "inspectionResults.get");
    db.tables["inspection_results"] = [];
    const made = await success(
      http.post("/inspection-results", {
        inspection_id: INSP,
        inspection_item_id: ITEM,
        result_enum_id: "ENM-084",
        note: "Rail missing.",
      }),
    );
    const result = (await expectContract(made, "inspectionResults.create")) as Row;
    expect(result["project_id"]).toBe(PROJECT);
    const rpcCall = db.calls.find((c) => c.name === "record_inspection_result");
    expect(rpcCall?.args["p_result_enum_id"]).toBe("ENM-084");
    const changed = await success(
      http.patch(`/inspection-results/${id(84)}`, { result_enum_id: "ENM-082" }),
    );
    const after = (await expectContract(changed, "inspectionResults.update")) as Row;
    expect(after["result_enum_id"]).toBe("ENM-082");
    db.fail("rpc:record_inspection_result", refusal("inspection_signed_off"));
    expect((await http.patch(`/inspection-results/${id(84)}`, { note: "Late." })).status).toBe(422);
  });
});

describe("Safety contract: permit engine", () => {
  it("reads requirements with canon facts and generates from canon", async () => {
    const { db, http } = world();
    const listed = await success(http.get("/permit-requirements"));
    const page = (await expectContract(listed, "permitRequirements.list")) as { data: Row[] };
    expect(page.data[0]).toMatchObject({
      rule: "Special event",
      lead_time: "4-6 wks",
      permit_state: null,
    });
    const read = await success(http.get(`/permit-requirements/${PERMIT}`));
    await expectContract(read, "permitRequirements.get");
    const generated = await success(
      http.post("/permit-requirements/generate", { project_id: PROJECT }),
    );
    await expectContract(generated, "permitRequirements.generate");
    db.fail(
      "rpc:generate_permit_requirements",
      refusal("jurisdiction_no_answer", "NO_ANSWER: unresolved."),
    );
    const noAnswer = await http.post("/permit-requirements/generate", { project_id: PROJECT });
    expect(noAnswer.status).toBe(422);
    await expectContract(noAnswer, "permitRequirements.generate");
  });

  it("tracks a requirement and moves its Permit record with compare-and-set", async () => {
    const { http } = world();
    const early = await http.post(`/permit-requirements/${PERMIT}/transitions`, {
      expected_state: "Proposed",
      to_state: "Scheduled",
    });
    expect(early.status).toBe(409);
    const tracked = await success(http.post(`/permit-requirements/${PERMIT}/track`, {}));
    const req = (await expectContract(tracked, "permitRequirements.track")) as Row;
    expect(req["permit_state"]).toBe("Proposed");
    const again = await http.post(`/permit-requirements/${PERMIT}/track`, {});
    expect(again.status).toBe(422);
    await expectContract(again, "permitRequirements.track");
    const moved = await success(
      http.post(`/permit-requirements/${PERMIT}/transitions`, {
        expected_state: "Proposed",
        to_state: "Scheduled",
        reason: "Filed.",
      }),
    );
    const after = (await expectContract(moved, "permitRequirements.transition")) as Row;
    expect(after["permit_state"]).toBe("Scheduled");
    const stale = await http.post(`/permit-requirements/${PERMIT}/transitions`, {
      expected_state: "Proposed",
      to_state: "Active",
    });
    expect(stale.status).toBe(409);
    const refusedMove = await http.post(`/permit-requirements/${PERMIT}/transitions`, {
      expected_state: "Scheduled",
      to_state: "Complete",
      reason: "Skip.",
    });
    expect(refusedMove.status).toBe(422);
    await expectContract(refusedMove, "permitRequirements.transition");
  });
});
