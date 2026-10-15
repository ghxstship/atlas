import { describe, expect, it } from "vitest";
import {
  acceptInvite,
  createOrganization,
  endMembership,
  getCurrentPerson,
  getMyOrganization,
  getSubscription,
  hasClientOrganizations,
  inviteMember,
  isOrgSlug,
  leaveOrganization,
  listMembers,
  listMyOrganizations,
  listPendingInvites,
  listRoleCapabilities,
  listRoles,
  listWorkspaces,
  previewInvite,
  renameOrganization,
  revokeInvite,
  setMemberRole,
  slugFromName,
  systemRoleForBand,
  updateMyName,
} from "../src/identity.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

const NOW = new Date("2026-10-09T12:00:00.000Z");
const owner = { id: "r1", code: "owner", name: null, band: 1, org_id: null };
const viewer = { id: "r7", code: "viewer", name: null, band: 7, org_id: null };
const custom = { id: "rc", code: "lead", name: "Lead", band: 3, org_id: "o1" };
const orgRow = { id: "o1", slug: "acme", name: "Acme", parent_org_id: null, deleted_at: null };

describe("roles", () => {
  it("maps bands to system roles", () => {
    expect(systemRoleForBand(1)).toBe("owner");
    expect(systemRoleForBand(7)).toBe("viewer");
    expect(systemRoleForBand(9)).toBeNull();
  });

  it("lists system and custom roles in band order", async () => {
    const { db, calls } = fakeClient({ "from:roles": [okResponse([viewer, custom, owner])] });
    const result = await listRoles(db, "o1");
    expect(result.ok && result.data.map((r) => r.code)).toEqual(["owner", "lead", "viewer"]);
    expect(result.ok && result.data[1]?.system).toBe(false);
    expect(calls[0]?.steps).toContainEqual(["or", ["org_id.is.null,org_id.eq.o1"]]);
  });

  it("returns errors from role reads", async () => {
    const { db } = fakeClient({ "from:roles": [errorResponse("42501", "denied")] });
    expect(await listRoles(db, "o1")).toEqual({ ok: false, error: { kind: "not-found" } });
  });
});

describe("people", () => {
  it("reads the signed-in person", async () => {
    const { db } = fakeClient({
      "from:people": [okResponse({ id: "p1", full_name: "Ada" }), okResponse(null)],
    });
    expect(await getCurrentPerson(db, "u1")).toEqual({
      ok: true,
      data: { id: "p1", fullName: "Ada" },
    });
    expect(await getCurrentPerson(db, "u2")).toEqual({ ok: false, error: { kind: "not-found" } });
  });

  it("surfaces read failures", async () => {
    const { db } = fakeClient({ "from:people": [errorResponse("08006", "down")] });
    const result = await getCurrentPerson(db, "u1");
    expect(result.ok).toBe(false);
  });

  it("trims a new name", async () => {
    const { db, calls } = fakeClient({
      "from:people": [okResponse(null), errorResponse("23514", "length")],
    });
    expect((await updateMyName(db, "p1", "  Ada  ")).ok).toBe(true);
    expect(calls[0]?.steps[0]).toEqual(["update", [{ full_name: "Ada" }]]);
    expect(await updateMyName(db, "p1", "")).toEqual({
      ok: false,
      error: { kind: "invalid", message: "length" },
    });
  });
});

describe("organizations", () => {
  it("creates an org through the RPC", async () => {
    const { db, calls } = fakeClient({ "rpc:create_organization": [okResponse("o1")] });
    expect(await createOrganization(db, { name: "Acme", slug: "acme" })).toEqual({
      ok: true,
      data: { orgId: "o1" },
    });
    expect(calls[0]?.steps[0]).toEqual(["args", [{ p_name: "Acme", p_slug: "acme" }]]);
  });

  it("returns a slug refusal", async () => {
    const { db } = fakeClient({
      "rpc:create_organization": [
        errorResponse("XR001", "slug_taken: acme is already in use.", "slug_taken"),
      ],
    });
    expect(await createOrganization(db, { name: "Acme", slug: "acme" })).toEqual({
      ok: false,
      error: { kind: "refusal", rule: "slug_taken", message: "acme is already in use." },
    });
  });

  it("lists my organizations with roles, skipping ended role assignments", async () => {
    const { db, calls } = fakeClient({
      "from:memberships": [
        okResponse([
          {
            id: "m2",
            organization: { ...orgRow, id: "o2", slug: "zed", name: "Zed" },
            membership_roles: [{ deleted_at: null, role: viewer }],
          },
          {
            id: "m1",
            organization: orgRow,
            membership_roles: [
              { deleted_at: null, role: owner },
              { deleted_at: "2026-01-01", role: viewer },
              { deleted_at: null, role: null },
            ],
          },
        ]),
      ],
    });
    const result = await listMyOrganizations(db, "p1", NOW);
    expect(result.ok && result.data.map((o) => [o.slug, o.bestBand])).toEqual([
      ["acme", 1],
      ["zed", 7],
    ]);
    expect(calls[0]?.steps).toContainEqual([
      "or",
      ["valid_to.is.null,valid_to.gt.2026-10-09T12:00:00.000Z"],
    ]);
  });

  it("reads one org context by slug or answers not-found", async () => {
    const { db } = fakeClient({
      "from:memberships": [
        okResponse({ id: "m1", organization: orgRow, membership_roles: [] }),
        okResponse(null),
        errorResponse("08006", "down"),
      ],
    });
    const found = await getMyOrganization(db, "p1", "acme", NOW);
    expect(found.ok && found.data).toMatchObject({ id: "o1", bestBand: null, membershipId: "m1" });
    expect(await getMyOrganization(db, "p1", "nope", NOW)).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect((await getMyOrganization(db, "p1", "acme", NOW)).ok).toBe(false);
  });

  it("surfaces list failures", async () => {
    const { db } = fakeClient({ "from:memberships": [errorResponse("08006", "down")] });
    expect((await listMyOrganizations(db, "p1")).ok).toBe(false);
  });

  it("renames an org it may edit, and answers not-found otherwise", async () => {
    const { db } = fakeClient({
      "from:organizations": [
        okResponse([{ id: "o1" }]),
        okResponse([]),
        errorResponse("23514", "length"),
      ],
    });
    expect((await renameOrganization(db, "o1", "New")).ok).toBe(true);
    expect(await renameOrganization(db, "o1", "New")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect((await renameOrganization(db, "o1", "")).ok).toBe(false);
  });

  it("checks and suggests slugs", () => {
    expect(isOrgSlug("acme-live")).toBe(true);
    expect(isOrgSlug("Acme")).toBe(false);
    expect(isOrgSlug("a")).toBe(false);
    expect(slugFromName("Ñandú Producciones, S.A.")).toBe("nandu-producciones-s-a");
    expect(slugFromName("!")).toBe("");
    expect(slugFromName("x".repeat(60)).length).toBe(48);
  });
});

describe("capabilities", () => {
  it("keeps the widest reach per capability", async () => {
    const { db } = fakeClient({
      "from:role_capabilities": [
        okResponse([
          { capability_code: "org.members.invite", reach: "assigned" },
          { capability_code: "org.members.invite", reach: "organization" },
          { capability_code: "org.members.invite", reach: "own" },
        ]),
      ],
    });
    const result = await listRoleCapabilities(db, ["r1"]);
    expect(result.ok && result.data.get("org.members.invite")).toBe("organization");
  });

  it("needs no query without roles and surfaces failures", async () => {
    const { db } = fakeClient({ "from:role_capabilities": [errorResponse("08006", "down")] });
    expect((await listRoleCapabilities(db, [])).ok).toBe(true);
    expect((await listRoleCapabilities(db, ["r1"])).ok).toBe(false);
  });
});

describe("members", () => {
  it("lists members by band, then name", async () => {
    const { db } = fakeClient({
      "from:memberships": [
        okResponse([
          {
            id: "m3",
            person_id: "p3",
            valid_from: "x",
            person: null,
            membership_roles: [],
          },
          {
            id: "m2",
            person_id: "p2",
            valid_from: "x",
            person: { full_name: "Zoe" },
            membership_roles: [{ deleted_at: null, role: viewer }],
          },
          {
            id: "m1",
            person_id: "p1",
            valid_from: "x",
            person: { full_name: "Ada" },
            membership_roles: [{ deleted_at: null, role: owner }],
          },
        ]),
        errorResponse("08006", "down"),
      ],
    });
    const result = await listMembers(db, "o1", NOW);
    expect(result.ok && result.data.map((m) => m.membershipId)).toEqual(["m1", "m2", "m3"]);
    expect((await listMembers(db, "o1")).ok).toBe(false);
  });

  it("grants the new role before ending the old ones", async () => {
    const { db, calls } = fakeClient({
      "from:membership_roles": [
        okResponse([{ id: "mr1", role_id: "r7" }]),
        okResponse(null),
        okResponse(null),
      ],
    });
    expect((await setMemberRole(db, { membershipId: "m1", roleId: "r3" })).ok).toBe(true);
    expect(calls.map((c) => c.steps[0]?.[0])).toEqual(["select", "insert", "update"]);
  });

  it("skips the insert when the role is already held and nothing is stale", async () => {
    const { db, calls } = fakeClient({
      "from:membership_roles": [okResponse([{ id: "mr1", role_id: "r3" }])],
    });
    expect((await setMemberRole(db, { membershipId: "m1", roleId: "r3" })).ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("stops at the first failing step", async () => {
    const read = fakeClient({ "from:membership_roles": [errorResponse("42501", "no")] });
    expect((await setMemberRole(read.db, { membershipId: "m1", roleId: "r3" })).ok).toBe(false);
    const insert = fakeClient({
      "from:membership_roles": [
        okResponse([]),
        errorResponse("XR001", "sod_self_grant: no", "sod_self_grant"),
      ],
    });
    expect(await setMemberRole(insert.db, { membershipId: "m1", roleId: "r3" })).toMatchObject({
      ok: false,
      error: { rule: "sod_self_grant" },
    });
    const end = fakeClient({
      "from:membership_roles": [
        okResponse([{ id: "mr1", role_id: "r1" }]),
        okResponse(null),
        errorResponse("XR001", "last_owner: keep one", "last_owner"),
      ],
    });
    expect(await setMemberRole(end.db, { membershipId: "m1", roleId: "r3" })).toMatchObject({
      ok: false,
      error: { rule: "last_owner" },
    });
  });

  it("ends memberships and leaves orgs through the RPCs", async () => {
    const { db } = fakeClient({
      "rpc:end_membership": [
        okResponse(null),
        errorResponse("XR001", "not_member: x", "not_member"),
      ],
      "rpc:leave_organization": [okResponse(null)],
    });
    expect((await endMembership(db, "m1")).ok).toBe(true);
    expect((await endMembership(db, "m1")).ok).toBe(false);
    expect((await leaveOrganization(db, "o1")).ok).toBe(true);
  });
});

describe("invitations", () => {
  it("invites with the default 14 day expiry and returns the token once", async () => {
    const { db, calls } = fakeClient({
      "rpc:invite_member": [
        okResponse([{ invite_id: "i1", invite_token: "xinv_abc" }]),
        okResponse([]),
        errorResponse("XR001", "role_band: no", "role_band"),
      ],
    });
    expect(await inviteMember(db, { orgId: "o1", email: "a@b.co", roleId: "r4" })).toEqual({
      ok: true,
      data: { inviteId: "i1", token: "xinv_abc" },
    });
    expect(calls[0]?.steps[0]?.[1]).toEqual([
      { p_org_id: "o1", p_email: "a@b.co", p_role_id: "r4", p_valid_for: "336 hours" },
    ]);
    expect(
      (await inviteMember(db, { orgId: "o1", email: "a@b.co", roleId: "r4", validForHours: 2 })).ok,
    ).toBe(false);
    expect(await inviteMember(db, { orgId: "o1", email: "a@b.co", roleId: "r1" })).toMatchObject({
      ok: false,
      error: { kind: "refusal", rule: "role_band" },
    });
  });

  it("lists and revokes pending invites", async () => {
    const { db } = fakeClient({
      "from:invites": [
        okResponse([
          { id: "i1", email: "a@b.co", role_id: "r4", expires_at: "e", created_at: "c" },
        ]),
        errorResponse("08006", "down"),
        okResponse([{ id: "i1" }]),
        okResponse([]),
        errorResponse("42501", "no"),
      ],
    });
    const listed = await listPendingInvites(db, "o1", NOW);
    expect(listed.ok && listed.data[0]).toEqual({
      id: "i1",
      email: "a@b.co",
      roleId: "r4",
      expiresAt: "e",
      createdAt: "c",
    });
    expect((await listPendingInvites(db, "o1")).ok).toBe(false);
    expect((await revokeInvite(db, "i1")).ok).toBe(true);
    expect((await revokeInvite(db, "i1")).ok).toBe(false);
    expect((await revokeInvite(db, "i1")).ok).toBe(false);
  });

  it("previews an invite or returns its refusal", async () => {
    const { db } = fakeClient({
      "rpc:preview_invite": [
        okResponse([
          {
            org_name: "Acme",
            role_code: "member",
            role_name: null,
            expires_at: "e",
            refusal: null,
            reason: null,
          },
        ]),
        okResponse([{ refusal: "REFUSE", reason: "invite_invalid" }]),
        okResponse([]),
        errorResponse("42501", "no"),
      ],
    });
    expect(await previewInvite(db, "t")).toEqual({
      ok: true,
      data: { orgName: "Acme", roleCode: "member", roleName: null, expiresAt: "e" },
    });
    expect(await previewInvite(db, "t")).toMatchObject({
      ok: false,
      error: { rule: "invite_invalid" },
    });
    expect(await previewInvite(db, "t")).toEqual({ ok: false, error: { kind: "not-found" } });
    expect((await previewInvite(db, "t")).ok).toBe(false);
  });

  it("accepts an invite or returns its refusal", async () => {
    const { db } = fakeClient({
      "rpc:accept_invite": [
        okResponse([{ membership_id: "m9", refusal: null, reason: null }]),
        okResponse([{ membership_id: null, refusal: "REFUSE", reason: "invite_inviter_inactive" }]),
        okResponse([]),
        errorResponse("08006", "down"),
      ],
    });
    expect(await acceptInvite(db, "t")).toEqual({ ok: true, data: { membershipId: "m9" } });
    expect(await acceptInvite(db, "t")).toMatchObject({
      error: { rule: "invite_inviter_inactive" },
    });
    expect(await acceptInvite(db, "t")).toMatchObject({ error: { kind: "unexpected" } });
    expect((await acceptInvite(db, "t")).ok).toBe(false);
  });
});

describe("partner orgs", () => {
  it("reports whether an org has client orgs", async () => {
    const { db } = fakeClient({
      "from:organizations": [
        { data: null, error: null, count: 2 } as never,
        { data: null, error: null, count: null } as never,
        errorResponse("08006", "down"),
      ],
    });
    expect(await hasClientOrganizations(db, "o1")).toEqual({ ok: true, data: true });
    expect(await hasClientOrganizations(db, "o1")).toEqual({ ok: true, data: false });
    expect((await hasClientOrganizations(db, "o1")).ok).toBe(false);
  });
});

describe("workspaces and subscriptions", () => {
  it("lists workspaces", async () => {
    const { db } = fakeClient({
      "from:workspaces": [
        okResponse([{ id: "w1", slug: "nyc", name: "New York" }]),
        errorResponse("08006", "down"),
      ],
    });
    expect(await listWorkspaces(db, "o1")).toEqual({
      ok: true,
      data: [{ id: "w1", slug: "nyc", name: "New York" }],
    });
    expect((await listWorkspaces(db, "o1")).ok).toBe(false);
  });

  it("reads the current subscription", async () => {
    const { db } = fakeClient({
      "from:subscriptions": [
        okResponse({ plan_code: "access", subscription_state: "active" }),
        okResponse(null),
        errorResponse("08006", "down"),
      ],
    });
    expect(await getSubscription(db, "o1")).toEqual({
      ok: true,
      data: { planCode: "access", state: "active" },
    });
    expect(await getSubscription(db, "o1")).toEqual({ ok: false, error: { kind: "not-found" } });
    expect((await getSubscription(db, "o1")).ok).toBe(false);
  });
});
