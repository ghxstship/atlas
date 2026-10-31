import { describe, expect, it } from "vitest";
import {
  addProjectMember,
  countRecordsByCoordinate,
  listDepartments,
  attestEvidence,
  createProject,
  createScopeNode,
  endProjectMember,
  getProjectByKey,
  isProjectKey,
  listAllowedTransitions,
  listCurrencies,
  listAssertionRanks,
  listCriterionStatus,
  listGateCriteria,
  listGateEvidence,
  listJurisdictions,
  listMovableStates,
  listPhases,
  listPhaseTransitions,
  listProductionStateHistory,
  listProjectMembers,
  listProjects,
  listProjectStateHistory,
  listRegions,
  listScopeNodes,
  listTiers,
  listVenues,
  passGate,
  removeScopeNode,
  setProjectArchived,
  transitionProduction,
  transitionProject,
  updateProject,
  updateScopeNode,
  withdrawEvidence,
} from "../src/projects.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

const PROJECT_ROW = {
  id: "p1",
  project_key: "NWL",
  name: "Northwind Summer Series",
  description: null,
  currency: "USD",
  project_state: "Active",
  production_state: "Proposed",
  current_phase_code: "SCP",
  jurisdiction_id: "US-FL-MIAMI-DADE",
  region_code: "NA-SE-MIA",
  tier_code: "05",
  time_zone: "America/New_York",
  starts_on: "2026-11-01",
  ends_on: "2026-11-03",
  venue_id: "v1",
  workspace_id: null,
  archived_at: null,
  updated_at: "2026-10-01T00:00:00Z",
  venue: { name: "Bayfront Park" },
};

/** A fake client that also answers `schema("xpms").from(...)` from `xpms:<table>` queues. */
function canonClient(queues: Parameters<typeof fakeClient>[0]) {
  const { db, calls } = fakeClient(queues);
  const withSchema = Object.assign(db, {
    schema: () => ({ from: (table: string) => db.from(`xpms:${table}` as "projects") }),
  });
  return { db: withSchema, calls };
}

describe("projects", () => {
  it("validates project keys", () => {
    expect(isProjectKey("NWL")).toBe(true);
    expect(isProjectKey("nwl")).toBe(false);
    expect(isProjectKey("N")).toBe(false);
    expect(isProjectKey("ABCDEF")).toBe(false);
  });

  it("lists projects without archived ones by default", async () => {
    const { db, calls } = fakeClient({ "from:projects": [okResponse([PROJECT_ROW])] });
    const result = await listProjects(db, "o1");
    expect(result).toEqual({
      ok: true,
      data: [
        expect.objectContaining({ key: "NWL", venueName: "Bayfront Park", projectState: "Active" }),
      ],
    });
    expect(calls[0]?.steps).toContainEqual(["is", ["archived_at", null]]);
  });

  it("includes archived projects on request and surfaces errors", async () => {
    const { db, calls } = fakeClient({
      "from:projects": [
        okResponse([{ ...PROJECT_ROW, venue: null }]),
        errorResponse("42501", "no"),
      ],
    });
    const all = await listProjects(db, "o1", { includeArchived: true });
    expect(all.ok && all.data[0]?.venueName).toBe(null);
    expect(calls[0]?.steps).not.toContainEqual(["is", ["archived_at", null]]);
    expect(await listProjects(db, "o1")).toEqual({ ok: false, error: { kind: "not-found" } });
  });

  it("reads one project by key and answers not-found for bad keys and hidden rows", async () => {
    const { db } = fakeClient({
      "from:projects": [okResponse(PROJECT_ROW), okResponse(null), errorResponse("XX000", "boom")],
    });
    expect((await getProjectByKey(db, "o1", "NWL")).ok).toBe(true);
    expect(await getProjectByKey(db, "o1", "bad key")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect(await getProjectByKey(db, "o1", "NWL")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect((await getProjectByKey(db, "o1", "NWL")).ok).toBe(false);
  });

  it("creates a project with its engagement root through the RPC", async () => {
    const { db, calls } = fakeClient({
      "rpc:create_project": [
        okResponse("p1"),
        okResponse(null),
        errorResponse("XR001", "plan_limit_exceeded: Upgrade.", "plan_limit_exceeded"),
      ],
    });
    const input = { orgId: "o1", key: "NWL", name: " Northwind ", timeZone: "America/New_York" };
    expect(await createProject(db, input)).toEqual({ ok: true, data: { id: "p1" } });
    expect(calls[0]?.steps[0]).toEqual([
      "args",
      [
        {
          p_org_id: "o1",
          p_project_key: "NWL",
          p_name: "Northwind",
          p_time_zone: "America/New_York",
          p_jurisdiction_id: null,
          p_region_code: null,
          p_tier_code: null,
          p_venue_id: null,
          p_starts_on: null,
          p_ends_on: null,
          p_currency_code: null,
          p_description: null,
        },
      ],
    ]);
    expect(await createProject(db, input)).toMatchObject({
      ok: false,
      error: { kind: "unexpected" },
    });
    expect(await createProject(db, input)).toEqual({
      ok: false,
      error: { kind: "refusal", rule: "plan_limit_exceeded", message: "Upgrade." },
    });
  });

  it("updates only the fields given and answers not-found for zero rows", async () => {
    const { db, calls } = fakeClient({
      "from:projects": [okResponse([{ id: "p1" }]), okResponse([]), errorResponse("23514", "bad")],
    });
    expect(
      await updateProject(db, "p1", {
        key: "NWX",
        name: " New ",
        timeZone: "UTC",
        jurisdictionId: null,
        regionCode: "NA-SE-MIA",
        tierCode: "04",
        venueId: null,
        startsOn: "2026-01-01",
        endsOn: null,
        currencyCode: "EUR",
        description: "  ",
      }),
    ).toEqual({ ok: true, data: null });
    expect(calls[0]?.steps[0]).toEqual([
      "update",
      [
        {
          project_key: "NWX",
          name: "New",
          time_zone: "UTC",
          jurisdiction_id: null,
          region_code: "NA-SE-MIA",
          tier_code: "04",
          venue_id: null,
          starts_on: "2026-01-01",
          ends_on: null,
          currency: "EUR",
          description: null,
        },
      ],
    ]);
    expect(await updateProject(db, "p1", {})).toEqual({ ok: false, error: { kind: "not-found" } });
    expect((await updateProject(db, "p1", { name: "x" })).ok).toBe(false);
  });

  it("archives and restores", async () => {
    const now = new Date("2026-10-14T00:00:00Z");
    const { db, calls } = fakeClient({
      "from:projects": [okResponse([{ id: "p1" }]), okResponse([{ id: "p1" }])],
    });
    await setProjectArchived(db, "p1", true, now);
    await setProjectArchived(db, "p1", false);
    expect(calls[0]?.steps[0]).toEqual(["update", [{ archived_at: now.toISOString() }]]);
    expect(calls[1]?.steps[0]).toEqual(["update", [{ archived_at: null }]]);
  });

  it("reads the states a lifecycle can leave, once each", async () => {
    const { db } = fakeClient({
      "from:lifecycle_transition_rules": [
        okResponse([
          { from_state: "Proposed" },
          { from_state: "Active" },
          { from_state: "Proposed" },
          { from_state: null },
        ]),
        errorResponse("XX000", "x"),
      ],
    });
    expect(await listMovableStates(db, "project")).toEqual({
      ok: true,
      data: ["Proposed", "Active"],
    });
    expect((await listMovableStates(db, "project")).ok).toBe(false);
  });

  it("reads allowed transitions and moves both lifecycles", async () => {
    const { db, calls } = fakeClient({
      "from:lifecycle_transition_rules": [
        okResponse([{ to_state: "Active" }, { to_state: null }]),
        errorResponse("XX000", "x"),
      ],
      "rpc:transition_project": [
        okResponse("l1"),
        errorResponse("XR001", "project_state_conflict: Reload.", "project_state_conflict"),
      ],
      "rpc:transition_production": [okResponse("l2"), errorResponse("42501", "no")],
    });
    expect(await listAllowedTransitions(db, "project", "Proposed")).toEqual({
      ok: true,
      data: ["Active"],
    });
    expect((await listAllowedTransitions(db, "project", "Proposed")).ok).toBe(false);
    const input = {
      projectId: "p1",
      expected: "Proposed",
      next: "Active",
      reason: " Go ",
    } as const;
    expect(await transitionProject(db, input)).toEqual({ ok: true, data: "l1" });
    expect(calls[2]?.steps[0]).toEqual([
      "args",
      [{ p_project_id: "p1", p_expected: "Proposed", p_next: "Active", p_reason: "Go" }],
    ]);
    expect(await transitionProject(db, input)).toMatchObject({
      ok: false,
      error: { kind: "refusal", rule: "project_state_conflict" },
    });
    expect(await transitionProduction(db, input)).toEqual({ ok: true, data: "l2" });
    expect((await transitionProduction(db, input)).ok).toBe(false);
  });

  it("reads both state ledgers", async () => {
    const row = {
      id: "t1",
      from_state: null,
      to_state: "Proposed",
      reason: "Created.",
      created_at: "2026-10-01",
      actor: { full_name: "Ada" },
    };
    const { db } = fakeClient({
      "from:project_state_transitions": [okResponse([row]), errorResponse("XX000", "x")],
      "from:production_state_transitions": [
        okResponse([{ ...row, actor: null }]),
        errorResponse("XX000", "x"),
      ],
    });
    expect(await listProjectStateHistory(db, "p1")).toEqual({
      ok: true,
      data: [
        {
          id: "t1",
          fromState: null,
          toState: "Proposed",
          reason: "Created.",
          actor: "Ada",
          at: "2026-10-01",
        },
      ],
    });
    expect((await listProjectStateHistory(db, "p1")).ok).toBe(false);
    const production = await listProductionStateHistory(db, "p1");
    expect(production.ok && production.data[0]?.actor).toBe(null);
    expect((await listProductionStateHistory(db, "p1")).ok).toBe(false);
  });
});

describe("scope tree", () => {
  it("lists, creates, renames and removes nodes", async () => {
    const node = {
      id: "s2",
      parent_id: "s1",
      scope_kind: "Show",
      scope_code: "NWL-S01",
      name: "Opening Night",
      venue_id: null,
      path: "NWL_E01.NWL_S01",
      venue: null,
    };
    const { db, calls } = fakeClient({
      "from:scope_nodes": [
        okResponse([node]),
        errorResponse("XX000", "x"),
        okResponse({ id: "s3" }),
        errorResponse("XR001", "scope_node_parent_project: no", "scope_node_parent_project"),
        okResponse([{ id: "s2" }]),
        okResponse([{ id: "s2" }]),
      ],
    });
    expect(await listScopeNodes(db, "p1")).toEqual({
      ok: true,
      data: [
        {
          id: "s2",
          parentId: "s1",
          kind: "Show",
          code: "NWL-S01",
          name: "Opening Night",
          venueId: null,
          venueName: null,
          path: "NWL_E01.NWL_S01",
        },
      ],
    });
    expect((await listScopeNodes(db, "p1")).ok).toBe(false);
    const input = {
      projectId: "p1",
      parentId: "s1",
      kind: "Show",
      code: "NWL-S02",
      name: "B",
    } as const;
    expect(await createScopeNode(db, input)).toEqual({ ok: true, data: { id: "s3" } });
    expect((await createScopeNode(db, input)).ok).toBe(false);
    expect(await updateScopeNode(db, "s2", { name: " C ", venueId: null })).toEqual({
      ok: true,
      data: null,
    });
    expect(calls[4]?.steps[0]).toEqual(["update", [{ name: "C", venue_id: null }]]);
    expect(await removeScopeNode(db, "s2")).toEqual({ ok: true, data: null });
  });
});

describe("gates", () => {
  it("reads canon phases, criteria and ranks", async () => {
    const { db } = canonClient({
      "from:xpms:dim_phase": [
        okResponse([
          {
            phase_code: "SCP",
            gate: 1,
            phase: "Scope",
            act_code: "PLAN",
            definition: "d",
            gate_exit: "e",
          },
        ]),
        errorResponse("XX000", "x"),
      ],
      "from:xpms:dim_gate_criterion": [
        okResponse([
          { criterion_id: "G1.GONOGO", gate: 1, ordinal: 2, statement: "s", is_blocking: true },
        ]),
        errorResponse("XX000", "x"),
      ],
      "from:xpms:dim_assertion_rank": [
        okResponse([{ rank: 4, meaning: "Attested." }]),
        errorResponse("XX000", "x"),
      ],
    });
    expect(await listPhases(db)).toEqual({
      ok: true,
      data: [
        { code: "SCP", gate: 1, name: "Scope", actCode: "PLAN", definition: "d", gateExit: "e" },
      ],
    });
    expect((await listPhases(db)).ok).toBe(false);
    expect(await listGateCriteria(db)).toEqual({
      ok: true,
      data: [{ id: "G1.GONOGO", gate: 1, ordinal: 2, statement: "s", blocking: true }],
    });
    expect((await listGateCriteria(db)).ok).toBe(false);
    expect(await listAssertionRanks(db)).toEqual({
      ok: true,
      data: [{ rank: 4, meaning: "Attested." }],
    });
    expect((await listAssertionRanks(db)).ok).toBe(false);
  });

  it("derives criterion status and keeps absent ranks null", async () => {
    const { db } = fakeClient({
      "from:gate_criteria_status": [
        okResponse([
          {
            project_id: "p1",
            criterion_id: "G1.GONOGO",
            gate: 1,
            is_blocking: true,
            evidence_count: null,
            best_assertion_rank: null,
            gate_passed: null,
          },
          {
            project_id: null,
            criterion_id: null,
            gate: null,
            is_blocking: null,
            evidence_count: 0,
            best_assertion_rank: null,
            gate_passed: false,
          },
        ]),
        errorResponse("XX000", "x"),
      ],
    });
    expect(await listCriterionStatus(db, [])).toEqual({ ok: true, data: [] });
    expect(await listCriterionStatus(db, ["p1"])).toEqual({
      ok: true,
      data: [
        {
          projectId: "p1",
          criterionId: "G1.GONOGO",
          gate: 1,
          blocking: true,
          evidenceCount: 0,
          bestRank: null,
          gatePassed: false,
        },
      ],
    });
    expect((await listCriterionStatus(db, ["p1"])).ok).toBe(false);
  });

  it("attests, lists and withdraws evidence", async () => {
    const { db, calls } = fakeClient({
      "from:gate_evidence": [
        okResponse({ id: "e1" }),
        okResponse({ id: "e2" }),
        errorResponse("XR001", "gate_evidence_reference: Name it.", "gate_evidence_reference"),
        okResponse([
          {
            id: "e1",
            criterion_id: "G1.GONOGO",
            evidence_uri: "https://example.com/go.pdf",
            note: null,
            assertion_rank: 4,
            attested_at: "2026-10-01",
            attester: null,
          },
        ]),
        errorResponse("XX000", "x"),
        okResponse([{ id: "e1" }]),
      ],
    });
    const input = { projectId: "p1", criterionId: "G1.GONOGO", uri: " https://a ", rank: 4 };
    expect(await attestEvidence(db, { ...input, note: " Signed. " })).toEqual({
      ok: true,
      data: { id: "e1" },
    });
    expect(calls[0]?.steps[0]?.[1][0]).toMatchObject({
      evidence_uri: "https://a",
      note: "Signed.",
    });
    await attestEvidence(db, { ...input, note: "  " });
    expect(calls[1]?.steps[0]?.[1][0]).toMatchObject({ note: null });
    expect(await attestEvidence(db, input)).toMatchObject({
      ok: false,
      error: { rule: "gate_evidence_reference" },
    });
    const listed = await listGateEvidence(db, "p1");
    expect(listed.ok && listed.data[0]).toMatchObject({ rank: 4, attestedBy: null });
    expect((await listGateEvidence(db, "p1")).ok).toBe(false);
    expect(await withdrawEvidence(db, "e1")).toEqual({ ok: true, data: null });
  });

  it("passes a gate or returns the named unmet criteria", async () => {
    const { db } = fakeClient({
      "rpc:pass_gate": [
        okResponse("ENG"),
        errorResponse(
          "XR001",
          "gate_criteria_unmet: Gate 1 needs evidence for every blocking criterion; missing: G1.GONOGO.",
          "gate_criteria_unmet",
        ),
      ],
    });
    const input = { projectId: "p1", expectedPhase: "SCP", reason: "Go." };
    expect(await passGate(db, input)).toEqual({ ok: true, data: "ENG" });
    expect(await passGate(db, input)).toEqual({
      ok: false,
      error: {
        kind: "refusal",
        rule: "gate_criteria_unmet",
        message: "Gate 1 needs evidence for every blocking criterion; missing: G1.GONOGO.",
      },
    });
  });

  it("reads the gates passed", async () => {
    const { db } = fakeClient({
      "from:project_phase_transitions": [
        okResponse([
          {
            id: "g1",
            gate: 1,
            from_phase_code: "SCP",
            to_phase_code: "ENG",
            reason: "Go.",
            created_at: "2026-10-02",
            actor: { full_name: "Ada" },
          },
        ]),
        errorResponse("XX000", "x"),
      ],
    });
    expect(await listPhaseTransitions(db, "p1")).toEqual({
      ok: true,
      data: [
        {
          id: "g1",
          gate: 1,
          fromPhaseCode: "SCP",
          toPhaseCode: "ENG",
          reason: "Go.",
          actor: "Ada",
          at: "2026-10-02",
        },
      ],
    });
    expect((await listPhaseTransitions(db, "p1")).ok).toBe(false);
  });
});

describe("members and lookups", () => {
  it("lists members by role order, adds and ends them", async () => {
    const member = (id: string, role: string, name: string | null) => ({
      id,
      membership_id: `m${id}`,
      project_role: role,
      valid_from: "2026-10-01",
      valid_to: null,
      membership: { person_id: `p${id}`, person: name === null ? null : { full_name: name } },
    });
    const { db } = fakeClient({
      "from:project_members": [
        okResponse([
          member("1", "Field", "Zed"),
          member("2", "Producer", "Bea"),
          member("3", "Producer", null),
          { ...member("4", "Coordinator", "Cy"), membership: null },
        ]),
        errorResponse("XX000", "x"),
        okResponse({ id: "pm1" }),
        errorResponse("XR001", "sod_self_grant: No.", "sod_self_grant"),
        okResponse([{ id: "pm1" }]),
      ],
    });
    const listed = await listProjectMembers(db, "p1");
    expect(listed.ok && listed.data.map((m) => m.id)).toEqual(["3", "2", "4", "1"]);
    expect((await listProjectMembers(db, "p1")).ok).toBe(false);
    const input = { projectId: "p1", membershipId: "m1", role: "Field" } as const;
    expect(await addProjectMember(db, input)).toEqual({ ok: true, data: { id: "pm1" } });
    expect(await addProjectMember(db, input)).toMatchObject({
      ok: false,
      error: { rule: "sod_self_grant" },
    });
    expect(await endProjectMember(db, "pm1")).toEqual({ ok: true, data: null });
  });

  it("reads jurisdictions, tiers, regions and venues", async () => {
    const { db } = canonClient({
      "from:xpms:jurisdiction": [
        okResponse([
          { jurisdiction_id: "US", level: "country", parent: null, status: "populated" },
          {
            jurisdiction_id: "US-NV",
            level: "region",
            parent: "US",
            status: "declared-unpopulated",
          },
        ]),
        errorResponse("XX000", "x"),
      ],
      "from:xpms:dim_tier": [
        okResponse([{ tier_code: "01", tier: "Social" }]),
        errorResponse("XX000", "x"),
      ],
      "from:xpms:dim_region": [
        okResponse([{ region_code: "NA-SE-MIA" }]),
        errorResponse("XX000", "x"),
      ],
      "from:venues": [
        okResponse([
          {
            id: "v1",
            name: "Bayfront Park",
            jurisdiction_id: "US-FL",
            time_zone: "America/New_York",
          },
        ]),
        errorResponse("XX000", "x"),
      ],
    });
    const j = await listJurisdictions(db);
    expect(j.ok && j.data.map((x) => x.populated)).toEqual([true, false]);
    expect((await listJurisdictions(db)).ok).toBe(false);
    expect(await listTiers(db)).toEqual({ ok: true, data: [{ code: "01", label: "Social" }] });
    expect((await listTiers(db)).ok).toBe(false);
    expect(await listRegions(db)).toEqual({
      ok: true,
      data: [{ code: "NA-SE-MIA", label: "NA-SE-MIA" }],
    });
    expect((await listRegions(db)).ok).toBe(false);
    expect(await listVenues(db, "o1")).toEqual({
      ok: true,
      data: [
        { id: "v1", name: "Bayfront Park", jurisdictionId: "US-FL", timeZone: "America/New_York" },
      ],
    });
    expect((await listVenues(db, "o1")).ok).toBe(false);
  });
});

describe("coordinate matrix", () => {
  it("reads departments and counts records by department and phase", async () => {
    const { db } = canonClient({
      "from:xpms:dim_department": [
        okResponse([{ dept_code: "1000", department: "Creative" }]),
        errorResponse("XX000", "x"),
      ],
      "from:records": [
        okResponse([
          { urid: "1000.01.01", phase_code: "SCP" },
          { urid: "1000.02.03", phase_code: "SCP" },
          { urid: "5000.01.01", phase_code: "BLD" },
          { urid: null, phase_code: "BLD" },
        ]),
        errorResponse("XX000", "x"),
      ],
    });
    expect(await listDepartments(db)).toEqual({
      ok: true,
      data: [{ code: "1000", label: "Creative" }],
    });
    expect((await listDepartments(db)).ok).toBe(false);
    expect(await countRecordsByCoordinate(db, "p1")).toEqual({
      ok: true,
      data: { "1000|SCP": 2, "5000|BLD": 1 },
    });
    expect((await countRecordsByCoordinate(db, "p1")).ok).toBe(false);
  });
});

describe("currencies", () => {
  it("lists currency codes", async () => {
    const { db } = fakeClient({
      "from:currencies": [
        okResponse([{ currency_code: "EUR" }, { currency_code: null }]),
        errorResponse("XX000", "x"),
      ],
    });
    expect(await listCurrencies(db)).toEqual({ ok: true, data: ["EUR"] });
    expect((await listCurrencies(db)).ok).toBe(false);
  });
});
