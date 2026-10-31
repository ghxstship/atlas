import { describe, expect, it } from "vitest";
import {
  ACCOUNT_ENGAGEMENT_DUTIES,
  addRosterEntry,
  assignEngagementMember,
  bulkReviewRosterEntries,
  inviteAccountMember,
  inviteToRoster,
  listAccountTalent,
  listEngagementRoster,
  listMyRosterEntries,
  myPendingInvitations,
  pendingRosterAnswers,
  respondPartyInvitation,
  respondRosterEntry,
  reviewRosterEntry,
  ROSTER_ENTRY_STATES,
  rosterSharedWorkDetails,
  submitRoster,
  updateRosterEntry,
  withdrawRosterEntry,
  type MyRosterEntry,
} from "../src/roster.ts";
import { errorResponse, okResponse } from "./fake-client.ts";
import { moduleClient, stepsOf } from "./module-client.ts";

const row = {
  id: "r1",
  project_id: "p1",
  engagement_id: "e1",
  party_name: "Bayside Audio",
  role_type: "Vendor",
  is_self: false,
  person_id: "kai",
  full_name: "Kai Morgan",
  invited_email: null,
  invitation_expires_at: null,
  role_code: "9000.50.02",
  job_title: "A2",
  arrival_starts_at: "2027-06-01T12:00:00Z",
  arrival_ends_at: "2027-06-01T14:00:00Z",
  arrival_time_zone: "America/New_York",
  entry_state: "Returned",
  person_response: "Accepted",
  responded_at: "2027-05-01T00:00:00Z",
  return_reason: "Add the arrival.",
  replaces_entry_id: null,
  share_categories: ["Uniform Sizes"],
};

const mine = (over: Partial<MyRosterEntry>): MyRosterEntry => ({
  id: "m",
  engagementId: "e1",
  projectId: "p1",
  orgName: "Northwind Live",
  projectName: "Summer Series",
  partyName: "Bayside Audio",
  roleType: "Vendor",
  jobTitle: null,
  arrivalStartsAt: null,
  arrivalEndsAt: null,
  arrivalTimeZone: null,
  entryState: "Draft",
  personResponse: "Pending",
  isSelf: false,
  shareCategories: [],
  ...over,
});

describe("roster", () => {
  it("names the enums in the database's order", () => {
    expect(ROSTER_ENTRY_STATES).toEqual([
      "Draft",
      "Submitted",
      "Accepted",
      "Returned",
      "Withdrawn",
    ]);
    expect(ACCOUNT_ENGAGEMENT_DUTIES).toEqual(["Advancing Lead", "Member"]);
  });

  it("reads an engagement's roster from the external view, the self entry first", async () => {
    const { db, calls } = moduleClient({
      "api_external:from:engagement_roster": [
        okResponse([row, { ...row, id: null }]),
        errorResponse("42501", "denied"),
      ],
    });
    const result = await listEngagementRoster(db, "e1");
    expect(result.ok && result.data).toEqual([
      expect.objectContaining({
        id: "r1",
        personId: "kai",
        entryState: "Returned",
        personResponse: "Accepted",
        returnReason: "Add the arrival.",
        shareCategories: ["Uniform Sizes"],
        isSelf: false,
      }),
    ]);
    expect(stepsOf(calls[0], "eq")).toEqual([["engagement_id", "e1"]]);
    expect(stepsOf(calls[0], "order")[0]).toEqual(["is_self", { ascending: false }]);
    expect(await listEngagementRoster(db, "e1")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
  });

  it("lists the caller's entries and picks those waiting for their answer", async () => {
    const { db } = moduleClient({
      "api_external:from:my_roster_entries": [
        okResponse([
          {
            id: "m1",
            engagement_id: "e1",
            project_id: "p1",
            org_name: "Northwind Live",
            project_name: "Summer Series",
            party_name: "Bayside Audio",
            role_type: "Vendor",
            job_title: "A2",
            arrival_starts_at: null,
            arrival_ends_at: null,
            arrival_time_zone: null,
            entry_state: "Draft",
            person_response: "Pending",
            is_self: false,
            share_categories: null,
          },
        ]),
      ],
    });
    const result = await listMyRosterEntries(db);
    expect(result.ok && result.data[0]).toEqual(
      expect.objectContaining({ id: "m1", shareCategories: [] }),
    );
    expect(
      pendingRosterAnswers([
        mine({ id: "a" }),
        mine({ id: "self", isSelf: true }),
        mine({ id: "answered", personResponse: "Accepted" }),
        mine({ id: "gone", entryState: "Withdrawn" }),
      ]).map((r) => r.id),
    ).toEqual(["a"]);
  });

  it("dedupes the talent pool by person", async () => {
    const { db, calls } = moduleClient({
      "api_external:from:my_account_talent": [
        okResponse([
          { account_id: "a1", person_id: "kai", full_name: "Kai Morgan", source: "Account Member" },
          { account_id: "a2", person_id: "kai", full_name: "Kai Morgan", source: "Account Member" },
          {
            account_id: "a1",
            person_id: "art",
            full_name: "Arturo Bell",
            source: "Represented Artist",
          },
        ]),
      ],
    });
    const result = await listAccountTalent(db, "a1");
    expect(result.ok && result.data.map((t) => `${t.personId}:${t.source}`)).toEqual([
      "kai:Account Member",
      "art:Represented Artist",
    ]);
    expect(stepsOf(calls[0], "eq")).toEqual([["account_id", "a1"]]);
  });

  it("adds, invites, edits, submits and withdraws through the RPCs, sending only given fields", async () => {
    const { db, calls } = moduleClient({
      "rpc:add_roster_entry": [okResponse("r2")],
      "rpc:invite_to_roster": [
        errorResponse(
          "XR001",
          "invite_expiry_range: An invitation stays open between 1 hour and 30 days.",
          "invite_expiry_range",
        ),
      ],
      "rpc:update_roster_entry": [okResponse(null)],
      "rpc:submit_roster": [okResponse(3)],
      "rpc:withdraw_roster_entry": [okResponse(null)],
    });
    const none = {
      roleCode: null,
      arrivalStartsAt: null,
      arrivalEndsAt: null,
      arrivalTimeZone: null,
    };
    expect(
      await addRosterEntry(db, {
        ...none,
        engagementId: "e1",
        personId: "kai",
        roleCode: "9000.50.02",
      }),
    ).toEqual({
      ok: true,
      data: "r2",
    });
    expect(stepsOf(calls[0], "args")).toEqual([
      [{ p_engagement_id: "e1", p_person_id: "kai", p_role_code: "9000.50.02" }],
    ]);
    const invited = await inviteToRoster(db, {
      ...none,
      engagementId: "e1",
      email: "nell@touring.test",
    });
    expect(invited.ok === false && invited.error.kind === "refusal" && invited.error.rule).toBe(
      "invite_expiry_range",
    );
    await updateRosterEntry(db, "r2", none);
    expect(stepsOf(calls[2], "args")[0]?.[0]).toEqual({
      p_roster_entry_id: "r2",
      p_role_code: null,
      p_arrival_starts_at: null,
      p_arrival_ends_at: null,
      p_arrival_time_zone: null,
    });
    expect(await submitRoster(db, "e1")).toEqual({ ok: true, data: 3 });
    expect((await withdrawRosterEntry(db, "r2", "Moved.")).ok).toBe(true);
  });

  it("answers, reviews and reviews in bulk with one reason", async () => {
    const { db, calls } = moduleClient({
      "rpc:respond_roster_entry": [okResponse(null)],
      "rpc:review_roster_entry": [okResponse(null), okResponse(null)],
      "rpc:bulk_update_roster_entries": [
        okResponse({ preview: false, committed: true, changed: 2 }),
      ],
    });
    await respondRosterEntry(db, "r1", "Declined");
    expect(stepsOf(calls[0], "args")).toEqual([
      [{ p_roster_entry_id: "r1", p_response: "Declined" }],
    ]);
    await reviewRosterEntry(db, "r1", "Accepted");
    expect(stepsOf(calls[1], "args")).toEqual([
      [{ p_roster_entry_id: "r1", p_outcome: "Accepted" }],
    ]);
    await reviewRosterEntry(db, "r1", "Returned", "Add the arrival.");
    expect(stepsOf(calls[2], "args")[0]?.[0]).toEqual(
      expect.objectContaining({ p_outcome: "Returned", p_reason: "Add the arrival." }),
    );
    const bulk = await bulkReviewRosterEntries(db, ["r1", "r2"], "Returned", {
      reason: "Shirt sizes.",
    });
    expect(bulk.ok && bulk.data.committed).toBe(true);
    expect(stepsOf(calls[3], "args")).toEqual([
      [
        {
          p_rows: [
            { id: "r1", set: { entry_state: "Returned" } },
            { id: "r2", set: { entry_state: "Returned" } },
          ],
          p_preview: false,
          p_reason: "Shirt sizes.",
        },
      ],
    ]);
  });

  it("parses a company read with allergies masked and on file", async () => {
    const { db } = moduleClient({
      "rpc:roster_shared_work_details": [
        okResponse({
          engagement_id: "e1",
          person_id: "kai",
          roster_entry_id: "r1",
          reader: "company",
          readable: ["Dietary Needs"],
          categories: [],
          sharing_open: true,
          dietary: {
            dietary_needs: ["Vegetarian"],
            allergies: null,
            allergies_masked: true,
            allergies_on_file: true,
            dietary_notes: null,
          },
        }),
      ],
    });
    const result = await rosterSharedWorkDetails(db, "r1");
    expect(result.ok && result.data.reader).toBe("company");
    expect(result.ok && result.data.rosterEntryId).toBe("r1");
    expect(result.ok && result.data.dietary).toEqual({
      dietaryNeeds: ["Vegetarian"],
      allergies: null,
      allergiesOnFile: true,
      allergiesMasked: true,
      dietaryNotes: null,
    });
  });

  it("assigns members, invites to the account and answers invitations", async () => {
    const { db, calls } = moduleClient({
      "rpc:assign_engagement_member": [okResponse("a1")],
      "rpc:invite_account_member": [okResponse("i1")],
      "rpc:my_pending_invitations": [
        okResponse([
          {
            invitation_kind: "roster",
            invitation_id: "i2",
            account_name: "Bayside Audio",
            org_name: "Northwind Live",
            project_name: "Summer Series",
            party_name: "Bayside Audio",
            job_title: "A2",
            account_role: null,
            inviter_name: "Victor Osei",
            expires_at: "2027-06-01T00:00:00Z",
          },
          { invitation_kind: "other", invitation_id: "x" },
        ]),
      ],
      "rpc:respond_party_invitation": [okResponse("r9"), okResponse(null)],
    });
    expect(await assignEngagementMember(db, "e1", "m1", "Advancing Lead")).toEqual({
      ok: true,
      data: "a1",
    });
    expect(stepsOf(calls[0], "args")).toEqual([
      [{ p_engagement_id: "e1", p_account_membership_id: "m1", p_duty: "Advancing Lead" }],
    ]);
    expect(await inviteAccountMember(db, "acct", "noor@stagehands.test", "Account Member")).toEqual(
      { ok: true, data: "i1" },
    );
    const pending = await myPendingInvitations(db);
    expect(pending.ok && pending.data.map((p) => `${p.kind}:${p.id}`)).toEqual(["roster:i2"]);
    expect(await respondPartyInvitation(db, "roster", "i2", true)).toEqual({
      ok: true,
      data: "r9",
    });
    expect(await respondPartyInvitation(db, "account", "i3", false)).toEqual({
      ok: true,
      data: null,
    });
  });
});
