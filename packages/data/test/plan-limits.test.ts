import { describe, expect, it } from "vitest";
import {
  choosePlanLimitKeeps,
  getPlanLimitUsage,
  getProjectOverLimit,
  listPlanLimitCandidates,
  toCandidate,
} from "../src/plan-limits.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

/** A107 (migrations 1720 and 1721): the plan limit repository maps rows and refusals faithfully. */

describe("usage", () => {
  it("maps each object limit and drops any other", async () => {
    const { db, calls } = fakeClient({
      "rpc:plan_limit_usage": [
        okResponse([
          {
            limit_code: "active_projects",
            plan_code: "access",
            limit_value: 1,
            in_use: 3,
            read_only: 2,
          },
          {
            limit_code: "seats",
            plan_code: "access",
            limit_value: "1",
            in_use: "3",
            read_only: "2",
          },
          {
            limit_code: "field_members",
            plan_code: "access",
            limit_value: null,
            in_use: 0,
            read_only: 0,
          },
          {
            limit_code: "aurora_requests_per_month",
            plan_code: "access",
            limit_value: 0,
            in_use: 0,
            read_only: 0,
          },
        ]),
      ],
    });
    expect(await getPlanLimitUsage(db, "org-1")).toEqual({
      ok: true,
      data: [
        { limit: "active_projects", planCode: "access", limitValue: 1, inUse: 3, readOnly: 2 },
        { limit: "seats", planCode: "access", limitValue: 1, inUse: 3, readOnly: 2 },
        { limit: "field_members", planCode: "access", limitValue: null, inUse: 0, readOnly: 0 },
      ],
    });
    expect(calls[0]?.steps[0]).toEqual(["args", [{ p_org_id: "org-1" }]]);
  });

  it("returns not-found for someone outside the org", async () => {
    const { db } = fakeClient({ "rpc:plan_limit_usage": [errorResponse("42501", "denied")] });
    expect(await getPlanLimitUsage(db, "org-1")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
  });
});

describe("candidates", () => {
  it("maps projects and members in the order the database ranks them", async () => {
    const { db, calls } = fakeClient({
      "rpc:plan_limit_candidates": [
        okResponse([
          {
            project_id: null,
            membership_id: "m-owner",
            label: "Nina Halvorsen",
            project_key: null,
            role_code: "owner",
            role_name: null,
            created_at: "2026-10-01T00:00:00Z",
            chosen: false,
            locked: true,
            read_only: false,
          },
          {
            project_id: null,
            membership_id: "m-2",
            label: null,
            project_key: null,
            role_code: null,
            role_name: "Rigging Lead",
            created_at: "2026-10-02T00:00:00Z",
            chosen: true,
            locked: false,
            read_only: true,
          },
        ]),
      ],
    });
    const result = await listPlanLimitCandidates(db, "org-1", "seats");
    expect(result.ok && result.data.map((c) => [c.id, c.locked, c.chosen, c.readOnly])).toEqual([
      ["m-owner", true, false, false],
      ["m-2", false, true, true],
    ]);
    expect(result.ok && result.data[1]).toMatchObject({ label: null, roleName: "Rigging Lead" });
    expect(calls[0]?.steps[0]).toEqual(["args", [{ p_org_id: "org-1", p_limit: "seats" }]]);
  });

  it("takes the project's id for a project", () => {
    expect(
      toCandidate({
        project_id: "p-1",
        membership_id: null,
        label: "Lantern Spring Tour",
        project_key: "LRA",
        created_at: "2026-10-01T00:00:00Z",
        chosen: false,
        locked: false,
        read_only: false,
      }),
    ).toMatchObject({ id: "p-1", projectKey: "LRA", roleCode: null });
  });
});

describe("the Owner's choice", () => {
  it("sends the ids kept and returns how many stay read-only", async () => {
    const { db, calls } = fakeClient({ "rpc:choose_plan_limit_keeps": [okResponse(2)] });
    expect(await choosePlanLimitKeeps(db, "org-1", "active_projects", ["p-3"])).toEqual({
      ok: true,
      data: 2,
    });
    expect(calls[0]?.steps[0]).toEqual([
      "args",
      [{ p_org_id: "org-1", p_limit: "active_projects", p_keep: ["p-3"] }],
    ]);
  });

  it("passes a refusal through with its rule", async () => {
    const { db } = fakeClient({
      "rpc:choose_plan_limit_keeps": [
        errorResponse(
          "XR001",
          "plan_limit_choice_too_many: choose at most 1.",
          "plan_limit_choice_too_many",
        ),
      ],
    });
    const result = await choosePlanLimitKeeps(db, "org-1", "active_projects", ["p-1", "p-3"]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatchObject({
      kind: "refusal",
      rule: "plan_limit_choice_too_many",
    });
  });
});

describe("a read-only project", () => {
  it("names the plan and when it turned read-only", async () => {
    const { db, calls } = fakeClient({
      "from:over_limit_objects": [
        okResponse({ plan_code: "access", created_at: "2026-10-23T05:00:00Z" }),
      ],
    });
    expect(await getProjectOverLimit(db, "p-2")).toEqual({
      ok: true,
      data: { planCode: "access", since: "2026-10-23T05:00:00Z" },
    });
    expect(calls[0]?.steps).toContainEqual(["eq", ["project_id", "p-2"]]);
  });

  it("is null for a writable project", async () => {
    const { db } = fakeClient({ "from:over_limit_objects": [okResponse(null)] });
    expect(await getProjectOverLimit(db, "p-1")).toEqual({ ok: true, data: null });
  });
});
