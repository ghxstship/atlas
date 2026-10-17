import { describe, expect, it } from "vitest";
import {
  exploreOrganizations,
  getApplicationSharedProfile,
  parseSharedRate,
  shareProfileSections,
} from "../src/profile-sharing.ts";
import { commercialClient, errorResponse, okResponse } from "./commercial-fake.ts";

describe("profile sharing", () => {
  it("shares sections, adding to a share or starting one", async () => {
    const { db, calls } = commercialClient({
      "rpc:share_profile_sections": [
        okResponse("s1"),
        okResponse("s2"),
        errorResponse("XR001", "profile_share_sections: Choose."),
      ],
    });
    expect(
      await shareProfileSections(db, { orgId: "o1", profileShareId: "s1", sections: ["headline"] }),
    ).toEqual({ ok: true, data: { profileShareId: "s1" } });
    expect(calls[0]?.steps[0]).toEqual([
      "args",
      [{ p_org_id: "o1", p_profile_share_id: "s1", p_sections: ["headline"] }],
    ]);
    await shareProfileSections(db, { orgId: "o1", profileShareId: null, sections: ["rates"] });
    expect(calls[1]?.steps[0]).toEqual([
      "args",
      [{ p_org_id: "o1", p_profile_share_id: null, p_sections: ["rates"] }],
    ]);
    const refused = await shareProfileSections(db, {
      orgId: "o1",
      profileShareId: null,
      sections: [],
    });
    expect(!refused.ok && refused.error.kind).toBe("refusal");
  });

  it("reads what an application shared, or nothing", async () => {
    const { db } = commercialClient({
      "from:applications": [
        okResponse({ profile_share_id: "s1" }),
        okResponse({ profile_share_id: null }),
      ],
      "from:profile_shares": [okResponse({ shared_at: "2027-06-01T00:00:00Z", revoked_at: null })],
      "from:profile_share_fields": [
        okResponse([
          { field_key: "email", field_value: "crew@example.com" },
          { field_key: "profile.headline", field_value: "Rigger" },
        ]),
      ],
    });
    expect(await getApplicationSharedProfile(db, "a1")).toEqual({
      ok: true,
      data: {
        sharedAt: "2027-06-01T00:00:00Z",
        revoked: false,
        fields: [
          { key: "email", value: "crew@example.com" },
          { key: "profile.headline", value: "Rigger" },
        ],
      },
    });
    expect(await getApplicationSharedProfile(db, "a2")).toEqual({ ok: true, data: null });
  });

  it("parses a shared rate and leaves anything else as text", () => {
    expect(parseSharedRate('{"amount_minor":45000,"currency":"USD","unit":"Day"}')).toEqual({
      amountMinor: 45000,
      currency: "USD",
      unit: "Day",
    });
    expect(parseSharedRate("not json")).toBeNull();
    expect(parseSharedRate('{"amount_minor":"x"}')).toBeNull();
    expect(parseSharedRate(null)).toBeNull();
  });

  it("lists Public organization profiles for Explore", async () => {
    const { db, calls } = commercialClient({
      "rpc:explore_organizations": [
        okResponse([
          {
            handle: "demo-productions",
            name: "Demo Productions",
            about: "Festival production.",
            logo_path: null,
            verified: true,
            verified_domain: "demo-productions.example.com",
            open_opportunities: 3,
            indexable: false,
          },
        ]),
        okResponse(null),
      ],
    });
    const listed = await exploreOrganizations(db, "festival");
    expect(listed.ok && listed.data[0]?.verifiedDomain).toBe("demo-productions.example.com");
    expect(calls[0]?.steps[0]).toEqual(["args", [{ p_query: "festival", p_limit: 24 }]]);
    expect(await exploreOrganizations(db, null)).toEqual({ ok: true, data: [] });
  });
});
