import { describe, expect, it } from "vitest";
import { listOpenScanIntake, resolveScanIntake } from "../src/scan-intake.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

/** The scan intake queue (0367) that Aurora's Suggest binding works from (A95). */

const row = {
  id: "s1",
  project_id: "p1",
  scanned_value: "0012345678905",
  symbology: "EAN-13",
  scan_mode: "Inventory",
  scanned_by: "u1",
  device_scanned_at: "2026-10-20T14:00:00Z",
  project: { project_key: "NWS" },
  scanner: { full_name: "Ivy Chen" },
};

describe("scan intake queue", () => {
  it("lists open scans newest first, with the project key and the scanner", async () => {
    const { db, calls } = fakeClient({
      "from:scan_intake": [okResponse([row, { ...row, id: "s2", project: null, scanner: null }])],
    });
    const result = await listOpenScanIntake(db, { orgId: "o1", projectId: "p1" });
    expect(result).toEqual({
      ok: true,
      data: [
        {
          id: "s1",
          projectId: "p1",
          projectKey: "NWS",
          scannedValue: "0012345678905",
          symbology: "EAN-13",
          scanMode: "Inventory",
          scannedById: "u1",
          scannedByName: "Ivy Chen",
          deviceScannedAt: "2026-10-20T14:00:00Z",
        },
        expect.objectContaining({ id: "s2", projectKey: null, scannedByName: null }),
      ],
    });
    const steps = calls[0]?.steps ?? [];
    expect(steps).toContainEqual(["eq", ["org_id", "o1"]]);
    expect(steps).toContainEqual(["is", ["resolved_at", null]]);
    expect(steps).toContainEqual(["eq", ["project_id", "p1"]]);
    expect(steps).toContainEqual(["order", ["device_scanned_at", { ascending: false }]]);
  });

  it("lists every project's scans without a project and returns read errors", async () => {
    const { db, calls } = fakeClient({
      "from:scan_intake": [okResponse([]), errorResponse("42501", "denied")],
    });
    expect(await listOpenScanIntake(db, { orgId: "o1" })).toEqual({ ok: true, data: [] });
    expect(calls[0]?.steps.some(([m, a]) => m === "eq" && a[0] === "project_id")).toBe(false);
    expect((await listOpenScanIntake(db, { orgId: "o1" })).ok).toBe(false);
  });

  it("resolves a scan to a record, or dismisses it with a note", async () => {
    const { db, calls } = fakeClient({
      "rpc:resolve_scan_intake": [
        okResponse("2026-10-21T12:00:00Z"),
        okResponse("2026-10-21T12:00:00Z"),
        errorResponse(
          "XR001",
          "scan_intake_resolved: This scan was already resolved.",
          "scan_intake_resolved",
        ),
      ],
    });
    expect(
      await resolveScanIntake(db, "s1", {
        resolution: "Created",
        subjectTable: "catalog_bindings",
        subjectId: "b1",
        note: "Bound by Aurora's suggestion.",
      }),
    ).toEqual({ ok: true, data: null });
    expect(
      await resolveScanIntake(db, "s2", { resolution: "Dismissed", note: "Test tag." }),
    ).toEqual({ ok: true, data: null });
    expect(calls[0]?.steps[0]).toEqual([
      "args",
      [
        {
          p_scan_intake_id: "s1",
          p_resolution: "Created",
          p_subject_table: "catalog_bindings",
          p_subject_id: "b1",
          p_note: "Bound by Aurora's suggestion.",
        },
      ],
    ]);
    expect(calls[1]?.steps[0]).toEqual([
      "args",
      [{ p_scan_intake_id: "s2", p_resolution: "Dismissed", p_note: "Test tag." }],
    ]);
    expect(
      await resolveScanIntake(db, "s1", {
        resolution: "Matched",
        subjectTable: "catalog_bindings",
        subjectId: "b1",
      }),
    ).toMatchObject({ ok: false, error: { kind: "refusal", rule: "scan_intake_resolved" } });
  });
});
