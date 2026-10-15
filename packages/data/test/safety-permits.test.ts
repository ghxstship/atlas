import { describe, expect, it } from "vitest";
import {
  addInspectionItem,
  createInspection,
  createInspectionTemplate,
  generatePermitRequirements,
  getPermitReadiness,
  inspectionProgress,
  listInspectionResultValues,
  listInspections,
  listInspectionTemplates,
  listPeopleNames,
  listPunchItemsForResults,
  listPermitRequirements,
  listPermitRules,
  listRecordStates,
  listRecordTransitions,
  recordInspectionResult,
  renameInspectionTemplate,
  setSafetyArchived,
  signOffInspection,
  swapInspectionItems,
  trackPermitRequirement,
  transitionRecord,
  updateInspectionItem,
  updatePermitDetails,
} from "../src/safety-permits.ts";
import { canonClient } from "./canon-client.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

const noAnswer = errorResponse(
  "XR001",
  "jurisdiction_no_answer: NO_ANSWER: the project's jurisdiction is unresolved, so permit questions have no answer.",
);

describe("canon reads", () => {
  it("reads permit rules exactly as canon states them", async () => {
    const { db, calls } = canonClient({
      "from:dim_permit_rule": [
        okResponse([
          {
            rule: "Special event",
            ordinal: 3,
            trigger_type: "project",
            condition: "Event on property beyond normal use",
            permit: "Special Events Permit",
            ahj: "City Special Events Office",
            lead_time: "4-6 wks",
            jurisdiction_id: "US-FL-MIAMI-DADE",
          },
        ]),
        errorResponse("PGRST000", "x"),
      ],
    });
    const rules = await listPermitRules(db, ["US-FL-MIAMI-DADE"]);
    expect(rules.ok && rules.data[0]).toMatchObject({
      leadTime: "4-6 wks",
      authority: "City Special Events Office",
    });
    expect(calls[0]?.steps).toContainEqual(["in", ["jurisdiction_id", ["US-FL-MIAMI-DADE"]]]);
    expect((await listPermitRules(db)).ok).toBe(false);
  });

  it("reads inspection results, record states and transitions", async () => {
    const { db } = canonClient({
      "from:std_enumeration": [
        okResponse([
          { record_id: "ENM-082", enum_code: "INSP_PASSED", is_default: false },
          { record_id: "ENM-086", enum_code: null, is_default: null },
        ]),
        errorResponse("PGRST000", "x"),
      ],
      "from:dim_record_state": [
        okResponse([{ record_state: "Proposed" }, { record_state: "Ready" }]),
        errorResponse("PGRST000", "x"),
      ],
      "from:lifecycle_transition_rules": [
        okResponse([
          { from_state: "Proposed", to_state: "Ready" },
          { from_state: "Proposed", to_state: "Canceled" },
          { from_state: null, to_state: "Ready" },
        ]),
        errorResponse("PGRST000", "x"),
      ],
    });
    expect(await listInspectionResultValues(db)).toEqual({
      ok: true,
      data: [
        { id: "ENM-082", code: "INSP_PASSED", isDefault: false },
        { id: "ENM-086", code: "", isDefault: false },
      ],
    });
    expect((await listInspectionResultValues(db)).ok).toBe(false);
    expect(await listRecordStates(db)).toEqual({ ok: true, data: ["Proposed", "Ready"] });
    expect((await listRecordStates(db)).ok).toBe(false);
    const moves = await listRecordTransitions(db);
    expect(moves.ok && moves.data.get("Proposed")).toEqual(["Ready", "Canceled"]);
    expect((await listRecordTransitions(db)).ok).toBe(false);
  });
});

describe("permit readiness", () => {
  const jurisdictions = okResponse([
    { jurisdiction_id: "US", parent: null, status: "populated" },
    { jurisdiction_id: "US-FL", parent: "US", status: "populated" },
    { jurisdiction_id: "US-FL-MIAMI-DADE", parent: "US-FL", status: "populated" },
    { jurisdiction_id: "GB", parent: null, status: "declared-unpopulated" },
  ]);

  it("walks the jurisdiction chain for a populated jurisdiction", async () => {
    const { db } = canonClient({
      "from:projects": [okResponse({ jurisdiction_id: "US-FL-MIAMI-DADE" })],
      "from:jurisdiction": [jurisdictions],
    });
    expect(await getPermitReadiness(db, "p1")).toEqual({
      ok: true,
      data: {
        kind: "ready",
        jurisdictionId: "US-FL-MIAMI-DADE",
        chain: ["US-FL-MIAMI-DADE", "US-FL", "US"],
      },
    });
  });

  it("answers NO_ANSWER states for unresolved and unpopulated jurisdictions", async () => {
    const { db } = canonClient({
      "from:projects": [
        okResponse({ jurisdiction_id: null }),
        okResponse({ jurisdiction_id: "GB" }),
        okResponse(null),
        errorResponse("PGRST000", "x"),
        okResponse({ jurisdiction_id: "US" }),
      ],
      "from:jurisdiction": [jurisdictions, errorResponse("PGRST000", "x")],
    });
    expect(await getPermitReadiness(db, "p1")).toEqual({ ok: true, data: { kind: "unresolved" } });
    expect(await getPermitReadiness(db, "p1")).toEqual({
      ok: true,
      data: { kind: "unpopulated", jurisdictionId: "GB" },
    });
    expect(await getPermitReadiness(db, "p1")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect((await getPermitReadiness(db, "p1")).ok).toBe(false);
    expect((await getPermitReadiness(db, "p1")).ok).toBe(false);
  });
});

describe("permit requirements", () => {
  it("generates from canon and reports NO_ANSWER as a refusal", async () => {
    const { db } = fakeClient({
      "rpc:generate_permit_requirements": [okResponse(22), noAnswer],
    });
    expect(await generatePermitRequirements(db, "p1")).toEqual({ ok: true, data: { added: 22 } });
    const refused = await generatePermitRequirements(db, "p1");
    expect(refused.ok === false && refused.error).toMatchObject({
      kind: "refusal",
      rule: "jurisdiction_no_answer",
    });
  });

  it("tracks a requirement with a Permit record", async () => {
    const { db, calls } = fakeClient({
      "rpc:track_permit_requirement": [
        okResponse("r1"),
        errorResponse("XR001", "permit_requirement_tracked: already tracked."),
      ],
    });
    expect(await trackPermitRequirement(db, "q1")).toEqual({ ok: true, data: { recordId: "r1" } });
    expect(calls[0]?.steps[0]).toEqual(["args", [{ p_requirement_id: "q1", p_title: null }]]);
    expect((await trackPermitRequirement(db, "q1", "Special Events Permit")).ok).toBe(false);
  });

  it("lists requirements joined to their Permit records", async () => {
    const { db } = fakeClient({
      "from:permit_requirements": [
        okResponse([
          {
            id: "q1",
            project_id: "p1",
            permit_rule: "Special event",
            record_id: "r1",
            created_at: "a",
          },
          { id: "q2", project_id: "p1", permit_rule: "Alcohol", record_id: null, created_at: "b" },
        ]),
        okResponse([]),
        errorResponse("PGRST000", "x"),
      ],
      "from:records": [
        okResponse([
          {
            id: "r1",
            title: "Special Events Permit",
            record_state: "Scheduled",
            blocker_text: null,
            display_key: "NWL-7",
          },
        ]),
      ],
      "from:record_permit": [
        okResponse([
          {
            record_id: "r1",
            permit_identifier: "SE-2027-114",
            issued_at: null,
            expires_at: null,
          },
        ]),
      ],
    });
    const listed = await listPermitRequirements(db, { orgId: "o1", projectId: "p1" });
    expect(listed.ok && listed.data.map((r) => [r.rule, r.record?.displayKey ?? null])).toEqual([
      ["Special event", "NWL-7"],
      ["Alcohol", null],
    ]);
    expect(listed.ok && listed.data[0]?.record?.permitIdentifier).toBe("SE-2027-114");
    expect(await listPermitRequirements(db, { orgId: "o1" })).toEqual({ ok: true, data: [] });
    expect((await listPermitRequirements(db, { orgId: "o1" })).ok).toBe(false);
  });

  it("reports a failed record read", async () => {
    const { db } = fakeClient({
      "from:permit_requirements": [
        okResponse([
          { id: "q1", project_id: "p1", permit_rule: "x", record_id: "r1", created_at: "a" },
        ]),
        okResponse([
          { id: "q1", project_id: "p1", permit_rule: "x", record_id: "r1", created_at: "a" },
        ]),
      ],
      "from:records": [errorResponse("PGRST000", "x"), okResponse([])],
      "from:record_permit": [errorResponse("PGRST000", "x")],
    });
    expect((await listPermitRequirements(db, { orgId: "o1" })).ok).toBe(false);
    expect((await listPermitRequirements(db, { orgId: "o1" })).ok).toBe(false);
  });

  it("records permit details and transitions the record", async () => {
    const { db, calls } = fakeClient({
      "from:record_permit": [okResponse([{ record_id: "r1" }])],
      "rpc:transition_record": [
        okResponse("e1"),
        errorResponse("XR001", "record_blocker_required: A Blocked record names its blocker."),
      ],
    });
    expect(
      await updatePermitDetails(db, "r1", {
        permitIdentifier: " SE-1 ",
        issuedAt: "2027-01-01T00:00:00Z",
        expiresAt: null,
      }),
    ).toEqual({ ok: true, data: { id: "r1" } });
    expect(calls[0]?.steps[0]).toEqual([
      "update",
      [{ permit_identifier: "SE-1", issued_at: "2027-01-01T00:00:00Z", expires_at: null }],
    ]);
    expect(
      await transitionRecord(db, {
        recordId: "r1",
        expected: "Proposed",
        next: "Deferred",
        reason: "Moved.",
        replanReason: "Show moved to spring.",
      }),
    ).toEqual({ ok: true, data: { entryId: "e1" } });
    expect(calls[1]?.steps[0]).toEqual([
      "args",
      [
        {
          p_record_id: "r1",
          p_expected: "Proposed",
          p_next: "Deferred",
          p_reason: "Moved.",
          p_replan_reason: "Show moved to spring.",
        },
      ],
    ]);
    const refused = await transitionRecord(db, {
      recordId: "r1",
      expected: "Active",
      next: "Blocked",
      reason: "Stuck.",
      blocker: "",
    });
    expect(refused.ok === false && refused.error.kind).toBe("refusal");
  });
});

describe("inspection templates", () => {
  it("lists templates with live items in position order", async () => {
    const { db, calls } = fakeClient({
      "from:inspection_templates": [
        okResponse([
          {
            id: "t1",
            name: "Stage Walk",
            deleted_at: null,
            updated_at: "a",
            inspection_items: [
              {
                id: "i2",
                position: 2,
                prompt: "Exits clear",
                is_critical: false,
                deleted_at: null,
              },
              {
                id: "i1",
                position: 1,
                prompt: "Deck edges guarded",
                is_critical: true,
                deleted_at: null,
              },
              { id: "i3", position: 3, prompt: "Gone", is_critical: false, deleted_at: "x" },
            ],
          },
        ]),
        okResponse([]),
        errorResponse("PGRST000", "x"),
      ],
    });
    const listed = await listInspectionTemplates(db, "o1");
    expect(listed.ok && listed.data[0]?.items.map((i) => i.id)).toEqual(["i1", "i2"]);
    await listInspectionTemplates(db, "o1", "archived");
    expect(calls[1]?.steps).toContainEqual(["not", ["deleted_at", "is", null]]);
    expect((await listInspectionTemplates(db, "o1", "all")).ok).toBe(false);
  });

  it("creates, renames, archives and edits items", async () => {
    const { db, calls } = fakeClient({
      "from:inspection_templates": [
        okResponse([{ id: "t1" }]),
        okResponse([{ id: "t1" }]),
        okResponse([{ id: "t1" }]),
      ],
      "from:inspection_items": [okResponse([{ id: "i1" }]), okResponse([{ id: "i1" }])],
    });
    await createInspectionTemplate(db, "o1", " Stage Walk ");
    expect(calls[0]?.steps[0]).toEqual(["insert", [{ org_id: "o1", name: "Stage Walk" }]]);
    await renameInspectionTemplate(db, "t1", "Stage Walk Two");
    await setSafetyArchived(db, "inspection_templates", "t1", true, new Date(0));
    expect(calls[2]?.steps[0]).toEqual(["update", [{ deleted_at: "1970-01-01T00:00:00.000Z" }]]);
    await addInspectionItem(db, {
      templateId: "t1",
      prompt: " Exits clear ",
      critical: false,
      position: 3,
    });
    expect(calls[3]?.steps[0]).toEqual([
      "insert",
      [{ inspection_template_id: "t1", position: 3, prompt: "Exits clear", is_critical: false }],
    ]);
    await updateInspectionItem(db, "i1", { prompt: "Exits", critical: true });
  });

  it("swaps two items through a parking position and stops on the first failure", async () => {
    const { db, calls } = fakeClient({
      "from:inspection_items": [
        okResponse([{ id: "a" }]),
        okResponse([{ id: "b" }]),
        okResponse([{ id: "a" }]),
        okResponse([]),
      ],
    });
    expect(
      await swapInspectionItems(db, { id: "a", position: 1 }, { id: "b", position: 2 }, 1000),
    ).toEqual({ ok: true, data: null });
    expect(calls.map((c) => c.steps[0])).toEqual([
      ["update", [{ position: 1000 }]],
      ["update", [{ position: 1 }]],
      ["update", [{ position: 2 }]],
    ]);
    expect(
      (await swapInspectionItems(db, { id: "a", position: 1 }, { id: "b", position: 2 }, 1000)).ok,
    ).toBe(false);
  });
});

describe("inspections", () => {
  const inspectionRow = {
    id: "n1",
    project_id: "p1",
    inspection_template_id: "t1",
    record_id: null,
    inspector_person_id: "dave",
    inspected_at: "2027-06-01T10:00:00Z",
    signed_off_by: null,
    signed_off_at: null,
    deleted_at: null,
    inspection_results: [
      {
        id: "x1",
        inspection_item_id: "i1",
        result_enum_id: "ENM-084",
        note: "Gap",
        deleted_at: null,
      },
      {
        id: "x2",
        inspection_item_id: "i2",
        result_enum_id: "ENM-082",
        note: null,
        deleted_at: "y",
      },
    ],
  };

  it("derives progress without storing it", () => {
    expect(inspectionProgress({ signedOffAt: null, results: [] }, 2)).toBe("not-started");
    const one = [{ id: "x", itemId: "i1", resultEnumId: "ENM-082", note: null }];
    expect(inspectionProgress({ signedOffAt: null, results: one }, 2)).toBe("in-progress");
    expect(inspectionProgress({ signedOffAt: null, results: one }, 1)).toBe("ready-for-sign-off");
    expect(inspectionProgress({ signedOffAt: "z", results: one }, 1)).toBe("signed-off");
  });

  it("lists inspections with live results", async () => {
    const { db } = fakeClient({
      "from:inspections": [
        okResponse([inspectionRow]),
        okResponse([]),
        errorResponse("PGRST000", "x"),
      ],
    });
    const listed = await listInspections(db, { orgId: "o1", projectId: "p1" });
    expect(listed.ok && listed.data[0]?.results).toEqual([
      { id: "x1", itemId: "i1", resultEnumId: "ENM-084", note: "Gap" },
    ]);
    await listInspections(db, { orgId: "o1", archive: "archived" });
    expect((await listInspections(db, { orgId: "o1" })).ok).toBe(false);
  });

  it("starts, records results and signs off through the RPCs", async () => {
    const { db, calls } = fakeClient({
      "rpc:start_inspection": [okResponse("n1"), errorResponse("42501", "no")],
      "rpc:record_inspection_result": [
        okResponse("x1"),
        okResponse("x1"),
        errorResponse("XR001", "inspection_signed_off: frozen."),
      ],
      "rpc:sign_off_inspection": [
        okResponse("n1"),
        errorResponse("XR001", "sod_approval_requester: never the requester."),
      ],
    });
    const start = { projectId: "p1", templateId: "t1", inspectedAt: "2027-06-01T10:00:00Z" };
    expect(await createInspection(db, start)).toEqual({ ok: true, data: { id: "n1" } });
    expect(calls[0]?.steps[0]).toEqual([
      "args",
      [{ p_project_id: "p1", p_template_id: "t1", p_inspected_at: "2027-06-01T10:00:00Z" }],
    ]);
    expect((await createInspection(db, start)).ok).toBe(false);
    const input = { inspectionId: "n1", itemId: "i1", resultEnumId: "ENM-084", note: " Loose " };
    expect(
      await recordInspectionResult(db, { ...input, photoUri: "o/inspections/n1/a.jpg" }),
    ).toEqual({
      ok: true,
      data: { id: "x1" },
    });
    expect(calls[2]?.steps[0]).toEqual([
      "args",
      [
        {
          p_inspection_id: "n1",
          p_item_id: "i1",
          p_result_enum_id: "ENM-084",
          p_note: "Loose",
          p_photo_uri: "o/inspections/n1/a.jpg",
        },
      ],
    ]);
    await recordInspectionResult(db, { ...input, note: " " });
    expect(calls[3]?.steps[0]).toEqual([
      "args",
      [{ p_inspection_id: "n1", p_item_id: "i1", p_result_enum_id: "ENM-084" }],
    ]);
    const frozen = await recordInspectionResult(db, input);
    expect(frozen.ok === false && frozen.error).toMatchObject({ rule: "inspection_signed_off" });
    expect(await signOffInspection(db, "n1")).toEqual({ ok: true, data: { id: "n1" } });
    const refused = await signOffInspection(db, "n1");
    expect(refused.ok === false && refused.error).toMatchObject({ rule: "sod_approval_requester" });
  });

  it("reads people names and skips unnamed people", async () => {
    const { db } = fakeClient({
      "from:people": [
        okResponse([
          { id: "a", full_name: "Dana Diaz" },
          { id: "b", full_name: null },
        ]),
        errorResponse("PGRST000", "x"),
      ],
    });
    expect(await listPeopleNames(db, [])).toEqual({ ok: true, data: new Map() });
    const names = await listPeopleNames(db, ["a", "b", "a"]);
    expect(names.ok && [...names.data]).toEqual([["a", "Dana Diaz"]]);
    expect((await listPeopleNames(db, ["a"])).ok).toBe(false);
  });
});

describe("punch items opened by failed results", () => {
  it("maps each result to its punch item's Task record key", async () => {
    const { db } = fakeClient({
      "from:punch_items": [
        okResponse([
          { inspection_result_id: "x1", record_id: "r9" },
          { inspection_result_id: null, record_id: "r8" },
        ]),
        okResponse([]),
        errorResponse("PGRST000", "x"),
        okResponse([{ inspection_result_id: "x2", record_id: "r7" }]),
      ],
      "from:records": [
        okResponse([{ id: "r9", display_key: "NWL-12" }]),
        errorResponse("PGRST000", "x"),
      ],
    });
    expect(await listPunchItemsForResults(db, [])).toEqual({ ok: true, data: new Map() });
    const mapped = await listPunchItemsForResults(db, ["x1"]);
    expect(mapped.ok && [...mapped.data]).toEqual([
      ["x1", { recordId: "r9", displayKey: "NWL-12" }],
    ]);
    expect(await listPunchItemsForResults(db, ["x3"])).toEqual({ ok: true, data: new Map() });
    expect((await listPunchItemsForResults(db, ["x1"])).ok).toBe(false);
    expect((await listPunchItemsForResults(db, ["x2"])).ok).toBe(false);
  });
});
