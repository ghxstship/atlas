import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import {
  audienceForRoleType,
  externalAudience,
  IdentityError,
  internalAudience,
  resolveIdentity,
  scopeFor,
} from "../src/data/identity";
import type { EngagementSummary } from "../src/domain/access";

const eng = (over: Partial<EngagementSummary>): EngagementSummary => ({
  id: "e1",
  orgId: "o1",
  orgName: "Demo Org",
  projectId: "p1",
  projectName: "Fest",
  roleType: "crew",
  state: "Active",
  ...over,
});

describe("audience", () => {
  it("maps role types and supervisor capabilities", () => {
    expect(audienceForRoleType("Artist Representative")).toBe("artist-representative");
    expect(audienceForRoleType("Unknown")).toBeNull();
    expect(internalAudience(["crew.time_entry.write"])).toBe("field");
    expect(internalAudience(["crew.timesheet.approve"])).toBe("field-supervisor");
  });

  it("picks the external audience from the current project's open engagement", () => {
    const list = [
      eng({ id: "a", projectId: "p1", roleType: "vendor", state: "Complete" }),
      eng({ id: "b", projectId: "p2", roleType: "crew" }),
    ];
    expect(externalAudience(list, "p2")).toBe("crew");
    expect(externalAudience(list, "p1")).toBe("crew");
    expect(externalAudience([eng({ state: "Onboarding", roleType: "artist" })], null)).toBe(
      "artist",
    );
    expect(externalAudience([], null)).toBeNull();
  });

  it("scopes externals to open engagements only", () => {
    const identity = {
      personId: "x",
      displayName: "X",
      audience: "crew" as const,
      capabilities: [],
      membershipId: null,
      engagements: [eng({}), eng({ id: "e2", projectId: "p9", state: "Complete" })],
    };
    expect(scopeFor(identity, [], [])).toEqual({
      audience: "crew",
      personIds: ["x"],
      orgIds: [],
      membershipIds: [],
      readableProjectIds: [],
      engagementIds: ["e1"],
      engagedProjectIds: ["p1"],
    });
  });
});

/** Serves fixed query results by "schema.table" in call order. */
function fake(results: Record<string, { data: unknown; error: { message: string } | null }>) {
  const builder = (key: string) => {
    const q = {
      select: () => q,
      eq: () => q,
      is: () => q,
      in: () => q,
      order: () => q,
      maybeSingle: () => Promise.resolve(results[key] ?? { data: null, error: null }),
      then: (resolve: (v: unknown) => void) => resolve(results[key] ?? { data: [], error: null }),
    };
    return q;
  };
  return {
    from: (t: string) => builder(`app.${t}`),
    rpc: (fn: string) => Promise.resolve(results[`rpc.${fn}`] ?? { data: [], error: null }),
    schema: (s: string) => ({ from: (t: string) => builder(`${s}.${t}`) }),
  } as unknown as SupabaseClient;
}

describe("resolveIdentity", () => {
  it("resolves an internal field supervisor with capabilities and projects", async () => {
    const r = await resolveIdentity(
      fake({
        "app.people": { data: { id: "person-1", full_name: "Demo Field Lead" }, error: null },
        "app.memberships": { data: [{ id: "m1", org_id: "o1" }], error: null },
        "app.membership_roles": { data: [{ role_id: "r1" }], error: null },
        "app.role_capabilities": {
          data: [
            { capability_code: "safety.incident.dispatch" },
            { capability_code: "crew.time_entry.write" },
          ],
          error: null,
        },
        "app.projects": { data: [{ id: "p1", name: "Fest" }], error: null },
      }),
      "user-1",
    );
    expect(r.identity).toMatchObject({
      audience: "field-supervisor",
      membershipId: "m1",
      capabilities: ["crew.time_entry.write", "safety.incident.dispatch"],
    });
    expect(r.scope).toMatchObject({
      membershipIds: ["m1"],
      readableProjectIds: ["p1"],
      orgIds: ["o1"],
    });
    expect(r.orgId).toBe("o1");
  });

  it("reads a Field member as field, and as field-supervisor once a project role adds dispatch", async () => {
    const base = {
      "app.people": { data: { id: "person-2", full_name: "Demo Field Tech" }, error: null },
      "app.memberships": { data: [{ id: "m2", org_id: "o1" }], error: null },
      "app.membership_roles": { data: [{ role_id: "field" }], error: null },
      "app.role_capabilities": {
        data: [
          { capability_code: "crew.time_entry.write" },
          { capability_code: "safety.incident.write" },
        ],
        error: null,
      },
      "app.projects": { data: [{ id: "p1", name: "Fest" }], error: null },
    };
    const field = await resolveIdentity(fake(base), "user-2");
    expect(field.identity.audience).toBe("field");
    expect(field.identity.capabilities).not.toContain("safety.incident.dispatch");
    const supervisor = await resolveIdentity(
      fake({
        ...base,
        "rpc.my_project_role_capabilities": {
          data: [
            {
              project_id: "p1",
              project_role: "Field Supervisor",
              capability_code: "safety.incident.dispatch",
            },
          ],
          error: null,
        },
      }),
      "user-2",
    );
    expect(supervisor.identity.audience).toBe("field-supervisor");
    expect(supervisor.identity.capabilities).toContain("safety.incident.dispatch");
  });

  it("names the capabilities step when the project role read fails", async () => {
    await expect(
      resolveIdentity(
        fake({
          "app.people": { data: { id: "person-2", full_name: "Demo Field Tech" }, error: null },
          "app.memberships": { data: [{ id: "m2", org_id: "o1" }], error: null },
          "app.membership_roles": { data: [], error: null },
          "rpc.my_project_role_capabilities": { data: null, error: { message: "boom" } },
        }),
        "user-2",
      ),
    ).rejects.toMatchObject({ step: "capabilities" });
  });

  it("resolves an external crew member from api_external engagements", async () => {
    const r = await resolveIdentity(
      fake({
        "app.people": { data: { id: "person-x", full_name: "Demo Crew Member" }, error: null },
        "app.memberships": { data: [], error: null },
        "api_external.engagements": {
          data: [
            {
              id: "e1",
              org_id: "o1",
              org_name: "Demo Org",
              project_id: "p1",
              project_name: "Fest",
              role_type: "Crew",
              engagement_state: "Active",
            },
            { id: "e2", role_type: "Mystery" },
          ],
          error: null,
        },
      }),
      "user-x",
    );
    expect(r.identity).toMatchObject({ audience: "crew", membershipId: null });
    expect(r.projects).toEqual([{ id: "p1", name: "Fest" }]);
    expect(r.scope.engagementIds).toEqual(["e1"]);
  });

  it("names the failing step", async () => {
    await expect(
      resolveIdentity(fake({ "app.people": { data: null, error: null } }), "u"),
    ).rejects.toThrow(IdentityError);
    await expect(
      resolveIdentity(
        fake({ "app.people": { data: null, error: { message: "jwt expired" } } }),
        "u",
      ),
    ).rejects.toMatchObject({ step: "person" });
    await expect(
      resolveIdentity(
        fake({
          "app.people": { data: { id: "p", full_name: null }, error: null },
          "app.memberships": { data: [], error: null },
          "api_external.engagements": { data: [], error: null },
        }),
        "u",
      ),
    ).rejects.toMatchObject({ step: "engagements" });
  });
});
