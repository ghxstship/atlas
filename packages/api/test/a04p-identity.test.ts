/**
 * A04P contract tests for the Identity parity handlers (src/handlers/identity/parity.ts). Requests
 * run through `contractApp` against the in-memory client; every response is checked against
 * openapi/v1.json with `expectContract`.
 */
import { describe, expect, it } from "vitest";
import { handlers } from "../src/handlers/identity.ts";
import { contractApp, expectContract, testContext } from "./support/contract.ts";
import { memoryDb, refusal, requests, success } from "./support/memory-db.ts";
import type { Row } from "./support/memory-db.ts";
import { sample } from "./support/samples.ts";

const ORG = testContext().org?.id as string;
const ME = testContext().personId as string;
const id = (n: number) => `0192f1e2-7c3a-7b4d-9e8f-${String(n).padStart(12, "0")}`;
const TIMES = {
  created_at: "2026-10-01T12:00:00.000Z",
  created_by: null,
  updated_at: "2026-10-01T12:00:00.000Z",
  updated_by: null,
};
const MEMBERSHIP = id(9001);
const REP = id(9002);

function seed(component: string, rowId: string, extra: Row = {}): Row {
  return { ...sample(component, { id: rowId, ...TIMES, ...extra }), deleted_at: null };
}

function world(context = {}) {
  const db = memoryDb(
    {
      people: [seed("Person", ME, { full_name: "Demo Owner" })],
      organizations: [seed("Organization", ORG, { name: "Demo Productions" })],
      memberships: [seed("Membership", MEMBERSHIP, { org_id: ORG, person_id: ME, valid_to: null })],
      engagements: [{ id: id(9050), person_id: ME, deleted_at: null }],
      membership_roles: [seed("MembershipRole", id(9003), { org_id: ORG })],
      project_members: [seed("ProjectAssignment", id(9004), { org_id: ORG })],
      account_memberships: [seed("AccountMembership", id(9005), { org_id: ORG })],
      account_membership_roles: [seed("AccountMembershipRole", id(9006), { org_id: ORG })],
      representations: [
        {
          ...seed("Representation", REP, { accepted_at: null, revoked_at: null }),
          scopes: undefined,
        },
      ],
      representation_scopes: [
        { id: id(9012), representation_id: REP, scope: "Offers", deleted_at: null },
      ],
      invites: [seed("Invite", id(9007), { org_id: ORG, token_hash: "\\x00", accepted_at: null })],
      org_domains: [seed("VerifiedDomain", id(9008), { org_id: ORG })],
      profile_section_visibility: [seed("ProfileVisibilityRule", id(9009), { person_id: ME })],
      organization_verifications: [seed("Verification", id(9010), { org_id: ORG })],
    },
    {
      create_organization: (args, self) => {
        self.tables["organizations"]?.push(
          seed("Organization", id(9020), { name: args["p_name"], slug: args["p_slug"] }),
        );
        return id(9020);
      },
      create_client_organization: () => [
        { org_id: id(9021), invite_id: id(9022), invite_token: "inv_client_token_0001" },
      ],
      leave_organization: (_args, self) => {
        const m = self.tables["memberships"]?.[0] as Row;
        m["valid_to"] = "2026-10-02T09:00:00.000Z";
        return null;
      },
      end_membership: (args, self) => {
        const m = self.tables["memberships"]?.find((r) => r["id"] === args["p_membership_id"]);
        if (m) m["valid_to"] = "2026-10-02T09:00:00.000Z";
        return null;
      },
      propose_representation: (args, self) => {
        self.tables["representations"]?.push({
          id: id(9030),
          org_id: args["p_account_id"],
          ...TIMES,
          artist_person_id: args["p_artist_person_id"],
          representative_person_id: args["p_representative_person_id"],
          expires_on: args["p_expires_on"],
          accepted_at: null,
          revoked_at: null,
          deleted_at: null,
        });
        for (const scope of args["p_scopes"] as string[]) {
          self.tables["representation_scopes"]?.push({
            id: `${scope}-1`,
            representation_id: id(9030),
            scope,
            deleted_at: null,
          });
        }
        return id(9030);
      },
      accept_representation: (args, self) => {
        const r = self.tables["representations"]?.find(
          (x) => x["id"] === args["p_representation_id"],
        );
        if (r) r["accepted_at"] = "2026-10-02T09:00:00.000Z";
        return null;
      },
      revoke_representation: () => null,
      invite_member: () => [{ invite_id: id(9040), invite_token: "inv_member_token_0001" }],
      preview_invite: () => [
        {
          org_name: "Demo Productions",
          role_code: "manager",
          role_name: "Manager",
          expires_at: "2026-10-15T00:00:00.000Z",
          refusal: null,
          reason: null,
        },
      ],
      accept_invite: () => [{ membership_id: MEMBERSHIP, refusal: null, reason: null }],
    },
    {
      membership_roles: { granted_by: ME },
      account_membership_roles: { granted_by: null },
      project_members: { valid_from: "2026-10-01T12:00:00.000Z", valid_to: null },
      account_memberships: { valid_from: "2026-10-01T12:00:00.000Z", valid_to: null },
      org_domains: {
        verification_state: "Pending",
        verification_token: "xos-verify-7d1c",
        last_checked_at: null,
      },
      organization_verifications: {
        verified_at: "2026-10-02T09:00:00.000Z",
        revoked_at: null,
        revocation_reason: null,
      },
    },
  );
  const app = contractApp({ handlers: [handlers], db, context });
  return { db, http: requests(app) };
}

describe("the caller, people and organizations", () => {
  it("answers me with counts", async () => {
    const { http } = world();
    const me = await http.get("/me");
    const body = (await expectContract(await success(me), "me.get")) as Row;
    expect(body).toEqual({
      person_id: ME,
      active_organization_id: ORG,
      membership_count: 1,
      engagement_count: 1,
    });
  });

  it("serves people", async () => {
    const { http } = world();
    const listed = await http.get("/people");
    await expectContract(await success(listed), "people.list");
    const read = await http.get(`/people/${ME}`);
    await expectContract(await success(read), "people.get");
    const renamed = await http.patch(`/people/${ME}`, { full_name: "Demo Owner Two" });
    await expectContract(await success(renamed), "people.update");
  });

  it("serves organizations and creates them through their RPCs", async () => {
    const { http } = world();
    const listed = await http.get("/organizations");
    await expectContract(await success(listed), "organizations.list");
    const read = await http.get(`/organizations/${ORG}`);
    await expectContract(await success(read), "organizations.get");
    const renamed = await http.patch(`/organizations/${ORG}`, { name: "Demo Live" });
    await expectContract(await success(renamed), "organizations.update");
    const made = await http.post("/organizations", { name: "Second Stage", slug: "second-stage" });
    const org = (await expectContract(await success(made), "organizations.create")) as Row;
    expect(org["slug"]).toBe("second-stage");
    const client = await http.post("/organizations/clients", {
      name: "Client Co",
      slug: "client-co",
      owner_email: "owner@client.example.com",
    });
    await expectContract(await success(client), "organizations.createClient");
  });
});

describe("memberships and assignments", () => {
  it("serves memberships, leaves, ends and offboards", async () => {
    const { http } = world();
    const listed = await http.get("/memberships");
    await expectContract(await success(listed), "memberships.list");
    const read = await http.get(`/memberships/${MEMBERSHIP}`);
    await expectContract(await success(read), "memberships.get");
    const edited = await http.patch(`/memberships/${MEMBERSHIP}`, {
      valid_to: "2027-01-01T00:00:00Z",
    });
    await expectContract(await success(edited), "memberships.update");
    const left = await http.post("/memberships/leave");
    const after = (await expectContract(await success(left), "memberships.leave")) as Row;
    expect(after["valid_to"]).not.toBeNull();
    const ended = await http.post(`/memberships/${MEMBERSHIP}/end`);
    await expectContract(await success(ended), "memberships.end");
    const offboarded = await http.post(`/memberships/${MEMBERSHIP}/offboard`);
    await expectContract(await success(offboarded), "memberships.offboard");
  });

  it("refuses leave without a membership", async () => {
    const { http } = world({ personId: id(9099) });
    const left = await http.post("/memberships/leave");
    expect(left.status).toBe(404);
  });

  it("serves membership roles and project assignments", async () => {
    const { http } = world();
    const roles = await http.get("/membership-roles");
    await expectContract(await success(roles), "membershipRoles.list");
    const role = await http.get(`/membership-roles/${id(9003)}`);
    await expectContract(await success(role), "membershipRoles.get");
    const granted = await http.post("/membership-roles", {
      membership_id: MEMBERSHIP,
      role_id: id(9060),
    });
    await expectContract(await success(granted), "membershipRoles.create");
    const revoked = await http.delete(`/membership-roles/${id(9003)}`);
    await expectContract(await success(revoked), "membershipRoles.delete");

    const assignments = await http.get("/project-assignments");
    await expectContract(await success(assignments), "projectAssignments.list");
    const assignment = await http.get(`/project-assignments/${id(9004)}`);
    await expectContract(await success(assignment), "projectAssignments.get");
    const assigned = await http.post("/project-assignments", {
      project_id: id(9061),
      membership_id: MEMBERSHIP,
      project_role: "Coordinator",
    });
    await expectContract(await success(assigned), "projectAssignments.create");
    const changed = await http.patch(`/project-assignments/${id(9004)}`, { project_role: "Field" });
    await expectContract(await success(changed), "projectAssignments.update");
    const unassigned = await http.delete(`/project-assignments/${id(9004)}`);
    await expectContract(await success(unassigned), "projectAssignments.delete");
  });

  it("serves external account memberships and roles", async () => {
    const { http } = world();
    const listed = await http.get("/account-memberships");
    await expectContract(await success(listed), "accountMemberships.list");
    const read = await http.get(`/account-memberships/${id(9005)}`);
    await expectContract(await success(read), "accountMemberships.get");
    const added = await http.post("/account-memberships", { person_id: id(9062) });
    await expectContract(await success(added), "accountMemberships.create");
    const edited = await http.patch(`/account-memberships/${id(9005)}`, {
      valid_to: "2027-06-30T00:00:00Z",
    });
    await expectContract(await success(edited), "accountMemberships.update");
    const removed = await http.delete(`/account-memberships/${id(9005)}`);
    await expectContract(await success(removed), "accountMemberships.delete");

    const roles = await http.get("/account-membership-roles");
    await expectContract(await success(roles), "accountMembershipRoles.list");
    const role = await http.get(`/account-membership-roles/${id(9006)}`);
    await expectContract(await success(role), "accountMembershipRoles.get");
    const granted = await http.post("/account-membership-roles", {
      account_membership_id: id(9005),
      account_role: "Account Finance",
    });
    await expectContract(await success(granted), "accountMembershipRoles.create");
    const revoked = await http.delete(`/account-membership-roles/${id(9006)}`);
    await expectContract(await success(revoked), "accountMembershipRoles.delete");
  });
});

describe("representations", () => {
  it("proposes, edits, accepts and revokes", async () => {
    const { db, http } = world();
    const listed = await http.get("/representations");
    const page = (await expectContract(await success(listed), "representations.list")) as {
      data: Row[];
    };
    expect(page.data[0]?.["scopes"]).toEqual(["Offers"]);
    const read = await http.get(`/representations/${REP}`);
    await expectContract(await success(read), "representations.get");
    const proposed = await http.post("/representations", {
      artist_person_id: id(9063),
      scopes: ["Offers", "Documents"],
      expires_on: "2027-12-31",
    });
    const made = (await expectContract(await success(proposed), "representations.create")) as Row;
    expect(made["scopes"]).toEqual(["Documents", "Offers"]);
    const edited = await http.patch(`/representations/${REP}`, {
      scopes: ["Documents"],
      expires_on: "2028-01-31",
    });
    const changed = (await expectContract(await success(edited), "representations.update")) as Row;
    expect(changed["scopes"]).toEqual(["Documents"]);
    const accepted = await http.post(`/representations/${REP}/accept`);
    await expectContract(await success(accepted), "representations.accept");
    const revoked = await http.delete(`/representations/${REP}`);
    await expectContract(await success(revoked), "representations.delete");
    expect(db.calls.map((c) => c.name)).toContain("revoke_representation");
  });
});

describe("invites", () => {
  it("invites, previews, accepts and revokes", async () => {
    const { db, http } = world();
    const listed = await http.get("/invites");
    const page = (await expectContract(await success(listed), "invites.list")) as { data: Row[] };
    expect(page.data[0]).not.toHaveProperty("token_hash");
    const read = await http.get(`/invites/${id(9007)}`);
    await expectContract(await success(read), "invites.get");
    const invited = await http.post("/invites", {
      email: "new@example.com",
      role_id: id(9060),
      valid_for_hours: 48,
    });
    await expectContract(await success(invited), "invites.create");
    const preview = await http.post("/invites/preview", { token: "inv_member_token_0001" });
    await expectContract(await success(preview), "invites.preview");
    const accepted = await http.post("/invites/accept", { token: "inv_member_token_0001" });
    await expectContract(await success(accepted), "invites.accept");
    const revoked = await http.delete(`/invites/${id(9007)}`);
    await expectContract(await success(revoked), "invites.delete");
    expect(db.writes.at(-1)?.values).toHaveProperty("revoked_at");
    db.fail("rpc:invite_member", refusal("invite_role_above_caller"));
    const refused = await http.post("/invites", { email: "x@example.com", role_id: id(9060) });
    expect(refused.status).toBe(422);
  });
});

describe("domains, visibility and verifications", () => {
  it("serves verified domains", async () => {
    const { http } = world();
    const listed = await http.get("/verified-domains");
    await expectContract(await success(listed), "verifiedDomains.list");
    const read = await http.get(`/verified-domains/${id(9008)}`);
    await expectContract(await success(read), "verifiedDomains.get");
    const added = await http.post("/verified-domains", {
      hostname: "crew.demo.example.com",
      purpose: "Gateway",
    });
    await expectContract(await success(added), "verifiedDomains.create");
    const edited = await http.patch(`/verified-domains/${id(9008)}`, { auto_join_role_id: null });
    await expectContract(await success(edited), "verifiedDomains.update");
    const removed = await http.delete(`/verified-domains/${id(9008)}`);
    await expectContract(await success(removed), "verifiedDomains.delete");
  });

  it("serves profile visibility rules and verifications", async () => {
    const { http } = world();
    const rules = await http.get("/profile-visibility");
    await expectContract(await success(rules), "profileVisibilityRules.list");
    const rule = await http.get(`/profile-visibility/${id(9009)}`);
    await expectContract(await success(rule), "profileVisibilityRules.get");
    const madeRule = await http.post("/profile-visibility", {
      person_id: ME,
      section: "rates",
      visibility: "Private",
    });
    await expectContract(await success(madeRule), "profileVisibilityRules.create");
    const editedRule = await http.patch(`/profile-visibility/${id(9009)}`, {
      visibility: "Public",
    });
    await expectContract(await success(editedRule), "profileVisibilityRules.update");
    const removedRule = await http.delete(`/profile-visibility/${id(9009)}`);
    await expectContract(await success(removedRule), "profileVisibilityRules.delete");

    const verifications = await http.get("/verifications");
    await expectContract(await success(verifications), "verifications.list");
    const verification = await http.get(`/verifications/${id(9010)}`);
    await expectContract(await success(verification), "verifications.get");
    const made = await http.post("/verifications", {
      method: "Business Registry",
      provider_reference: "FL-DOS-P21000012345",
    });
    await expectContract(await success(made), "verifications.create");
  });
});
