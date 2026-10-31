import { describe, expect, it } from "vitest";

import {
  listChangesSince,
  listCommunicationStatus,
  listTodayChanges,
  markCommunicated,
  markSeen,
  recordVisit,
  seenBaseline,
} from "../src/change-tracking.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `id-${i}`);

describe("seen marks", () => {
  it("reads the baseline without a visit, and passes the page and scope", async () => {
    const { db, calls } = fakeClient({ "rpc:seen_baseline": [okResponse("2027-06-01T12:00:00Z")] });
    expect(await seenBaseline(db, "Today", "org-1")).toEqual({
      ok: true,
      data: "2027-06-01T12:00:00Z",
    });
    expect(calls[0]?.steps[0]).toEqual(["args", [{ p_surface: "Today", p_scope_id: "org-1" }]]);
  });

  it("answers null on a first visit", async () => {
    const { db } = fakeClient({ "rpc:record_visit": [okResponse(null)] });
    expect(await recordVisit(db, "Itinerary", "eng-1")).toEqual({ ok: true, data: null });
  });

  it("marks all as seen", async () => {
    const { db, calls } = fakeClient({ "rpc:mark_seen": [okResponse("2027-06-01T12:30:00Z")] });
    expect(await markSeen(db, "Show Day", "prj-1")).toEqual({
      ok: true,
      data: "2027-06-01T12:30:00Z",
    });
    expect(calls[0]?.target).toBe("rpc:mark_seen");
  });

  it("maps a scope that is not open to not-found", async () => {
    const { db } = fakeClient({
      "rpc:record_visit": [errorResponse("42501", "the page is not available to you")],
    });
    const result = await recordVisit(db, "Today", "org-2");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("not-found");
  });
});

describe("listChangesSince", () => {
  it("asks for nothing without a baseline", async () => {
    const { db, calls } = fakeClient({});
    const result = await listChangesSince(db, "app.cues", ["a"], null);
    expect(result.ok && result.data.size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("sends 200 ids at a time and keys the changes by row", async () => {
    const { db, calls } = fakeClient({
      "rpc:changes_since": [
        okResponse([
          {
            subject_id: "id-1",
            change_kind: "changed",
            fields: ["label"],
            changed_at: "2027-06-01T12:00:00Z",
            actor_person_id: "p1",
            actor_name: "Carol Nguyen",
          },
        ]),
        okResponse([
          {
            subject_id: "id-250",
            change_kind: "added",
            fields: null,
            changed_at: "2027-06-01T12:01:00Z",
            actor_person_id: null,
            actor_name: null,
          },
        ]),
      ],
    });
    const result = await listChangesSince(db, "app.cues", ids(260), "2027-06-01T00:00:00Z");
    expect(calls).toHaveLength(2);
    expect(
      (calls[0]?.steps[0]?.[1] as [{ p_subject_ids: string[] }])[0].p_subject_ids,
    ).toHaveLength(200);
    expect(
      (calls[1]?.steps[0]?.[1] as [{ p_subject_ids: string[] }])[0].p_subject_ids,
    ).toHaveLength(60);
    expect(result.ok && result.data.get("id-1")).toEqual({
      subjectId: "id-1",
      kind: "changed",
      fields: ["label"],
      changedAt: "2027-06-01T12:00:00Z",
      actorId: "p1",
      actorName: "Carol Nguyen",
    });
    expect(result.ok && result.data.get("id-250")?.kind).toBe("added");
    expect(result.ok && result.data.get("id-250")?.fields).toEqual([]);
  });

  it("maps the refusals", async () => {
    const { db } = fakeClient({
      "rpc:changes_since": [
        errorResponse(
          "XR001",
          "field_history_unavailable: This kind of row has no field history.",
          "field_history_unavailable",
        ),
      ],
    });
    const result = await listChangesSince(db, "app.people", ["a"], "2027-06-01T00:00:00Z");
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "refusal",
        rule: "field_history_unavailable",
        message: "This kind of row has no field history.",
      },
    });
  });
});

describe("listTodayChanges", () => {
  it("maps records and shifts", async () => {
    const { db, calls } = fakeClient({
      "rpc:today_changes": [
        okResponse([
          {
            subject_table: "app.shifts",
            subject_id: "s1",
            subject_key: null,
            title: "Rigger (Northwind Summer Series)",
            project_key: "NWL",
            change_kind: "changed",
            fields: ["role_code"],
            changed_at: "2027-06-01T12:00:00Z",
            actor_person_id: "p1",
            actor_name: "Carol Nguyen",
          },
          {
            subject_table: "app.records",
            subject_id: "r1",
            subject_key: "NWL-42",
            title: "Hang the banners",
            project_key: "NWL",
            change_kind: "removed",
            fields: [],
            changed_at: "2027-06-01T11:00:00Z",
            actor_person_id: "p2",
            actor_name: "Dave Lindqvist",
          },
        ]),
      ],
    });
    const result = await listTodayChanges(db, "org-1", 10);
    expect(calls[0]?.steps[0]).toEqual(["args", [{ p_org_id: "org-1", p_limit: 10 }]]);
    expect(result.ok && result.data.map((c) => [c.table, c.key, c.kind])).toEqual([
      ["app.shifts", null, "changed"],
      ["app.records", "NWL-42", "removed"],
    ]);
  });
});

describe("communication", () => {
  it("sends 500 ids at a time and maps the status", async () => {
    const { db, calls } = fakeClient({
      "rpc:communication_status": [
        okResponse([
          {
            subject_id: "id-1",
            person_id: "p1",
            person_name: "Frank Ortiz",
            told_at: "2027-06-01T12:00:00Z",
            told_via: "notified",
            told_by_name: "Carol Nguyen",
            changed_at: "2027-06-01T12:05:00Z",
            changed_fields: ["role_code"],
            needs_review: true,
          },
        ]),
        okResponse([
          {
            subject_id: "id-600",
            person_id: null,
            person_name: null,
            told_at: null,
            told_via: null,
            told_by_name: null,
            changed_at: null,
            changed_fields: null,
            needs_review: false,
          },
        ]),
      ],
    });
    const result = await listCommunicationStatus(db, ids(620));
    expect(calls).toHaveLength(2);
    expect(
      (calls[0]?.steps[0]?.[1] as [{ p_subject_ids: string[] }])[0].p_subject_ids,
    ).toHaveLength(500);
    expect(result.ok && result.data.get("id-1")).toEqual({
      subjectId: "id-1",
      personId: "p1",
      personName: "Frank Ortiz",
      toldAt: "2027-06-01T12:00:00Z",
      toldVia: "notified",
      toldByName: "Carol Nguyen",
      changedAt: "2027-06-01T12:05:00Z",
      changedFields: ["role_code"],
      needsReview: true,
    });
    expect(result.ok && result.data.get("id-600")?.changedFields).toEqual([]);
  });

  it("asks for nothing without ids", async () => {
    const { db, calls } = fakeClient({});
    const result = await listCommunicationStatus(db, []);
    expect(result.ok && result.data.size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("marks as communicated with a trimmed note, and maps the refusals", async () => {
    const { db, calls } = fakeClient({
      "rpc:mark_communicated": [
        okResponse(2),
        errorResponse(
          "XR001",
          "communication_no_assignee: Only a live shift with a person on it can be marked as communicated.",
          "communication_no_assignee",
        ),
        errorResponse(
          "XR001",
          "communication_too_many: Mark at most 500 rows as communicated at a time.",
          "communication_too_many",
        ),
        errorResponse("42501", "a row is not available to you"),
      ],
    });
    expect(await markCommunicated(db, ["a", "b", "a"], "  Called both.  ")).toEqual({
      ok: true,
      data: 2,
    });
    expect(calls[0]?.steps[0]).toEqual([
      "args",
      [{ p_subject_table: "app.shifts", p_subject_ids: ["a", "b"], p_note: "Called both." }],
    ]);
    const open = await markCommunicated(db, ["c"]);
    expect(!open.ok && open.error.kind === "refusal" && open.error.rule).toBe(
      "communication_no_assignee",
    );
    const many = await markCommunicated(db, ids(501));
    expect(!many.ok && many.error.kind === "refusal" && many.error.rule).toBe(
      "communication_too_many",
    );
    const denied = await markCommunicated(db, ["d"]);
    expect(!denied.ok && denied.error.kind).toBe("not-found");
    expect(calls[1]?.steps[0]).toEqual([
      "args",
      [{ p_subject_table: "app.shifts", p_subject_ids: ["c"] }],
    ]);
  });
});
