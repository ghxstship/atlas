import { describe, expect, it } from "vitest";
import {
  acceptInviteLink,
  addCertification,
  addLanguage,
  addLink,
  addSkill,
  carryCertification,
  completeOffboarding,
  createInviteLink,
  decideJoinRequest,
  getMyProfile,
  getOrganizationProfile,
  isOrganizationVerified,
  joinByVerifiedDomain,
  listAutoJoinOffers,
  listCarryableCertifications,
  listInviteLinks,
  listMyCertifications,
  listMyLanguages,
  listMyLinks,
  listMySkills,
  listOpenOffboardings,
  listPendingJoinRequests,
  listSectionVisibility,
  PROFILE_SECTIONS,
  reassignOffboardingRecords,
  removeProfileItem,
  revokeInviteLink,
  setSectionVisibility,
  updateMyProfile,
  updateOrganizationProfile,
} from "../src/profiles";
import { errorResponse, fakeClient, okResponse } from "./fake-client";

const down = () => errorResponse("08000", "down");
const profileRow = {
  id: "pp1",
  handle: "dave-rigs",
  handle_changed_at: null,
  preferred_name: null,
  pronouns: null,
  headline: "Rigger",
  bio: null,
  city: "Miami",
  country_code: "US",
  visibility: "Network",
  search_indexing: false,
  marketplace_discoverable: true,
  rate_minor: null,
  rate_currency: null,
  rate_unit: null,
};

describe("person profile", () => {
  it("ensures and reads the profile", async () => {
    const { db } = fakeClient({
      "rpc:ensure_my_profile": [okResponse("pp1"), okResponse("pp1"), down()],
      "from:person_profiles": [okResponse(profileRow), down()],
    });
    const result = await getMyProfile(db);
    expect(result.ok && result.data.handle).toBe("dave-rigs");
    expect(result.ok && result.data.marketplaceDiscoverable).toBe(true);
    expect((await getMyProfile(db)).ok).toBe(false);
    expect((await getMyProfile(db)).ok).toBe(false);
    expect(PROFILE_SECTIONS).toContain("rates");
  });

  it("updates the profile and returns refusals", async () => {
    const { db } = fakeClient({
      "from:person_profiles": [
        okResponse([{ id: "pp1" }]),
        okResponse([]),
        errorResponse(
          "XR001",
          "handle_change_too_soon: Once every 30 days.",
          "handle_change_too_soon",
        ),
      ],
    });
    const input = {
      handle: "dave-rigs",
      preferredName: null,
      pronouns: null,
      headline: "Rigger",
      bio: null,
      city: null,
      countryCode: null,
      visibility: "Public" as const,
      searchIndexing: true,
      marketplaceDiscoverable: true,
      rateMinor: 45000,
      rateCurrency: "USD",
      rateUnit: "Day" as const,
    };
    expect(await updateMyProfile(db, "pp1", input)).toEqual({ ok: true, data: null });
    expect(await updateMyProfile(db, "pp1", input)).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    const refused = await updateMyProfile(db, "pp1", input);
    expect(!refused.ok && refused.error.kind === "refusal" && refused.error.rule).toBe(
      "handle_change_too_soon",
    );
  });

  it("reads and sets section visibility", async () => {
    const { db, calls } = fakeClient({
      "from:profile_section_visibility": [
        okResponse([{ section: "rates", visibility: "Private" }]),
        down(),
        okResponse(null),
        okResponse(null),
        okResponse({ id: "s1" }),
        okResponse(null),
        okResponse({ id: "s1" }),
        okResponse(null),
        okResponse(null),
        down(),
      ],
    });
    const listed = await listSectionVisibility(db, "p1");
    expect(listed.ok && listed.data.get("rates")).toBe("Private");
    expect((await listSectionVisibility(db, "p1")).ok).toBe(false);
    expect(
      await setSectionVisibility(db, { personId: "p1", section: "bio", visibility: "Public" }),
    ).toEqual({ ok: true, data: null });
    expect(calls[3]?.steps[0]?.[0]).toBe("insert");
    expect(
      await setSectionVisibility(db, { personId: "p1", section: "bio", visibility: "Network" }),
    ).toEqual({ ok: true, data: null });
    expect(calls[5]?.steps[0]?.[0]).toBe("update");
    expect(
      await setSectionVisibility(db, { personId: "p1", section: "bio", visibility: null }),
    ).toEqual({ ok: true, data: null });
    expect(
      await setSectionVisibility(db, { personId: "p1", section: "bio", visibility: null }),
    ).toEqual({ ok: true, data: null });
    expect(
      (await setSectionVisibility(db, { personId: "p1", section: "bio", visibility: null })).ok,
    ).toBe(false);
  });
});

describe("profile lists", () => {
  it("lists and adds skills, languages and links", async () => {
    const { db } = fakeClient({
      "from:person_skills": [
        okResponse([{ id: "k1", cat_urid: "5000.05.02", sort_order: 1 }]),
        down(),
        okResponse(null),
        down(),
      ],
      "from:person_languages": [
        okResponse([{ id: "l1", language_tag: "es", proficiency: "Fluent" }]),
        down(),
        okResponse(null),
        down(),
      ],
      "from:person_links": [
        okResponse([{ id: "n1", label: "Site", url: "https://example.com", sort_order: 0 }]),
        down(),
        okResponse(null),
        down(),
      ],
    });
    expect(await listMySkills(db, "p1")).toEqual({
      ok: true,
      data: [{ id: "k1", catUrid: "5000.05.02" }],
    });
    expect((await listMySkills(db, "p1")).ok).toBe(false);
    expect((await addSkill(db, { personId: "p1", catUrid: "5000.05.02", sortOrder: 1 })).ok).toBe(
      true,
    );
    expect((await addSkill(db, { personId: "p1", catUrid: "5000.05.02", sortOrder: 1 })).ok).toBe(
      false,
    );
    expect(await listMyLanguages(db, "p1")).toEqual({
      ok: true,
      data: [{ id: "l1", tag: "es", proficiency: "Fluent" }],
    });
    expect((await listMyLanguages(db, "p1")).ok).toBe(false);
    expect((await addLanguage(db, { personId: "p1", tag: "es", proficiency: "Fluent" })).ok).toBe(
      true,
    );
    expect((await addLanguage(db, { personId: "p1", tag: "es", proficiency: "Fluent" })).ok).toBe(
      false,
    );
    expect(await listMyLinks(db, "p1")).toEqual({
      ok: true,
      data: [{ id: "n1", label: "Site", url: "https://example.com" }],
    });
    expect((await listMyLinks(db, "p1")).ok).toBe(false);
    expect(
      (await addLink(db, { personId: "p1", label: "Site", url: "https://example.com" })).ok,
    ).toBe(true);
    expect(
      (await addLink(db, { personId: "p1", label: "Site", url: "https://example.com" })).ok,
    ).toBe(false);
  });

  it("removes items", async () => {
    const { db } = fakeClient({
      "from:person_links": [okResponse([{ id: "n1" }]), okResponse([]), down()],
    });
    expect(await removeProfileItem(db, "person_links", "n1")).toEqual({ ok: true, data: null });
    expect(await removeProfileItem(db, "person_links", "n2")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect((await removeProfileItem(db, "person_links", "n3")).ok).toBe(false);
  });

  it("handles certifications and carry-over", async () => {
    const { db } = fakeClient({
      "from:person_certifications": [
        okResponse([
          {
            id: "c1",
            name: "Rigging",
            issuing_body: "ETCP",
            issued_on: "2025-01-01",
            expires_on: null,
            verified_at: "2025-01-02",
            source_certification_holder_id: "h1",
          },
        ]),
        down(),
        okResponse(null),
        down(),
        okResponse([{ source_certification_holder_id: "h1" }]),
        okResponse([]),
        down(),
      ],
      "from:certification_holders": [
        okResponse([
          { id: "h1", certification: { name: "Rigging", organization: { name: "Demo" } } },
          { id: "h2", certification: null },
        ]),
        down(),
        okResponse([]),
      ],
      "rpc:carry_certification_to_profile": [
        okResponse("c9"),
        errorResponse("XR001", "certification_not_yours: No.", "certification_not_yours"),
      ],
    });
    const listed = await listMyCertifications(db, "p1");
    expect(listed.ok && listed.data[0]).toEqual({
      id: "c1",
      name: "Rigging",
      issuingBody: "ETCP",
      issuedOn: "2025-01-01",
      expiresOn: null,
      verified: true,
      carried: true,
    });
    expect((await listMyCertifications(db, "p1")).ok).toBe(false);
    expect(
      (
        await addCertification(db, {
          personId: "p1",
          name: "First Aid",
          issuingBody: "Red Cross",
          issuedOn: "2025-01-01",
          expiresOn: null,
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await addCertification(db, {
          personId: "p1",
          name: "First Aid",
          issuingBody: "Red Cross",
          issuedOn: "2025-01-01",
          expiresOn: null,
        })
      ).ok,
    ).toBe(false);
    const carryable = await listCarryableCertifications(db, "p1");
    expect(carryable.ok && carryable.data).toEqual([
      { holderId: "h1", name: "Rigging", orgName: "Demo", carried: true },
      { holderId: "h2", name: "", orgName: "", carried: false },
    ]);
    expect((await listCarryableCertifications(db, "p1")).ok).toBe(false);
    expect((await listCarryableCertifications(db, "p1")).ok).toBe(false);
    expect(await carryCertification(db, "h1")).toEqual({ ok: true, data: { id: "c9" } });
    expect((await carryCertification(db, "h1")).ok).toBe(false);
  });
});

describe("organization profiles", () => {
  it("ensures, reads and updates", async () => {
    const row = {
      id: "op1",
      handle: "demo",
      about: null,
      website_url: null,
      contact_email: null,
      visibility: "Public",
      search_indexing: false,
    };
    const { db } = fakeClient({
      "rpc:ensure_organization_profile": [okResponse("op1"), errorResponse("42501", "no")],
      "from:organization_profiles": [
        okResponse(row),
        okResponse(null),
        down(),
        okResponse([{ id: "op1" }]),
        okResponse([]),
        down(),
      ],
      "rpc:organization_verified": [okResponse(true), down()],
    });
    const created = await getOrganizationProfile(db, "o1", true);
    expect(created.ok && created.data?.handle).toBe("demo");
    expect((await getOrganizationProfile(db, "o1", true)).ok).toBe(false);
    expect(await getOrganizationProfile(db, "o1", false)).toEqual({ ok: true, data: null });
    expect((await getOrganizationProfile(db, "o1", false)).ok).toBe(false);
    const input = {
      handle: "demo",
      about: "About",
      websiteUrl: null,
      contactEmail: null,
      visibility: "Public" as const,
      searchIndexing: false,
    };
    expect(await updateOrganizationProfile(db, "op1", input)).toEqual({ ok: true, data: null });
    expect(await updateOrganizationProfile(db, "op1", input)).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect((await updateOrganizationProfile(db, "op1", input)).ok).toBe(false);
    expect(await isOrganizationVerified(db, "o1")).toEqual({ ok: true, data: true });
    expect((await isOrganizationVerified(db, "o1")).ok).toBe(false);
  });
});

describe("joining and offboarding", () => {
  it("lists and decides join requests", async () => {
    const { db } = fakeClient({
      "from:join_requests": [
        okResponse([
          {
            id: "j1",
            person_id: "p2",
            message: "Hi",
            created_at: "2026-10-01",
            person: { full_name: "Paul" },
          },
          { id: "j2", person_id: "p3", message: null, created_at: "2026-10-02", person: null },
        ]),
        down(),
      ],
      "rpc:decide_join_request": [okResponse("m1"), okResponse(null), down()],
    });
    const listed = await listPendingJoinRequests(db, "o1");
    expect(listed.ok && listed.data.map((r) => r.personName)).toEqual(["Paul", null]);
    expect((await listPendingJoinRequests(db, "o1")).ok).toBe(false);
    expect((await decideJoinRequest(db, { requestId: "j1", approve: true, roleId: "r1" })).ok).toBe(
      true,
    );
    expect((await decideJoinRequest(db, { requestId: "j2", approve: false })).ok).toBe(true);
    expect((await decideJoinRequest(db, { requestId: "j2", approve: false })).ok).toBe(false);
  });

  it("manages invitation links", async () => {
    const { db, calls } = fakeClient({
      "from:invite_links": [
        okResponse([
          { id: "l1", role_id: "r1", expires_at: "2026-11-01", max_uses: 5, use_count: 1 },
        ]),
        down(),
      ],
      "rpc:create_invite_link": [
        okResponse({ invite_link_id: "l2", invite_token: "xlnk_1" }),
        down(),
      ],
      "rpc:revoke_invite_link": [okResponse(null), down()],
      "rpc:accept_invite_link": [okResponse("m1"), down()],
    });
    expect(await listInviteLinks(db, "o1")).toEqual({
      ok: true,
      data: [{ id: "l1", roleId: "r1", expiresAt: "2026-11-01", maxUses: 5, useCount: 1 }],
    });
    expect((await listInviteLinks(db, "o1")).ok).toBe(false);
    expect(
      await createInviteLink(db, { orgId: "o1", roleId: "r1", validForHours: 48, maxUses: 5 }),
    ).toEqual({ ok: true, data: { id: "l2", token: "xlnk_1" } });
    expect(calls.find((c) => c.target === "rpc:create_invite_link")?.steps[0]).toEqual([
      "args",
      [{ p_org_id: "o1", p_role_id: "r1", p_valid_for: "48 hours", p_max_uses: 5 }],
    ]);
    expect(
      (await createInviteLink(db, { orgId: "o1", roleId: "r1", validForHours: 48, maxUses: 5 })).ok,
    ).toBe(false);
    expect((await revokeInviteLink(db, "l1")).ok).toBe(true);
    expect((await revokeInviteLink(db, "l1")).ok).toBe(false);
    expect(await acceptInviteLink(db, "xlnk_1")).toEqual({
      ok: true,
      data: { membershipId: "m1" },
    });
    expect((await acceptInviteLink(db, "xlnk_1")).ok).toBe(false);
  });

  it("offers and performs automatic join", async () => {
    const { db } = fakeClient({
      "rpc:auto_join_offers": [
        okResponse([{ org_id: "o1", org_name: "Demo", org_slug: "demo" }]),
        down(),
      ],
      "rpc:join_by_verified_domain": [okResponse("m1"), down()],
    });
    expect(await listAutoJoinOffers(db)).toEqual({
      ok: true,
      data: [{ orgId: "o1", orgName: "Demo", orgSlug: "demo" }],
    });
    expect((await listAutoJoinOffers(db)).ok).toBe(false);
    expect(await joinByVerifiedDomain(db, "o1")).toEqual({
      ok: true,
      data: { membershipId: "m1" },
    });
    expect((await joinByVerifiedDomain(db, "o1")).ok).toBe(false);
  });

  it("lists, reassigns and completes offboardings", async () => {
    const { db } = fakeClient({
      "from:offboardings": [
        okResponse([
          { id: "f1", person_id: "p1", started_at: "2026-10-01", person: { full_name: "Dave" } },
          { id: "f2", person_id: "p2", started_at: "2026-10-02", person: null },
        ]),
        down(),
        okResponse([]),
      ],
      "from:offboarding_open_records": [
        okResponse([{ offboarding_id: "f1" }, { offboarding_id: "f1" }, { offboarding_id: null }]),
        okResponse([]),
        down(),
      ],
      "rpc:reassign_offboarding_records": [okResponse(2), down()],
      "rpc:complete_offboarding": [okResponse(null), down()],
    });
    const listed = await listOpenOffboardings(db, "o1");
    expect(listed.ok && listed.data.map((o) => [o.personName, o.openRecords])).toEqual([
      ["Dave", 2],
      [null, 0],
    ]);
    expect((await listOpenOffboardings(db, "o1")).ok).toBe(false);
    expect((await listOpenOffboardings(db, "o1")).ok).toBe(false);
    expect(await reassignOffboardingRecords(db, { offboardingId: "f1", toPersonId: "p3" })).toEqual(
      { ok: true, data: 2 },
    );
    expect(
      (await reassignOffboardingRecords(db, { offboardingId: "f1", toPersonId: "p3" })).ok,
    ).toBe(false);
    expect((await completeOffboarding(db, "f1")).ok).toBe(true);
    expect((await completeOffboarding(db, "f1")).ok).toBe(false);
  });
});
