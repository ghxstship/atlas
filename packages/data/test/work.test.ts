import { describe, expect, it } from "vitest";
import {
  addChecklistItem,
  assignRecord,
  buildRrule,
  clearRecurrence,
  createRecord,
  duplicateRecord,
  extensionTable,
  formatRecordKey,
  getProjectRef,
  getRecord,
  getRecordByKey,
  getRecordExtension,
  getWatch,
  groupRecords,
  listAssignments,
  listChecklist,
  listCounterpartyOptions,
  listCurrencyOptions,
  listEnumerationOptions,
  listPeopleRefs,
  listPermitRuleOptions,
  listPhaseOptions,
  listProjectRefs,
  listRecordKinds,
  listRecords,
  listRecordStates,
  listRecordTransitions,
  listRecurrences,
  listRecurringRecords,
  listReplans,
  listRoleOptions,
  listScopeNodeRefs,
  listStateHistory,
  listUnitOptions,
  listVenueOptions,
  listXyzTags,
  nextDate,
  nextStates,
  occurrences,
  parseRecordKey,
  parseRrule,
  removeChecklistItem,
  replanShift,
  resolveXyz,
  restoreRecord,
  saveRecordExtension,
  searchCategories,
  setChecklistItemChecked,
  setRecurrence,
  sortRecords,
  transitionNeeds,
  transitionRecord,
  trashRecord,
  unassignRecord,
  unwatchRecord,
  updateRecord,
  watchRecord,
} from "../src/work.ts";
import { errorResponse, okResponse } from "./fake-client.ts";
import { moduleClient, stepsOf } from "./module-client.ts";
import { recordRow, summary } from "./records-fixture.ts";

const NOW = new Date("2027-06-01T12:00:00.000Z");

describe("canon", () => {
  it("lists kinds with their subtypes in canon order", async () => {
    const { db } = moduleClient({
      "xpms:from:dim_record_kind": [
        okResponse([
          { record_kind: "Task", record_class: "Work", title_grammar: "Imperative verb first." },
          { record_kind: "Build", record_class: "Work", title_grammar: "Imperative verb first." },
        ]),
      ],
      "xpms:from:dim_record_subtype": [
        okResponse([
          { record_kind: "Task", record_subtype: "Verify", ordinal: 9 },
          { record_kind: "Task", record_subtype: "Assess", ordinal: 3 },
        ]),
      ],
    });
    const result = await listRecordKinds(db);
    expect(result.ok && result.data.map((k) => k.kind)).toEqual(["Build", "Task"]);
    expect(result.ok && result.data[1]?.subtypes).toEqual(["Assess", "Verify"]);
    expect(result.ok && result.data[0]?.subtypes).toEqual([]);
  });

  it("returns errors from either canon read", async () => {
    const kindsFail = moduleClient({
      "xpms:from:dim_record_kind": [errorResponse("XX000", "boom")],
      "xpms:from:dim_record_subtype": [okResponse([])],
    });
    expect((await listRecordKinds(kindsFail.db)).ok).toBe(false);
    const subtypesFail = moduleClient({
      "xpms:from:dim_record_kind": [okResponse([])],
      "xpms:from:dim_record_subtype": [errorResponse("XX000", "boom")],
    });
    expect((await listRecordKinds(subtypesFail.db)).ok).toBe(false);
  });

  it("orders states and offers only allowed moves", async () => {
    const { db } = moduleClient({
      "xpms:from:dim_record_state": [
        okResponse([
          { record_state: "Ready", ordinal: 2, meaning: "Accepted" },
          { record_state: "Proposed", ordinal: 1, meaning: "Authored" },
          { record_state: "Canceled", ordinal: 9, meaning: "Retained" },
        ]),
      ],
      "from:lifecycle_transition_rules": [
        okResponse([
          { from_state: "Proposed", to_state: "Canceled" },
          { from_state: "Proposed", to_state: "Ready" },
          { from_state: null, to_state: "Ready" },
        ]),
      ],
    });
    const states = await listRecordStates(db);
    const rules = await listRecordTransitions(db);
    expect(states.ok && states.data.map((s) => s.state)).toEqual(["Proposed", "Ready", "Canceled"]);
    expect(rules.ok && rules.data).toHaveLength(2);
    if (states.ok && rules.ok) {
      expect(nextStates(rules.data, states.data, "Proposed")).toEqual(["Ready", "Canceled"]);
      expect(nextStates(rules.data, states.data, "Ready")).toEqual([]);
    }
    expect(transitionNeeds("Blocked")).toBe("blocker");
    expect(transitionNeeds("Deferred")).toBe("replan");
    expect(transitionNeeds("Active")).toBeNull();
  });

  it("surfaces canon and rule read errors", async () => {
    const { db } = moduleClient({
      "xpms:from:dim_record_state": [errorResponse("42501", "denied")],
      "from:lifecycle_transition_rules": [errorResponse("42501", "denied")],
    });
    expect(await listRecordStates(db)).toEqual({ ok: false, error: { kind: "not-found" } });
    expect((await listRecordTransitions(db)).ok).toBe(false);
  });

  it("reads pickers from canon in coded order", async () => {
    const { db } = moduleClient({
      "xpms:from:dim_phase": [
        okResponse([
          { phase_code: "ENG", gate: 2, phase: "Engage" },
          { phase_code: "SCP", gate: 1, phase: "Scope" },
        ]),
      ],
      "xpms:from:dim_category": [
        okResponse([{ xyz: "Y" }, { xyz: "X" }, { xyz: "Y" }, { xyz: null }]),
        okResponse([{ cat_urid: "5000.01.01", category: "Audio Systems" }]),
        okResponse([{ cat_urid: "5000.01.01", category: "Audio Systems" }]),
        okResponse([]),
      ],
      "xpms:from:role": [okResponse([{ role_code: "5000.01.01", job_title: "Stagehand" }])],
      "xpms:from:std_enumeration": [
        okResponse([
          { record_id: "ENM-084", enum_label: "Failed", enum_code: "F", sort_order: 3 },
          { record_id: "ENM-082", enum_label: null, enum_code: "P", sort_order: 1 },
          { record_id: "ENM-099", enum_label: null, enum_code: null, sort_order: null },
        ]),
      ],
      "xpms:from:dim_permit_rule": [
        okResponse([
          { rule: "B", permit: "Building", ordinal: 2 },
          { rule: "A", permit: "Alcohol", ordinal: 1 },
        ]),
      ],
      "xpms:from:dim_unit_alias": [
        okResponse([
          { alias: "ft", unit_code: "FT" },
          { alias: "ea", unit_code: "EA" },
        ]),
      ],
    });
    const phases = await listPhaseOptions(db);
    expect(phases.ok && phases.data.map((p) => p.value)).toEqual(["SCP", "ENG"]);
    expect(await listXyzTags(db)).toEqual({ ok: true, data: ["X", "Y"] });
    const byCode = moduleClient({ "xpms:from:dim_category": [okResponse([])] });
    await searchCategories(byCode.db, "5000.01");
    expect(stepsOf(byCode.calls[0], "like")).toEqual([["cat_urid", "5000.01%"]]);
    const byName = moduleClient({ "xpms:from:dim_category": [okResponse([])] });
    await searchCategories(byName.db, "audio_%");
    expect(stepsOf(byName.calls[0], "ilike")).toEqual([["category", "%audio\\_\\%%"]]);
    expect((await searchCategories(db, "")).ok).toBe(true);
    expect((await searchCategories(db, "")).ok).toBe(true);
    const roles = await listRoleOptions(db);
    expect(roles.ok && roles.data[0]?.label).toBe("Stagehand");
    const results = await listEnumerationOptions(db, "Inspection Result");
    expect(results.ok && results.data.map((r) => r.label)).toEqual(["ENM-099", "P", "Failed"]);
    const rules = await listPermitRuleOptions(db);
    expect(rules.ok && rules.data.map((r) => r.value)).toEqual(["A", "B"]);
    const units = await listUnitOptions(db);
    expect(units.ok && units.data.map((u) => u.value)).toEqual(["ea", "ft"]);
  });

  it("surfaces picker errors", async () => {
    const err = () => [errorResponse("XX000", "boom")];
    const { db } = moduleClient({
      "xpms:from:dim_phase": err(),
      "xpms:from:dim_category": [...err(), ...err()],
      "xpms:from:role": err(),
      "xpms:from:std_enumeration": err(),
      "xpms:from:dim_permit_rule": err(),
      "xpms:from:dim_unit_alias": err(),
      "from:counterparties": err(),
      "from:venues": err(),
    });
    for (const result of [
      await listPhaseOptions(db),
      await listXyzTags(db),
      await searchCategories(db, "x"),
      await listRoleOptions(db),
      await listEnumerationOptions(db, "x"),
      await listPermitRuleOptions(db),
      await listUnitOptions(db),
      await listCounterpartyOptions(db, "o1"),
      await listVenueOptions(db, "o1"),
    ]) {
      expect(result.ok).toBe(false);
    }
  });

  it("lists counterparties and venues by name", async () => {
    const { db } = moduleClient({
      "from:counterparties": [
        okResponse([
          { id: "c2", organization: { name: "Zeta Rigging" } },
          { id: "c1", organization: null },
        ]),
      ],
      "from:venues": [
        okResponse([
          { id: "v2", name: "Pier" },
          { id: "v1", name: "Arena" },
        ]),
      ],
    });
    const parties = await listCounterpartyOptions(db, "o1");
    expect(parties.ok && parties.data.map((p) => p.label)).toEqual(["c1", "Zeta Rigging"]);
    const venues = await listVenueOptions(db, "o1");
    expect(venues.ok && venues.data.map((v) => v.label)).toEqual(["Arena", "Pier"]);
  });
});

describe("projects and people", () => {
  it("lists projects by key and finds one by key", async () => {
    const { db } = moduleClient({
      "from:projects": [
        okResponse([
          { id: "p2", project_key: "NWX", name: "Gala", time_zone: "UTC" },
          { id: "p1", project_key: "NWL", name: "Series", time_zone: "UTC" },
        ]),
        okResponse({ id: "p1", project_key: "NWL", name: "Series", time_zone: "UTC" }),
        okResponse(null),
        errorResponse("XX000", "boom"),
        errorResponse("XX000", "boom"),
      ],
    });
    const list = await listProjectRefs(db, "o1");
    expect(list.ok && list.data.map((p) => p.key)).toEqual(["NWL", "NWX"]);
    expect(await getProjectRef(db, "o1", "NWL")).toEqual({
      ok: true,
      data: { id: "p1", key: "NWL", name: "Series", timeZone: "UTC" },
    });
    expect(await getProjectRef(db, "o1", "ZZZ")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect((await getProjectRef(db, "o1", "NWL")).ok).toBe(false);
    expect((await listProjectRefs(db, "o1")).ok).toBe(false);
  });

  it("lists scope nodes and people by name", async () => {
    const { db, calls } = moduleClient({
      "from:scope_nodes": [
        okResponse([
          { id: "s2", project_id: "p1", name: "Show" },
          { id: "s1", project_id: "p1", name: "Root" },
        ]),
        errorResponse("XX000", "boom"),
      ],
      "from:memberships": [
        okResponse([
          { id: "m2", person_id: "pe2", person: { full_name: "Zed" } },
          { id: "m1", person_id: "pe1", person: null },
        ]),
        errorResponse("XX000", "boom"),
      ],
    });
    const nodes = await listScopeNodeRefs(db, "p1");
    expect(nodes.ok && nodes.data.map((n) => n.name)).toEqual(["Root", "Show"]);
    const people = await listPeopleRefs(db, "o1", NOW);
    expect(people.ok && people.data.map((p) => p.name)).toEqual([null, "Zed"]);
    expect(stepsOf(calls[1], "or")).toEqual([
      ["valid_to.is.null,valid_to.gt.2027-06-01T12:00:00.000Z"],
    ]);
    expect((await listScopeNodeRefs(db, "p1")).ok).toBe(false);
    expect((await listPeopleRefs(db, "o1")).ok).toBe(false);
  });
});

describe("keys", () => {
  it("parses and formats display keys", () => {
    expect(parseRecordKey("NWL-142")).toEqual({ projectKey: "NWL", number: 142 });
    expect(parseRecordKey(" NWL-1 ")).toEqual({ projectKey: "NWL", number: 1 });
    expect(parseRecordKey("nwl-1")).toBeNull();
    expect(parseRecordKey("NWL-0")).toBeNull();
    expect(parseRecordKey("NWL-WO-3")).toBeNull();
    expect(formatRecordKey("NWL", 3)).toBe("NWL-3");
  });
});

describe("records", () => {
  it("maps rows to summaries with display keys", () => {
    const r = summary({ project: null, owner: null });
    expect(r.key).toBe("-7");
    expect(r.projectTimeZone).toBe("UTC");
    expect(r.ownerName).toBeNull();
    expect(summary().key).toBe("NWL-7");
  });

  it("applies every query filter", async () => {
    const { db, calls } = moduleClient({ "from:records": [okResponse([recordRow()])] });
    const result = await listRecords(db, {
      orgId: "o1",
      projectId: "p1",
      kinds: ["Task"],
      states: ["Active"],
      ownerId: "pe1",
      ids: ["r1"],
      search: "50%_off",
      from: "2027-06-01",
      to: "2027-06-08",
      datedOnly: true,
      limit: 10,
    });
    expect(result.ok && result.data[0]?.key).toBe("NWL-7");
    const call = calls[0];
    expect(stepsOf(call, "in")).toEqual([
      ["record_kind", ["Task"]],
      ["record_state", ["Active"]],
      ["id", ["r1"]],
    ]);
    expect(stepsOf(call, "ilike")).toEqual([["title", "%50\\%\\_off%"]]);
    expect(stepsOf(call, "or")[0]?.[0]).toContain(
      "and(starts_at.lt.2027-06-08,ends_at.gte.2027-06-01)",
    );
    expect(stepsOf(call, "limit")).toEqual([[10]]);
    expect(stepsOf(call, "is")).toEqual([["deleted_at", null]]);
  });

  it("reads Trash and open-ended windows", async () => {
    const { db, calls } = moduleClient({
      "from:records": [okResponse([]), errorResponse("XX000", "boom")],
    });
    await listRecords(db, { orgId: "o1", trashed: true, from: "2027-06-01" });
    expect(stepsOf(calls[0], "not")).toEqual([["deleted_at", "is", null]]);
    expect(stepsOf(calls[0], "or")[0]?.[0]).toContain("starts_at.lt.infinity");
    expect((await listRecords(db, { orgId: "o1", to: "2027-06-01" })).ok).toBe(false);
  });

  it("finds a record by key or id", async () => {
    const { db, calls } = moduleClient({
      "from:records": [
        okResponse(recordRow()),
        okResponse(null),
        errorResponse("XX000", "boom"),
        okResponse(recordRow()),
        okResponse(null),
        errorResponse("XX000", "boom"),
      ],
    });
    const found = await getRecordByKey(db, "o1", "NWL-7");
    expect(found.ok && found.data.id).toBe("r1");
    expect(stepsOf(calls[0], "eq")).toContainEqual(["project.project_key", "NWL"]);
    expect(await getRecordByKey(db, "o1", "NWL-8")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect((await getRecordByKey(db, "o1", "NWL-9")).ok).toBe(false);
    expect(await getRecordByKey(db, "o1", "bad")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect((await getRecord(db, "r1")).ok).toBe(true);
    expect(await getRecord(db, "r2")).toEqual({ ok: false, error: { kind: "not-found" } });
    expect((await getRecord(db, "r3")).ok).toBe(false);
  });

  it("chooses the next date that matters", () => {
    expect(
      nextDate(summary({ starts_at: "2027-07-01T00:00:00Z", due_at: "2027-07-02T00:00:00Z" }), NOW),
    ).toBe("2027-07-01T00:00:00Z");
    expect(
      nextDate(summary({ starts_at: "2027-05-01T00:00:00Z", due_at: "2027-07-02T00:00:00Z" }), NOW),
    ).toBe("2027-07-02T00:00:00Z");
    expect(nextDate(summary({ starts_at: "2027-05-01T00:00:00Z" }), NOW)).toBe(
      "2027-05-01T00:00:00Z",
    );
    expect(nextDate(summary(), NOW)).toBeNull();
  });

  it("sorts and groups records", () => {
    const a = summary({
      id: "a",
      record_number: 2,
      title: "Beta",
      record_state: "Active",
      updated_at: "2027-01-01",
    });
    const b = summary({
      id: "b",
      record_number: 1,
      title: "Alpha",
      record_state: "Proposed",
      due_at: "2027-06-03T00:00:00Z",
      updated_at: "2027-02-01",
    });
    const c = summary({
      id: "c",
      record_number: 3,
      title: "Alpha",
      record_kind: "Build",
      due_at: "2027-06-02T00:00:00Z",
    });
    const states = [
      { state: "Proposed", ordinal: 1, meaning: "" },
      { state: "Active", ordinal: 4, meaning: "" },
    ];
    expect(sortRecords([a, b, c], "key").map((r) => r.id)).toEqual(["b", "a", "c"]);
    expect(sortRecords([a, b, c], "title").map((r) => r.id)).toEqual(["b", "c", "a"]);
    expect(sortRecords([a, b, c], "updated").map((r) => r.id)).toEqual(["c", "b", "a"]);
    expect(sortRecords([a, b, c], "state", states).map((r) => r.id)).toEqual(["b", "c", "a"]);
    expect(sortRecords([a, b, c], "next").map((r) => r.id)).toEqual(["c", "b", "a"]);
    expect(sortRecords([a, a], "next")).toHaveLength(2);
    expect(sortRecords([b, a], "next").map((r) => r.id)).toEqual(["b", "a"]);
    const groups = groupRecords([a, b, c], "kind", ["Task", "Build", "Event"]);
    expect(groups.map((g) => [g.group, g.records.length])).toEqual([
      ["Task", 2],
      ["Build", 1],
      ["Event", 0],
    ]);
    expect(groupRecords([a], "state").map((g) => g.group)).toEqual(["Active"]);
  });

  it("resolves the XYZ basis", () => {
    expect(resolveXyz("X", null)).toEqual({ xyz: "X", basis: "Category" });
    expect(resolveXyz("X", "X")).toEqual({ xyz: "X", basis: "Category" });
    expect(resolveXyz("X", "Z")).toEqual({ xyz: "Z", basis: "Declared" });
    expect(resolveXyz(null, "Y")).toEqual({ xyz: "Y", basis: "Declared" });
    expect(resolveXyz(null, undefined)).toBeNull();
  });

  it("creates a record with its extension row", async () => {
    const { db, calls } = moduleClient({
      "xpms:from:dim_category": [okResponse({ xyz: "X" })],
      "from:records": [okResponse({ id: "r9", record_number: 12 })],
      "from:record_task": [okResponse(null), okResponse(null)],
    });
    const result = await createRecord(db, {
      orgId: "o1",
      projectId: "p1",
      kind: "Task",
      subtype: "Execute",
      title: "  Hang the truss ",
      urid: "5000.01.01",
    });
    expect(result).toEqual({ ok: true, data: { id: "r9", number: 12 } });
    const insert = stepsOf(calls[1], "insert")[0]?.[0] as Record<string, unknown>;
    expect(insert).toMatchObject({ title: "Hang the truss", xyz: "X", xyz_basis: "Category" });
    expect(stepsOf(calls[3], "insert")[0]?.[0]).toEqual({
      record_id: "r9",
      org_id: "o1",
      record_kind: "Task",
    });
  });

  it("refuses a record without an XYZ tag and surfaces write errors", async () => {
    const none = moduleClient({});
    expect(
      await createRecord(none.db, { orgId: "o1", projectId: "p1", kind: "Task", title: "Do it" }),
    ).toEqual({
      ok: false,
      error: {
        kind: "refusal",
        rule: "record_xyz_required",
        message: "Choose a URID category or declare the XYZ tag.",
      },
    });
    const categoryFails = moduleClient({
      "xpms:from:dim_category": [errorResponse("XX000", "boom")],
    });
    expect(
      (
        await createRecord(categoryFails.db, {
          orgId: "o1",
          projectId: "p1",
          kind: "Task",
          title: "Do",
          urid: "1",
        })
      ).ok,
    ).toBe(false);
    const refused = moduleClient({
      "from:records": [
        errorResponse("XR001", "record_title_grammar: Start with a verb.", "record_title_grammar"),
      ],
    });
    expect(
      await createRecord(refused.db, {
        orgId: "o1",
        projectId: "p1",
        kind: "Task",
        title: "The truss",
        xyz: "Y",
      }),
    ).toEqual({
      ok: false,
      error: { kind: "refusal", rule: "record_title_grammar", message: "Start with a verb." },
    });
    const extensionFails = moduleClient({
      "from:records": [okResponse({ id: "r9", record_number: 1 })],
      "from:record_task": [errorResponse("XX000", "boom")],
    });
    expect(
      (
        await createRecord(extensionFails.db, {
          orgId: "o1",
          projectId: "p1",
          kind: "Task",
          title: "Do",
          xyz: "Y",
        })
      ).ok,
    ).toBe(false);
  });

  it("updates only the given fields", async () => {
    const { db, calls } = moduleClient({
      "from:records": [okResponse([{ id: "r1" }]), okResponse([]), errorResponse("XX000", "boom")],
    });
    expect(
      await updateRecord(db, "r1", {
        title: " Rig the truss ",
        subtype: "Verify",
        scopeNodeId: null,
        phaseCode: "INS",
        ownerId: "pe2",
        accountableId: "pe3",
        startsAt: "a",
        endsAt: "b",
        dueAt: null,
        timeZone: "UTC",
        replanReason: "Truss arrived late.",
      }),
    ).toEqual({ ok: true, data: null });
    expect(stepsOf(calls[0], "update")[0]?.[0]).toMatchObject({
      title: "Rig the truss",
      replan_reason: "Truss arrived late.",
    });
    expect(await updateRecord(db, "r1", {})).toEqual({ ok: true, data: null });
    expect(await updateRecord(db, "r1", { title: "X" })).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect((await updateRecord(db, "r1", { title: "X" })).ok).toBe(false);
  });

  it("moves records through states", async () => {
    const { db, calls } = moduleClient({
      "rpc:transition_record": [
        okResponse("e1"),
        okResponse("e2"),
        errorResponse("XR001", "x: y", "x"),
      ],
    });
    expect(
      await transitionRecord(db, {
        recordId: "r1",
        expected: "Active",
        next: "Blocked",
        reason: "Rain.",
        blockerText: "Rain hold",
      }),
    ).toEqual({ ok: true, data: { entryId: "e1" } });
    expect(stepsOf(calls[0], "args")[0]?.[0]).toMatchObject({ p_blocker_text: "Rain hold" });
    await transitionRecord(db, {
      recordId: "r1",
      expected: "Active",
      next: "Deferred",
      reason: "Later.",
      replanReason: "Moved",
    });
    expect(stepsOf(calls[1], "args")[0]?.[0]).toMatchObject({ p_replan_reason: "Moved" });
    expect(
      (await transitionRecord(db, { recordId: "r1", expected: "A", next: "B", reason: "C" })).ok,
    ).toBe(false);
  });

  it("trashes and restores records", async () => {
    const { db } = moduleClient({
      "from:records": [
        okResponse([{ id: "r1" }]),
        okResponse([]),
        errorResponse("XR001", "record_retained: kept", "record_retained"),
        okResponse([{ id: "r1" }]),
        okResponse([]),
        errorResponse("XX000", "boom"),
      ],
    });
    expect(await trashRecord(db, "r1")).toEqual({ ok: true, data: null });
    expect(await trashRecord(db, "r1")).toEqual({ ok: false, error: { kind: "not-found" } });
    expect((await trashRecord(db, "r1")).ok).toBe(false);
    expect(await restoreRecord(db, "r1")).toEqual({ ok: true, data: null });
    expect(await restoreRecord(db, "r1")).toEqual({ ok: false, error: { kind: "not-found" } });
    expect((await restoreRecord(db, "r1")).ok).toBe(false);
  });
});

describe("extensions", () => {
  it("names the extension table of a kind", () => {
    expect(extensionTable("Build")).toBe("record_build");
    expect(extensionTable("In Review")).toBe("record_inreview");
  });

  it("reads only the kind's own attributes", async () => {
    const { db } = moduleClient({
      "from:record_risk": [
        okResponse({
          record_id: "r1",
          org_id: "o1",
          record_kind: "Risk",
          created_at: "x",
          likelihood: 3,
          score: 9,
        }),
        okResponse(null),
        errorResponse("XX000", "boom"),
      ],
    });
    expect(await getRecordExtension(db, "Risk", "r1")).toEqual({
      ok: true,
      data: { likelihood: 3, score: 9 },
    });
    expect(await getRecordExtension(db, "Risk", "r1")).toEqual({ ok: true, data: {} });
    expect((await getRecordExtension(db, "Risk", "r1")).ok).toBe(false);
  });

  it("updates an existing row and skips generated columns", async () => {
    const { db, calls } = moduleClient({
      "from:record_risk": [okResponse({ record_id: "r1" }), okResponse(null)],
    });
    const result = await saveRecordExtension(db, {
      orgId: "o1",
      recordId: "r1",
      kind: "Risk",
      fields: { likelihood: 4, score: 1, org_id: "other" },
    });
    expect(result.ok).toBe(true);
    expect(stepsOf(calls[1], "update")[0]?.[0]).toEqual({ likelihood: 4 });
  });

  it("skips an empty update and surfaces errors", async () => {
    const { db } = moduleClient({
      "from:record_risk": [
        okResponse({ record_id: "r1" }),
        errorResponse("XX000", "boom"),
        okResponse({ record_id: "r1" }),
        errorResponse("23514", "check"),
      ],
    });
    expect(
      await saveRecordExtension(db, { orgId: "o1", recordId: "r1", kind: "Risk", fields: {} }),
    ).toEqual({
      ok: true,
      data: null,
    });
    expect(
      (
        await saveRecordExtension(db, {
          orgId: "o1",
          recordId: "r1",
          kind: "Risk",
          fields: { a: 1 },
        })
      ).ok,
    ).toBe(false);
  });
});

describe("history", () => {
  it("reads the state ledger and the replan log", async () => {
    const { db } = moduleClient({
      "from:record_state_transitions": [
        okResponse([
          {
            id: "e1",
            from_state: null,
            to_state: "Proposed",
            reason: "Created.",
            created_at: "t",
            actor: null,
          },
        ]),
        errorResponse("XX000", "boom"),
      ],
      "from:record_replans": [
        okResponse([
          {
            id: "p1",
            from_state: "Scheduled",
            to_state: "Scheduled",
            old_starts_at: null,
            new_starts_at: null,
            old_ends_at: "2027-06-01T00:00:00Z",
            new_ends_at: "2027-06-03T00:00:00Z",
            old_due_at: null,
            new_due_at: null,
            reason: "Late truss.",
            created_at: "t",
            actor: { full_name: "Dana" },
          },
        ]),
        errorResponse("XX000", "boom"),
      ],
    });
    const history = await listStateHistory(db, "r1");
    expect(history.ok && history.data[0]?.to).toBe("Proposed");
    const replans = await listReplans(db, "r1");
    expect(replans.ok && replans.data[0]?.byName).toBe("Dana");
    if (replans.ok && replans.data[0]) {
      expect(replanShift(replans.data[0])).toEqual({ moved: true, endShiftMs: 2 * 86_400_000 });
      expect(replanShift({ ...replans.data[0], oldEndsAt: null, newEndsAt: null })).toEqual({
        moved: false,
        endShiftMs: null,
      });
    }
    expect((await listStateHistory(db, "r1")).ok).toBe(false);
    expect((await listReplans(db, "r1")).ok).toBe(false);
  });
});

describe("checklist", () => {
  it("adds items at the end and ticks them", async () => {
    const { db, calls } = moduleClient({
      "from:record_checklist_items": [
        okResponse([{ id: "i1", position: 2, label: "Shackles", checked_at: null, checker: null }]),
        okResponse({ id: "i2" }),
        okResponse([{ id: "i2" }]),
        okResponse([]),
        okResponse([{ id: "i2" }]),
        okResponse([]),
      ],
    });
    expect(
      await addChecklistItem(db, { orgId: "o1", recordId: "r1", label: " Safeties " }),
    ).toEqual({
      ok: true,
      data: { id: "i2" },
    });
    expect(stepsOf(calls[1], "insert")[0]?.[0]).toMatchObject({ position: 3, label: "Safeties" });
    expect((await setChecklistItemChecked(db, "i2", true)).ok).toBe(true);
    expect(await setChecklistItemChecked(db, "i2", false)).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect((await removeChecklistItem(db, "i2")).ok).toBe(true);
    expect(await removeChecklistItem(db, "i2")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
  });

  it("surfaces checklist errors", async () => {
    const { db } = moduleClient({
      "from:record_checklist_items": [
        errorResponse("XX000", "boom"),
        errorResponse("XX000", "boom"),
        okResponse([]),
        errorResponse("XX000", "boom"),
        errorResponse("XX000", "boom"),
        errorResponse("XX000", "boom"),
      ],
    });
    expect((await listChecklist(db, "r1")).ok).toBe(false);
    expect((await addChecklistItem(db, { orgId: "o1", recordId: "r1", label: "x" })).ok).toBe(
      false,
    );
    expect((await addChecklistItem(db, { orgId: "o1", recordId: "r1", label: "x" })).ok).toBe(
      false,
    );
    expect((await setChecklistItemChecked(db, "i", true)).ok).toBe(false);
    expect((await removeChecklistItem(db, "i")).ok).toBe(false);
  });
});

describe("assignments and watchers", () => {
  it("assigns, lists and unassigns people", async () => {
    const { db } = moduleClient({
      "from:record_assignments": [
        okResponse([
          { id: "a1", membership_id: "m1", membership: { person: { full_name: "Lee" } } },
        ]),
        okResponse([{ id: "a2", membership_id: "m2", membership: null }]),
        errorResponse("XX000", "boom"),
        okResponse(null),
        errorResponse("23505", "dup"),
        okResponse([{ id: "a1" }]),
        okResponse([]),
        errorResponse("XX000", "boom"),
      ],
    });
    const list = await listAssignments(db, "r1");
    expect(list.ok && list.data[0]?.name).toBe("Lee");
    const unnamed = await listAssignments(db, "r1");
    expect(unnamed.ok && unnamed.data[0]?.name).toBeNull();
    expect((await listAssignments(db, "r1")).ok).toBe(false);
    expect((await assignRecord(db, { orgId: "o1", recordId: "r1", membershipId: "m1" })).ok).toBe(
      true,
    );
    expect(await assignRecord(db, { orgId: "o1", recordId: "r1", membershipId: "m1" })).toEqual({
      ok: false,
      error: { kind: "conflict", message: "dup" },
    });
    expect((await unassignRecord(db, "a1")).ok).toBe(true);
    expect(await unassignRecord(db, "a1")).toEqual({ ok: false, error: { kind: "not-found" } });
    expect((await unassignRecord(db, "a1")).ok).toBe(false);
  });

  it("watches and unwatches, treating a repeat watch as done", async () => {
    const { db } = moduleClient({
      "from:record_watchers": [
        okResponse({ id: "w1" }),
        okResponse(null),
        errorResponse("XX000", "boom"),
        okResponse(null),
        errorResponse("23505", "dup"),
        errorResponse("42501", "denied"),
        okResponse(null),
        errorResponse("XX000", "boom"),
      ],
    });
    expect(await getWatch(db, "r1", "pe1")).toEqual({ ok: true, data: { id: "w1" } });
    expect(await getWatch(db, "r1", "pe1")).toEqual({ ok: true, data: null });
    expect((await getWatch(db, "r1", "pe1")).ok).toBe(false);
    expect((await watchRecord(db, { orgId: "o1", recordId: "r1", personId: "pe1" })).ok).toBe(true);
    expect((await watchRecord(db, { orgId: "o1", recordId: "r1", personId: "pe1" })).ok).toBe(true);
    expect((await watchRecord(db, { orgId: "o1", recordId: "r1", personId: "pe1" })).ok).toBe(
      false,
    );
    expect((await unwatchRecord(db, "w1")).ok).toBe(true);
    expect((await unwatchRecord(db, "w1")).ok).toBe(false);
  });
});

describe("recurrence", () => {
  const rule = {
    id: "rr1",
    record_id: "r1",
    rrule: "FREQ=WEEKLY;BYDAY=MO",
    time_zone: "UTC",
    until_at: null,
  };

  it("reads rules by record and lists recurring records", async () => {
    const { db } = moduleClient({
      "from:record_recurrences": [
        okResponse([rule]),
        okResponse([rule]),
        okResponse([]),
        errorResponse("XX000", "b"),
      ],
      "from:records": [okResponse([recordRow()])],
    });
    expect(await listRecurrences(db, [])).toEqual({ ok: true, data: new Map() });
    const map = await listRecurrences(db, ["r1"]);
    expect(map.ok && map.data.get("r1")?.rrule).toBe("FREQ=WEEKLY;BYDAY=MO");
    const recurring = await listRecurringRecords(db, { orgId: "o1", projectId: "p1" });
    expect(recurring.ok && recurring.data[0]?.record.key).toBe("NWL-7");
    expect(await listRecurringRecords(db, { orgId: "o1" })).toEqual({ ok: true, data: [] });
    expect((await listRecurringRecords(db, { orgId: "o1" })).ok).toBe(false);
  });

  it("drops rules whose records are not readable and surfaces errors", async () => {
    const { db } = moduleClient({
      "from:record_recurrences": [
        okResponse([rule]),
        okResponse([rule]),
        errorResponse("XX000", "b"),
      ],
      "from:records": [okResponse([]), errorResponse("XX000", "b")],
    });
    expect(await listRecurringRecords(db, { orgId: "o1" })).toEqual({ ok: true, data: [] });
    expect((await listRecurringRecords(db, { orgId: "o1" })).ok).toBe(false);
    expect((await listRecurrences(db, ["r1"])).ok).toBe(false);
  });

  it("replaces and clears rules", async () => {
    const { db, calls } = moduleClient({
      "from:record_recurrences": [
        okResponse(null),
        okResponse(null),
        errorResponse("XX000", "b"),
        okResponse(null),
        errorResponse("23514", "rrule"),
      ],
    });
    expect(
      (
        await setRecurrence(db, {
          orgId: "o1",
          recordId: "r1",
          rrule: "FREQ=DAILY",
          timeZone: "UTC",
        })
      ).ok,
    ).toBe(true);
    expect(stepsOf(calls[1], "insert")[0]?.[0]).toMatchObject({
      rrule: "FREQ=DAILY",
      until_at: null,
    });
    expect(
      (await setRecurrence(db, { orgId: "o1", recordId: "r1", rrule: "x", timeZone: "UTC" })).ok,
    ).toBe(false);
    expect(
      (await setRecurrence(db, { orgId: "o1", recordId: "r1", rrule: "x", timeZone: "UTC" })).ok,
    ).toBe(false);
    const clear = moduleClient({ "from:record_recurrences": [okResponse(null)] });
    expect((await clearRecurrence(clear.db, "r1")).ok).toBe(true);
  });

  it("builds, parses and expands rules", () => {
    expect(buildRrule({ frequency: "DAILY" })).toBe("FREQ=DAILY");
    expect(buildRrule({ frequency: "WEEKLY", interval: 2, byDay: ["MO", "TH"], count: 6 })).toBe(
      "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;COUNT=6",
    );
    expect(parseRrule("FREQ=WEEKLY;BYDAY=MO,TH;COUNT=4")).toEqual({
      frequency: "WEEKLY",
      interval: 1,
      byDay: ["MO", "TH"],
      count: 4,
    });
    expect(parseRrule("FREQ=YEARLY")).toBeNull();
    expect(occurrences("2027-06-07T09:00:00Z", "FREQ=YEARLY", 3)).toEqual([]);
    expect(occurrences("2027-06-07T09:00:00Z", "FREQ=DAILY;INTERVAL=2", 3)).toEqual([
      "2027-06-07T09:00:00.000Z",
      "2027-06-09T09:00:00.000Z",
      "2027-06-11T09:00:00.000Z",
    ]);
    expect(occurrences("2027-06-07T09:00:00Z", "FREQ=WEEKLY;BYDAY=MO,WE", 3)).toEqual([
      "2027-06-07T09:00:00.000Z",
      "2027-06-09T09:00:00.000Z",
      "2027-06-14T09:00:00.000Z",
    ]);
    expect(occurrences("2027-06-07T09:00:00Z", "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO", 2)).toEqual([
      "2027-06-07T09:00:00.000Z",
      "2027-06-21T09:00:00.000Z",
    ]);
    expect(occurrences("2027-06-07T09:00:00Z", "FREQ=WEEKLY", 2)).toEqual([
      "2027-06-07T09:00:00.000Z",
      "2027-06-14T09:00:00.000Z",
    ]);
    expect(occurrences("2027-01-31T09:00:00Z", "FREQ=MONTHLY;COUNT=2", 5)).toHaveLength(2);
    expect(
      occurrences("2027-06-07T09:00:00Z", "FREQ=DAILY", 10, "2027-06-08T10:00:00Z"),
    ).toHaveLength(2);
  });
});

describe("duplicate", () => {
  it("copies a record, its attributes and, with children, its checklist", async () => {
    const { db, calls } = moduleClient({
      "from:records": [
        okResponse(recordRow({ urid: "5000.01.01", xyz: "X" })),
        okResponse({ id: "r9", record_number: 8 }),
      ],
      "xpms:from:dim_category": [okResponse({ xyz: "X" })],
      "from:record_task": [
        okResponse({ record_id: "r1", org_id: "o1", record_kind: "Task", progress_pct: 40 }),
        okResponse(null),
        okResponse(null),
      ],
      "from:record_checklist_items": [
        okResponse([{ id: "i1", position: 1, label: "Safeties", checked_at: "t", checker: null }]),
        okResponse([]),
        okResponse({ id: "i9" }),
      ],
    });
    expect(await duplicateRecord(db, { orgId: "o1", recordId: "r1", withChildren: true })).toEqual({
      ok: true,
      data: { id: "r9", number: 8 },
    });
    const copied = calls.find(
      (c) => c.target === "from:record_checklist_items" && stepsOf(c, "insert").length > 0,
    );
    expect(stepsOf(copied, "insert")[0]?.[0]).toMatchObject({ label: "Safeties", record_id: "r9" });
  });

  it("stops at the first failure", async () => {
    const missing = moduleClient({ "from:records": [okResponse(null)] });
    expect((await duplicateRecord(missing.db, { orgId: "o1", recordId: "r1" })).ok).toBe(false);
    const refused = moduleClient({
      "from:records": [okResponse(recordRow()), errorResponse("42501", "denied")],
      "from:record_task": [okResponse(null)],
    });
    expect((await duplicateRecord(refused.db, { orgId: "o1", recordId: "r1" })).ok).toBe(false);
    const extensionFails = moduleClient({
      "from:records": [okResponse(recordRow())],
      "from:record_task": [errorResponse("XX000", "boom")],
    });
    expect((await duplicateRecord(extensionFails.db, { orgId: "o1", recordId: "r1" })).ok).toBe(
      false,
    );
    const checklistFails = moduleClient({
      "from:records": [okResponse(recordRow()), okResponse({ id: "r9", record_number: 8 })],
      "from:record_task": [okResponse(null), okResponse(null), okResponse(null)],
      "from:record_checklist_items": [errorResponse("XX000", "boom")],
    });
    expect(
      (
        await duplicateRecord(checklistFails.db, {
          orgId: "o1",
          recordId: "r1",
          withChildren: true,
        })
      ).ok,
    ).toBe(false);
  });
});

describe("currencies", () => {
  it("lists currencies with exponents in code order", async () => {
    const { db } = moduleClient({
      "from:currencies": [
        okResponse([
          { currency_code: "USD", minor_unit_exponent: 2 },
          { currency_code: "JPY", minor_unit_exponent: 0 },
          { currency_code: null, minor_unit_exponent: null },
          { currency_code: "XTS", minor_unit_exponent: null },
        ]),
        errorResponse("XX000", "boom"),
      ],
    });
    expect(await listCurrencyOptions(db)).toEqual({
      ok: true,
      data: [
        { code: "JPY", exponent: 0 },
        { code: "USD", exponent: 2 },
        { code: "XTS", exponent: 2 },
      ],
    });
    expect((await listCurrencyOptions(db)).ok).toBe(false);
  });
});
