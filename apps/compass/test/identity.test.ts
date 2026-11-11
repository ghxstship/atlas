import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import {
  audienceForRoleType,
  engagementAudience,
  engagementSummaries,
  externalAudience,
  IdentityError,
  identityOutcome,
  internalAudience,
  NoAccessYet,
  representedArtists,
  resolveIdentity,
  scopeFor,
} from "../src/data/identity";
import { moreMenu, type EngagementSummary } from "../src/domain/access";

const eng = (over: Partial<EngagementSummary>): EngagementSummary => ({
  id: "e1",
  orgId: "o1",
  orgName: "Demo Org",
  projectId: "p1",
  projectName: "Fest",
  roleType: "crew",
  state: "Active",
  via: "engagement",
  rosterEntryId: null,
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
      // The onboarding checklist reads before operational access opens, never after Complete (A92).
      onboardingEngagementIds: ["e1"],
      rosterEntryIds: [],
      // An engaged context is no member of the org, so orgIds stays empty; B9's break types scope here instead.
      engagedOrgIds: ["o1"],
    });
    const onboarding = { ...identity, engagements: [eng({ id: "e3", state: "Onboarding" })] };
    expect(scopeFor(onboarding, [], [])).toMatchObject({
      engagementIds: [],
      onboardingEngagementIds: ["e3"],
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
        "app.membership_roles": { data: [{ membership_id: "m1", role_id: "r1" }], error: null },
        "app.role_capabilities": {
          data: [
            { role_id: "r1", capability_code: "safety.incident.dispatch" },
            { role_id: "r1", capability_code: "crew.time_entry.write" },
          ],
          error: null,
        },
        "app.projects": { data: [{ id: "p1", name: "Fest", org_id: "o1" }], error: null },
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
      "app.membership_roles": { data: [{ membership_id: "m2", role_id: "field" }], error: null },
      "app.role_capabilities": {
        data: [
          { role_id: "field", capability_code: "crew.time_entry.write" },
          { role_id: "field", capability_code: "safety.incident.write" },
        ],
        error: null,
      },
      "app.projects": { data: [{ id: "p1", name: "Fest", org_id: "o1" }], error: null },
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

  it("resolves an artist's agent as the Artist Representative, never the Artist (C-10)", async () => {
    const artistEngagement = {
      org_id: "o1",
      org_name: "Demo Northwind",
      project_id: "p1",
      project_name: "Summer Series",
      role_type: "Artist",
      // The artist holds the engagement; the agent reaches it through app.representations.
      person_id: "person-artist",
      engagement_state: "Active",
    };
    const r = await resolveIdentity(
      fake({
        "app.people": { data: { id: "person-agent", full_name: "Demo Artist Agent" }, error: null },
        "app.memberships": { data: [], error: null },
        "api_external.engagements": {
          data: [
            { ...artistEngagement, id: "e-a1" },
            { ...artistEngagement, id: "e-a2", project_id: "p2", project_name: "Winter Series" },
          ],
          error: null,
        },
        "api_external.representations": {
          data: [
            {
              artist_person_id: "person-artist",
              expires_on: "2999-12-31",
              accepted_at: "2026-01-02T00:00:00Z",
              revoked_at: null,
            },
          ],
          error: null,
        },
      }),
      "user-agent",
    );
    expect(r.identity.audience).toBe("artist-representative");
    expect(r.identity.engagements.map((e) => e.roleType)).toEqual([
      "artist-representative",
      "artist-representative",
    ]);
    expect(r.scope.audience).toBe("artist-representative");
    expect(r.scope.engagementIds).toEqual(["e-a1", "e-a2"]);
    // The representative's More menu, which the sitemap gives no Project Details.
    expect(moreMenu(r.identity.audience).map((m) => m.id)).not.toContain("project-details");
    expect(moreMenu("artist").map((m) => m.id)).toContain("project-details");
  });

  it("keeps the artist's own engagement, and one no person holds, as the Artist", () => {
    const row = {
      id: "e1",
      org_id: "o1",
      org_name: "Demo Org",
      project_id: "p1",
      project_name: "Fest",
      role_type: "Artist",
      engagement_state: "Active",
    };
    expect(
      engagementSummaries([{ ...row, person_id: "me" }], [], "me").map((e) => e.roleType),
    ).toEqual(["artist"]);
    expect(
      engagementSummaries([{ ...row, person_id: null }], [], "me").map((e) => e.roleType),
    ).toEqual(["artist"]);
    expect(engagementAudience("Artist", "someone", "me", new Set(["someone"]))).toBe(
      "artist-representative",
    );
    // Only an artist's engagement has a representative: a crew engagement of the person's company stays crew.
    expect(engagementAudience("Crew", "someone", "me")).toBe("crew");
    expect(engagementAudience("Mystery", null, "me")).toBeNull();
  });

  it("keeps an assigned member or account admin on an artist's engagement the Artist, without a representation", async () => {
    // private.engagement_party_areas opens an Artist engagement to the account's Owner, Admin and Finance members and
    // to the people assigned to it, such as a band member; none of them represents the artist.
    const r = await resolveIdentity(
      fake({
        "app.people": { data: { id: "person-band", full_name: "Demo Band Member" }, error: null },
        "app.memberships": { data: [], error: null },
        "api_external.engagements": {
          data: [
            {
              id: "e-a1",
              org_id: "o1",
              org_name: "Demo Northwind",
              project_id: "p1",
              project_name: "Summer Series",
              role_type: "Artist",
              person_id: "person-artist",
              engagement_state: "Active",
            },
          ],
          error: null,
        },
        "api_external.representations": { data: [], error: null },
      }),
      "user-band",
    );
    expect(r.identity.audience).toBe("artist");
    expect(moreMenu(r.identity.audience).map((m) => m.id)).toContain("project-details");
    expect(engagementAudience("Artist", "someone", "me")).toBe("artist");
    expect(engagementAudience("Artist", "someone", "me", new Set(["another"]))).toBe("artist");
  });

  it("reads only an accepted, unrevoked and unexpired representation as live", () => {
    const row = {
      artist_person_id: "a1",
      expires_on: "2026-11-10",
      accepted_at: "2026-01-01T00:00:00Z",
      revoked_at: null,
    };
    const live = (over: Record<string, unknown>) => [
      ...representedArtists([{ ...row, ...over }], "2026-11-10"),
    ];
    expect(live({})).toEqual(["a1"]);
    expect(live({ accepted_at: null })).toEqual([]);
    expect(live({ revoked_at: "2026-02-01T00:00:00Z" })).toEqual([]);
    expect(live({ expires_on: "2026-11-09" })).toEqual([]);
  });

  it("resolves a person who works only on a party's roster as crew, with their entry in scope (R8)", async () => {
    const r = await resolveIdentity(
      fake({
        "app.people": { data: { id: "person-k", full_name: "Kai Morgan" }, error: null },
        "app.memberships": { data: [], error: null },
        "api_external.engagements": { data: [], error: null },
        "api_external.my_roster_engagements": {
          data: [
            {
              id: "e-vendor",
              org_id: "o1",
              org_name: "Northwind Live",
              project_id: "p1",
              project_name: "Summer Series",
              role_type: "Vendor",
              engagement_state: "Active",
              roster_entry_id: "r1",
              lead_name: "Pia Larsen",
            },
          ],
          error: null,
        },
      }),
      "user-k",
    );
    expect(r.identity.audience).toBe("crew");
    expect(r.identity.engagements[0]).toMatchObject({
      via: "roster",
      rosterEntryId: "r1",
      leadName: "Pia Larsen",
      roleType: "crew",
    });
    // The party's engagement is not the person's own: they sync their entry and its project.
    expect(r.scope.engagementIds).toEqual([]);
    expect(r.scope.onboardingEngagementIds).toEqual([]);
    expect(r.scope.rosterEntryIds).toEqual(["r1"]);
    expect(r.scope.engagedProjectIds).toEqual(["p1"]);
  });

  it("keeps the person's own engagement once when it also reads through the roster", () => {
    const row = {
      id: "e1",
      org_id: "o1",
      org_name: "Demo Org",
      project_id: "p1",
      project_name: "Fest",
      role_type: "Crew",
      engagement_state: "Active",
    };
    const summaries = engagementSummaries(
      [row],
      [
        { ...row, roster_entry_id: "r1" },
        { ...row, id: "e2" },
      ],
    );
    expect(summaries.map((e) => `${e.id}:${e.via}`)).toEqual(["e1:engagement"]);
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
          "api_external.engagements": { data: null, error: { message: "permission denied" } },
        }),
        "u",
      ),
    ).rejects.toMatchObject({ step: "engagements" });
  });

  it("reads a sign-in with no membership and no engagement as nothing open yet, not a failure (C-12)", async () => {
    const empty = resolveIdentity(
      fake({
        "app.people": { data: { id: "p", full_name: null }, error: null },
        "app.memberships": { data: [], error: null },
        "api_external.engagements": { data: [], error: null },
        "api_external.my_roster_engagements": { data: [], error: null },
      }),
      "u",
    );
    await expect(empty).rejects.toBeInstanceOf(NoAccessYet);
    const error = await empty.catch((e: unknown) => e);
    expect(identityOutcome(error)).toEqual({ kind: "no-access" });
  });

  it("reads a failed roster read as a failure naming its step, never as nothing open yet", async () => {
    const failed = resolveIdentity(
      fake({
        "app.people": { data: { id: "p", full_name: null }, error: null },
        "app.memberships": { data: [], error: null },
        "api_external.engagements": { data: [], error: null },
        "api_external.my_roster_engagements": {
          data: null,
          error: { message: "permission denied for view my_roster_engagements" },
        },
      }),
      "u",
    );
    const error = await failed.catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(NoAccessYet);
    expect(identityOutcome(error)).toEqual({
      kind: "identity-failed",
      step: "engagements",
      message: "permission denied for view my_roster_engagements",
    });
  });

  it("keeps every other identity error a failure that names its step", () => {
    expect(identityOutcome(new IdentityError("roles", "permission denied"))).toEqual({
      kind: "identity-failed",
      step: "roles",
      message: "permission denied",
    });
    expect(identityOutcome(new Error("boom"))).toEqual({
      kind: "identity-failed",
      step: "access",
      message: "boom",
    });
    expect(identityOutcome("odd")).toEqual({
      kind: "identity-failed",
      step: "access",
      message: "odd",
    });
  });
});
