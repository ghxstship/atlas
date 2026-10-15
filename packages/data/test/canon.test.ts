import { describe, expect, it } from "vitest";
import {
  canonExtensionProblems,
  decideCanonExtension,
  listCanonExtensionProposals,
  listCanonRoles,
  listCategories,
  listDepartments,
  listDisciplines,
  listElements,
  listJurisdictions,
  listMetrics,
  listPhases,
  listRecordKinds,
  proposeCanonExtension,
  searchElements,
  updateCanonExtension,
} from "../src/canon.ts";
import {
  blankToNull,
  deletedNow,
  insertedId,
  readOne,
  readRows,
  rpcValue,
  touched,
} from "../src/commercial-common.ts";
import { commercialClient, errorResponse, okResponse } from "./commercial-fake.ts";

const down = errorResponse("08006", "down");

describe("commercial common", () => {
  it("maps reads, writes and RPC values to results", async () => {
    expect(await readRows(Promise.resolve({ data: null, error: null }), (r) => r)).toEqual({
      ok: true,
      data: [],
    });
    expect(
      (
        await readOne(
          Promise.resolve({ data: null, error: { code: "42501", message: "no" } }),
          (r) => r,
        )
      ).ok,
    ).toBe(false);
    expect(await insertedId(Promise.resolve({ data: null, error: null }))).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect(
      (await insertedId(Promise.resolve({ data: null, error: { code: "23505", message: "dup" } })))
        .ok,
    ).toBe(false);
    expect((await touched(Promise.resolve({ data: null, error: { message: "x" } }))).ok).toBe(
      false,
    );
    expect(await touched(Promise.resolve({ data: null, error: null }))).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect(await rpcValue(Promise.resolve({ data: 5, error: null }))).toEqual({
      ok: true,
      data: 5,
    });
    expect(deletedNow(new Date("2026-10-14T00:00:00Z"))).toEqual({
      deleted_at: "2026-10-14T00:00:00.000Z",
    });
    expect(blankToNull(undefined)).toBeNull();
    expect(blankToNull("  x ")).toBe("x");
  });
});

describe("canon reads", () => {
  it("reads departments, disciplines and categories in code order", async () => {
    const { db, calls } = commercialClient({
      "from:xpms:dim_department": [
        okResponse([
          {
            dept_code: "1000",
            department: "Production",
            core_function: null,
            scope: null,
            dim_discipline: [{ disc_code: "1000.01" }],
          },
        ]),
      ],
      "from:xpms:dim_discipline": [
        okResponse([
          {
            disc_code: "1000.01",
            dept_code: "1000",
            discipline: "Staging",
            source: "canon",
            is_extension: false,
            dim_category: null,
          },
        ]),
      ],
      "from:xpms:dim_category": [
        okResponse([
          {
            cat_urid: "1000.01.01",
            disc_code: "1000.01",
            category: "Decks",
            xyz: "X",
            is_extension: false,
          },
        ]),
      ],
    });
    const departments = await listDepartments(db);
    expect(departments.ok && departments.data[0]?.disciplineCount).toBe(1);
    const disciplines = await listDisciplines(db);
    expect(disciplines.ok && disciplines.data[0]?.categoryCount).toBe(0);
    expect((await listCategories(db)).ok).toBe(true);
    expect(calls.map((c) => c.target)).toEqual([
      "from:xpms:dim_department",
      "from:xpms:dim_discipline",
      "from:xpms:dim_category",
    ]);
  });

  it("pages and filters elements with a total count", async () => {
    const element = {
      element_id: "1000.01.01-XOS-001",
      urid: "1000.01.01",
      item: "Stage Deck",
      common_name: null,
      unit_basis: "ea",
      grade: "Base",
      tier_code: "03",
      lead_time_hours: null,
      description: null,
    };
    const { db, calls } = commercialClient({
      "from:xpms:elements": [
        { data: [element], error: null, count: 12 } as never,
        { data: null, error: null, count: null } as never,
        down,
        { data: [element, element], error: null, count: 2 } as never,
      ],
    });
    const page = await listElements(db, { query: " deck,(%) ", uridPrefix: "1000.01", page: 1 });
    expect(page.ok && page.data.total).toBe(12);
    expect(calls[0]?.steps).toContainEqual([
      "or",
      ["item.ilike.*deck*,common_name.ilike.*deck*,element_id.ilike.*deck*,urid.ilike.*deck*"],
    ]);
    expect(calls[0]?.steps).toContainEqual(["like", ["urid", "1000.01%"]]);
    expect(calls[0]?.steps).toContainEqual(["range", [50, 99]]);
    expect(await listElements(db, { uridPrefix: "x;drop", page: -3 })).toEqual({
      ok: true,
      data: { total: 0, elements: [] },
    });
    expect(calls[1]?.steps.some(([name]) => name === "like")).toBe(false);
    expect((await listElements(db)).ok).toBe(false);
    const options = await searchElements(db, "deck", 1);
    expect(options.ok && options.data).toEqual([
      { id: element.element_id, name: "Stage Deck", urid: "1000.01.01", unitBasis: "ea" },
    ]);
  });

  it("returns search errors", async () => {
    const { db } = commercialClient({ "from:xpms:elements": [down] });
    expect((await searchElements(db, "deck")).ok).toBe(false);
  });

  it("joins phases to their gate criteria", async () => {
    const { db } = commercialClient({
      "from:xpms:dim_phase": [
        okResponse([
          {
            phase_code: "SCP",
            gate: 1,
            phase: "Scope",
            act_code: "PLAN",
            definition: "D.",
            gate_exit: "E.",
          },
        ]),
        down,
        okResponse([]),
      ],
      "from:xpms:dim_gate_criterion": [
        okResponse([
          { criterion_id: "G1.1", gate: 1, ordinal: 1, statement: "S.", is_blocking: true },
          { criterion_id: "G2.1", gate: 2, ordinal: 2, statement: "T.", is_blocking: false },
        ]),
        okResponse([]),
        down,
      ],
    });
    const phases = await listPhases(db);
    expect(phases.ok && phases.data[0]?.criteria).toEqual([
      { id: "G1.1", statement: "S.", isBlocking: true },
    ]);
    expect((await listPhases(db)).ok).toBe(false);
    expect((await listPhases(db)).ok).toBe(false);
  });

  it("reads record kinds, roles and metrics", async () => {
    const { db } = commercialClient({
      "from:xpms:dim_record_kind": [
        okResponse([
          {
            record_kind: "Task",
            record_class: "Work",
            definition: "D.",
            definition_of_done: "Done.",
            title_grammar: "Verb",
            ordinal: 1,
            dim_record_subtype: [
              { record_subtype: "B", ordinal: 2 },
              { record_subtype: "A", ordinal: 1 },
            ],
          },
          {
            record_kind: "Shift",
            record_class: "Work",
            definition: "D.",
            definition_of_done: "Done.",
            title_grammar: "Noun",
            ordinal: 2,
            dim_record_subtype: null,
          },
        ]),
      ],
      "from:xpms:dim_role": [
        okResponse([
          {
            role_code: "1000.01.01",
            role: "Stage Manager",
            dept_code: "1000",
            job_title: null,
            staffing_ratio: 1,
            ratio_basis: "per stage",
          },
        ]),
      ],
      "from:xpms:dim_metric": [
        okResponse([
          {
            domain: "Safety",
            item: "Occupancy",
            value_numeric: null,
            value_text: "Per code",
            qualifier: null,
            source: null,
            jurisdiction_id: null,
            provenance: "canon",
          },
          {
            domain: "Safety",
            item: "Ratio",
            value_numeric: 2,
            value_text: null,
            qualifier: null,
            source: null,
            jurisdiction_id: "US",
            provenance: "canon",
          },
          {
            domain: "x",
            item: "y",
            value_numeric: null,
            value_text: null,
            qualifier: null,
            source: null,
            jurisdiction_id: null,
            provenance: "canon",
          },
        ]),
      ],
    });
    const kinds = await listRecordKinds(db);
    expect(kinds.ok && kinds.data[0]?.subtypes).toEqual(["A", "B"]);
    expect(kinds.ok && kinds.data[1]?.subtypes).toEqual([]);
    expect((await listCanonRoles(db)).ok).toBe(true);
    const metrics = await listMetrics(db);
    expect(metrics.ok && metrics.data.map((m) => m.value)).toEqual(["Per code", 2, ""]);
  });

  it("joins jurisdictions to their permit rules", async () => {
    const { db } = commercialClient({
      "from:xpms:jurisdiction": [
        okResponse([
          {
            jurisdiction_id: "US",
            level: "country",
            parent: null,
            status: "populated",
            currency: "USD",
            unit_system: "imperial",
            note: null,
          },
        ]),
        down,
        okResponse([]),
      ],
      "from:xpms:dim_permit_rule": [
        okResponse([
          {
            rule: "R1",
            trigger_type: "element",
            condition: "C.",
            permit: "P.",
            ahj: "Fire",
            lead_time: "14 days",
            jurisdiction_id: "US",
            provenance: "canon",
          },
        ]),
        okResponse([]),
        down,
      ],
    });
    const result = await listJurisdictions(db);
    expect(result.ok && result.data[0]?.permitRules[0]?.leadTime).toBe("14 days");
    expect((await listJurisdictions(db)).ok).toBe(false);
    expect((await listJurisdictions(db)).ok).toBe(false);
  });
});

describe("canon extensions", () => {
  it("checks shape, parent and range before the round trip", () => {
    const base = { label: "Drone Shows", rationale: "R." };
    expect(
      canonExtensionProblems({
        ...base,
        level: "Discipline",
        parentCode: "1000",
        proposedCode: "1000.90",
      }),
    ).toEqual([]);
    expect(
      canonExtensionProblems({
        ...base,
        level: "Discipline",
        parentCode: "1000",
        proposedCode: "1000.10",
      }),
    ).toEqual(["range"]);
    expect(
      canonExtensionProblems({
        ...base,
        level: "Discipline",
        parentCode: "2000",
        proposedCode: "1000.90",
      }),
    ).toEqual(["parent"]);
    expect(
      canonExtensionProblems({
        ...base,
        level: "Discipline",
        parentCode: "1000.01",
        proposedCode: "1000.90",
      }),
    ).toEqual(["shape"]);
    expect(
      canonExtensionProblems({
        ...base,
        level: "Category",
        parentCode: "1000.01",
        proposedCode: "1000.01.60",
      }),
    ).toEqual([]);
    expect(
      canonExtensionProblems({
        ...base,
        level: "Category",
        parentCode: "1000.90",
        proposedCode: "1000.90.01",
      }),
    ).toEqual([]);
    expect(
      canonExtensionProblems({
        ...base,
        level: "Category",
        parentCode: "1000.01",
        proposedCode: "1000.01.02",
      }),
    ).toEqual(["range"]);
  });

  it("lists, proposes, edits and decides proposals", async () => {
    const { db, calls } = commercialClient({
      "from:canon_extension_proposals": [
        okResponse([
          {
            id: "x1",
            extension_level: "Discipline",
            parent_code: "1000",
            proposed_code: "1000.90",
            label: "Drone Shows",
            rationale: "R.",
            proposal_state: "Proposed",
            decided_by: null,
            decided_at: null,
            created_by: "p1",
            created_at: "t",
          },
        ]),
        okResponse({ id: "x2" }),
        okResponse([{ id: "x2" }]),
      ],
      "rpc:decide_canon_extension": [
        okResponse("t1"),
        errorResponse("XR001", "sod_approval_requester: No.", "sod_approval_requester"),
      ],
    });
    const list = await listCanonExtensionProposals(db, "o1");
    expect(list.ok && list.data[0]?.proposedCode).toBe("1000.90");
    const input = {
      level: "Category" as const,
      parentCode: " 1000.90 ",
      proposedCode: " 1000.90.01 ",
      label: " Swarms ",
      rationale: " Big. ",
    };
    expect((await proposeCanonExtension(db, "o1", input)).ok).toBe(true);
    expect(calls[1]?.steps[0]?.[1]).toEqual([
      {
        org_id: "o1",
        extension_level: "Category",
        parent_code: "1000.90",
        proposed_code: "1000.90.01",
        label: "Swarms",
        rationale: "Big.",
      },
    ]);
    expect((await updateCanonExtension(db, "x2", { label: "L", rationale: "R." })).ok).toBe(true);
    const move = {
      id: "x2",
      expected: "Proposed" as const,
      next: "Approved" as const,
      reason: "Core.",
    };
    expect(await decideCanonExtension(db, move)).toEqual({ ok: true, data: null });
    expect(calls[3]?.steps[0]).toEqual([
      "args",
      [{ p_proposal_id: "x2", p_expected: "Proposed", p_next: "Approved", p_reason: "Core." }],
    ]);
    const refused = await decideCanonExtension(db, move);
    expect(refused.ok === false && refused.error.kind === "refusal" && refused.error.rule).toBe(
      "sod_approval_requester",
    );
  });
});
