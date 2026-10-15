import { describe, expect, it } from "vitest";
import {
  archiveCapabilityStatement,
  createCapabilityStatement,
  getLatestReconciliation,
  listCapabilityAssertionWords,
  listCapabilityStatements,
  reconcileProject,
  summarizeReconciliation,
  updateCapabilityStatement,
} from "../src/reconciliation.ts";
import { canonClient } from "./canon-client.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

const statementRow = {
  id: "q1",
  project_id: "p1",
  direction: "Require",
  urid: "4000.01.01",
  description: "Seats for 1,200.",
  quantity: "1200",
  unit_basis: null,
  is_critical: true,
  assertion_word: "UNKNOWN",
  venue_id: null,
  counterparty_id: null,
};

describe("capability statements", () => {
  it("lists statements and keeps an uncounted quantity NULL", async () => {
    const { db, calls } = fakeClient({
      "from:capability_statements": [
        okResponse([statementRow, { ...statementRow, id: "q2", quantity: null }]),
        errorResponse("PGRST000", "x"),
      ],
    });
    const result = await listCapabilityStatements(db, { projectId: "p1", venueId: "v1" });
    expect(result.ok && result.data.map((s) => s.quantity)).toEqual([1200, null]);
    expect(calls[0]?.steps).toContainEqual(["eq", ["venue_id", "v1"]]);
    expect((await listCapabilityStatements(db, {})).ok).toBe(false);
  });

  it("creates a requirement and never marks a capability critical", async () => {
    const { db, calls } = fakeClient({
      "from:capability_statements": [okResponse([{ id: "q1" }]), okResponse([{ id: "c1" }])],
    });
    await createCapabilityStatement(db, {
      projectId: "p1",
      direction: "Require",
      urid: "4000.01.01",
      description: " Seats ",
      critical: true,
    });
    expect(calls[0]?.steps[0]?.[1]).toEqual([
      {
        project_id: "p1",
        direction: "Require",
        urid: "4000.01.01",
        description: "Seats",
        quantity: null,
        unit_basis: null,
        is_critical: true,
        assertion_word: "UNKNOWN",
        venue_id: null,
        counterparty_id: null,
      },
    ]);
    await createCapabilityStatement(db, {
      projectId: "p1",
      direction: "Provide",
      urid: "4000.01.01",
      description: "Seats",
      critical: true,
      venueId: "v1",
      assertionWord: "DOCUMENTED",
      quantity: 1200,
    });
    expect(calls[1]?.steps[0]?.[1]).toMatchObject([{ is_critical: false, venue_id: "v1" }]);
  });

  it("updates and archives", async () => {
    const at = new Date("2026-10-14T00:00:00Z");
    const { db, calls } = fakeClient({
      "from:capability_statements": [okResponse([{ id: "q1" }]), okResponse([{ id: "q1" }])],
    });
    expect(
      (await updateCapabilityStatement(db, "q1", { urid: "4000.01.01", description: "x" })).ok,
    ).toBe(true);
    await archiveCapabilityStatement(db, "q1", at);
    expect(calls[1]?.steps[0]).toEqual(["update", [{ deleted_at: at.toISOString() }]]);
  });

  it("reads the capability assertion family strongest first", async () => {
    const { db, calls } = canonClient({
      "from:dim_assertion_word": [
        okResponse([
          { word: "CERTIFIED", rank: 4 },
          { word: "UNKNOWN", rank: 0 },
        ]),
        errorResponse("PGRST000", "x"),
      ],
    });
    expect(await listCapabilityAssertionWords(db)).toEqual({
      ok: true,
      data: [
        { word: "CERTIFIED", rank: 4 },
        { word: "UNKNOWN", rank: 0 },
      ],
    });
    expect(calls[0]?.steps).toContainEqual(["eq", ["domain", "capability"]]);
    expect((await listCapabilityAssertionWords(db)).ok).toBe(false);
  });
});

describe("reconciliation", () => {
  it("runs the reconciliation RPC and maps refusals", async () => {
    const { db, calls } = fakeClient({
      "rpc:reconcile_project": [
        okResponse("r1"),
        errorResponse("42501", "advancing.reconciliation.write is required on the project"),
      ],
    });
    expect(await reconcileProject(db, "p1", "Venue walk.")).toEqual({
      ok: true,
      data: { id: "r1" },
    });
    expect(calls[0]?.steps[0]).toEqual(["args", [{ p_project_id: "p1", p_note: "Venue walk." }]]);
    expect(await reconcileProject(db, "p1")).toEqual({ ok: false, error: { kind: "not-found" } });
  });

  it("reads the latest reconciliation or null before the first run", async () => {
    const { db } = fakeClient({
      "from:reconciliations": [
        okResponse({
          id: "r1",
          reconciled_at: "2026-10-14T00:00:00Z",
          note: null,
          reconciliation_lines: [
            { requirement_id: "q1", capability_id: null, result: "Unknown", deleted_at: null },
            { requirement_id: "q2", capability_id: "c1", result: "Met", deleted_at: "2026-10-14" },
          ],
        }),
        okResponse(null),
        errorResponse("PGRST000", "x"),
      ],
    });
    const latest = await getLatestReconciliation(db, "p1");
    expect(latest.ok && latest.data?.lines).toEqual([
      { requirementId: "q1", capabilityId: null, result: "Unknown" },
    ]);
    expect(await getLatestReconciliation(db, "p1")).toEqual({ ok: true, data: null });
    expect((await getLatestReconciliation(db, "p1")).ok).toBe(false);
  });

  it("counts gate 3 gaps as every Gap and every critical Unknown", () => {
    const summary = summarizeReconciliation(
      [
        { requirementId: "a", capabilityId: "c", result: "Met" },
        { requirementId: "b", capabilityId: "c", result: "Gap" },
        { requirementId: "c", capabilityId: null, result: "Unknown" },
        { requirementId: "d", capabilityId: null, result: "Unknown" },
      ],
      [
        { id: "a", critical: true },
        { id: "b", critical: false },
        { id: "c", critical: true },
        { id: "d", critical: false },
      ],
    );
    expect(summary).toEqual({ met: 1, gap: 1, unknown: 2, gateGaps: 2 });
  });
});
