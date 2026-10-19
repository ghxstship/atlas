import { describe, expect, it } from "vitest";
import {
  addAllowedNetwork,
  addLegalEntity,
  blockProfile,
  breakGlassOpen,
  cancelAccessReview,
  decideAccessReviewItem,
  endBreakGlass,
  listAccessReviewCampaigns,
  listAccessReviewItems,
  listAllowedNetworks,
  listBreakGlassSessions,
  listLegalEntities,
  listMyBlocks,
  makeLegalEntityPrimary,
  networkAccess,
  openAccessReview,
  removeAllowedNetwork,
  removeLegalEntity,
  setLegalEntityTaxIdentifier,
  startBreakGlass,
  unblock,
  addProjectMemberRole,
  listProjectMemberRoles,
  listProjectShares,
  listSharePartners,
  removeProjectMemberRole,
  revokeProjectShare,
  shareProject,
  listSharedWithMe,
} from "../src/access-controls.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

const REFUSED = (rule: string) => errorResponse("XR001", `${rule}: Refused.`, rule);

describe("legal entities", () => {
  it("lists from the masked view and maps the mask", async () => {
    const { db, calls } = fakeClient({
      "from:org_legal_entities_masked": [
        okResponse([
          {
            id: "le1",
            legal_name: "Northwind Live LLC",
            country_code: "US",
            tax_identifier: null,
            tax_identifier_last4: "6789",
            is_masked: true,
            fiscal_year_start_month: 1,
            base_currency: "USD",
            is_primary: true,
          },
        ]),
      ],
    });
    const listed = await listLegalEntities(db, "org");
    expect(listed.ok && listed.data[0]).toMatchObject({
      legalName: "Northwind Live LLC",
      taxIdentifierMasked: true,
      taxIdentifierLast4: "6789",
      isPrimary: true,
    });
    expect(calls[0]?.steps).toContainEqual(["eq", ["org_id", "org"]]);
  });

  it("adds an entity and sets its tax identifier through the RPC, refusals included", async () => {
    const { db, calls } = fakeClient({
      "from:org_legal_entities": [okResponse({ id: "le2" }), okResponse({ id: "le3" })],
      "rpc:set_org_legal_entity_tax_identifier": [
        okResponse(null),
        REFUSED("tax_identifier_format"),
      ],
    });
    const input = {
      orgId: "org",
      legalName: "Northwind Live Ltd",
      countryCode: "GB",
      fiscalYearStartMonth: 4,
      baseCurrency: "GBP",
      taxIdentifier: "GB123456789",
    };
    expect(await addLegalEntity(db, input)).toEqual({ ok: true, data: "le2" });
    expect(calls[1]?.steps[0]).toEqual([
      "args",
      [{ p_legal_entity_id: "le2", p_tax_identifier: "GB123456789" }],
    ]);
    const refused = await addLegalEntity(db, { ...input, taxIdentifier: "12" });
    expect(refused.ok === false && refused.error.kind).toBe("refusal");
  });

  it("marks primary, clears a tax identifier and removes, with not-found for a gone row", async () => {
    const { db } = fakeClient({
      "from:org_legal_entities": [okResponse([{ id: "le1" }]), okResponse([])],
      "rpc:set_org_legal_entity_tax_identifier": [okResponse(null)],
    });
    expect(await makeLegalEntityPrimary(db, "le1")).toEqual({ ok: true, data: "le1" });
    expect(await setLegalEntityTaxIdentifier(db, "le1", null)).toEqual({ ok: true, data: "le1" });
    const gone = await removeLegalEntity(db, "le9");
    expect(gone.ok === false && gone.error.kind).toBe("not-found");
  });
});

describe("IP allow-list", () => {
  it("answers network access and treats no row as allowed", async () => {
    const { db } = fakeClient({
      "rpc:network_access": [
        okResponse([{ enforced: true, allowed: false, covered: false }]),
        okResponse([]),
      ],
    });
    expect(await networkAccess(db, "org", "198.51.100.7")).toEqual({
      ok: true,
      data: { enforced: true, allowed: false, covered: false },
    });
    expect(await networkAccess(db, "org", null)).toEqual({
      ok: true,
      data: { enforced: false, allowed: true, covered: false },
    });
  });

  it("lists, adds and removes networks", async () => {
    const { db } = fakeClient({
      "from:org_ip_allowlist": [
        okResponse([{ id: "n1", cidr: "203.0.113.0/24", label: "Office" }]),
        okResponse({ id: "n2" }),
        REFUSED("plan_feature_ip_allowlist"),
        okResponse([{ id: "n1" }]),
        okResponse([]),
      ],
    });
    const listed = await listAllowedNetworks(db, "org");
    expect(listed.ok && listed.data).toEqual([
      { id: "n1", cidr: "203.0.113.0/24", label: "Office" },
    ]);
    const input = { orgId: "org", cidr: "198.51.100.0/24", label: "VPN" };
    expect(await addAllowedNetwork(db, input)).toEqual({ ok: true, data: "n2" });
    const refused = await addAllowedNetwork(db, input);
    expect(refused.ok === false && refused.error.kind).toBe("refusal");
    expect(await removeAllowedNetwork(db, "n1")).toEqual({ ok: true, data: "n1" });
    expect((await removeAllowedNetwork(db, "n9")).ok).toBe(false);
  });
});

describe("access reviews", () => {
  it("lists campaigns, opens one and cancels it", async () => {
    const { db } = fakeClient({
      "from:access_review_campaigns": [
        okResponse([
          {
            id: "c1",
            name: "Q4 Access Review",
            due_on: "2026-11-02",
            auto_remove_unreviewed: true,
            campaign_state: "Active",
            opened_at: "2026-10-19T12:00:00Z",
            closed_at: null,
          },
        ]),
        okResponse({ id: "c2" }),
        okResponse([{ id: "c1" }]),
        okResponse([]),
      ],
    });
    const listed = await listAccessReviewCampaigns(db, "org");
    expect(listed.ok && listed.data[0]).toMatchObject({
      state: "Active",
      autoRemoveUnreviewed: true,
    });
    expect(
      await openAccessReview(db, {
        orgId: "org",
        name: "Q1",
        dueOn: "2027-01-15",
        autoRemoveUnreviewed: false,
      }),
    ).toEqual({ ok: true, data: "c2" });
    expect(await cancelAccessReview(db, "c1")).toEqual({ ok: true, data: "c1" });
    expect((await cancelAccessReview(db, "c9")).ok).toBe(false);
  });

  it("lists items unreviewed first and records decisions", async () => {
    const item = (id: string, name: string, decision: string | null) => ({
      id,
      decision,
      decided_at: decision === null ? null : "2026-10-20T09:00:00Z",
      flagged_at: null,
      membership_roles: {
        roles: { code: "member", name: null, band: 4 },
        memberships: { person_id: `p-${id}`, people: { full_name: name } },
      },
    });
    const { db } = fakeClient({
      "from:access_review_items": [
        okResponse([
          item("i1", "Alice", "Confirmed"),
          item("i2", "Dave", null),
          item("i3", "Bob", null),
        ]),
        okResponse([{ id: "i2" }]),
        REFUSED("sod_self_review"),
        okResponse([]),
      ],
    });
    const listed = await listAccessReviewItems(db, "c1");
    expect(listed.ok && listed.data.map((i) => i.personName)).toEqual(["Bob", "Dave", "Alice"]);
    expect(await decideAccessReviewItem(db, "i2", "Removed")).toEqual({ ok: true, data: "i2" });
    const refused = await decideAccessReviewItem(db, "i3", "Confirmed");
    expect(refused.ok === false && refused.error.kind === "refusal" && refused.error.rule).toBe(
      "sod_self_review",
    );
    expect((await decideAccessReviewItem(db, "i9", "Confirmed")).ok).toBe(false);
  });
});

describe("break-glass", () => {
  it("lists sessions, starts and ends one, and knows when one is open", async () => {
    const session = {
      id: "b1",
      person_id: "p1",
      reason: "Payroll export failed during show day.",
      started_at: "2026-10-19T12:00:00Z",
      expires_at: "2026-10-19T13:00:00Z",
      ended_at: null,
    };
    const { db } = fakeClient({
      "from:break_glass_sessions": [okResponse([session])],
      "rpc:start_break_glass": [okResponse(session), REFUSED("step_up_required")],
      "rpc:end_break_glass": [okResponse(session)],
    });
    const listed = await listBreakGlassSessions(db, "org");
    const first = listed.ok ? listed.data[0] : undefined;
    expect(first && breakGlassOpen(first, new Date("2026-10-19T12:30:00Z"))).toBe(true);
    expect(first && breakGlassOpen(first, new Date("2026-10-19T13:30:00Z"))).toBe(false);
    expect(await startBreakGlass(db, "org", session.reason)).toEqual({ ok: true, data: "b1" });
    expect((await startBreakGlass(db, "org", session.reason)).ok).toBe(false);
    expect(await endBreakGlass(db, "b1")).toEqual({ ok: true, data: "b1" });
  });
});

describe("blocks", () => {
  it("lists, blocks by handle and unblocks", async () => {
    const { db } = fakeClient({
      "rpc:my_blocks": [
        okResponse([
          { id: "k1", blocked_kind: "person", blocked_handle: "xavier", blocked_name: "Xavier" },
          { id: "k2", blocked_kind: "organization", blocked_handle: null, blocked_name: null },
        ]),
      ],
      "rpc:block_profile": [okResponse("k3"), REFUSED("block_handle_unknown")],
      "from:blocks": [okResponse([{ id: "k1" }]), okResponse([])],
    });
    const listed = await listMyBlocks(db);
    expect(listed.ok && listed.data.map((b) => b.kind)).toEqual(["person", "organization"]);
    expect(await blockProfile(db, "person", "xavier")).toEqual({ ok: true, data: "k3" });
    expect((await blockProfile(db, "person", "nobody")).ok).toBe(false);
    expect(await unblock(db, "k1")).toEqual({ ok: true, data: "k1" });
    expect((await unblock(db, "k9")).ok).toBe(false);
  });
});

describe("project roles and shares", () => {
  it("lists, adds and removes project roles on assignments", async () => {
    const { db, calls } = fakeClient({
      "from:project_member_roles": [
        okResponse([{ id: "r1", project_member_id: "pm1", project_role: "Field" }]),
        okResponse({ id: "r2" }),
        REFUSED("sod_self_grant"),
        okResponse([{ id: "r2" }]),
        okResponse([]),
      ],
    });
    const listed = await listProjectMemberRoles(db, "prj");
    expect(listed.ok && listed.data).toEqual([{ id: "r1", projectMemberId: "pm1", role: "Field" }]);
    expect(calls[0]?.steps).toContainEqual(["eq", ["project_members.project_id", "prj"]]);
    expect(await addProjectMemberRole(db, "pm1", "Field Supervisor")).toEqual({
      ok: true,
      data: "r2",
    });
    expect((await addProjectMemberRole(db, "pm2", "Producer")).ok).toBe(false);
    expect(await removeProjectMemberRole(db, "r2")).toEqual({ ok: true, data: "r2" });
    expect((await removeProjectMemberRole(db, "r9")).ok).toBe(false);
  });

  it("lists partners once each, shares a project and revokes the share", async () => {
    const { db } = fakeClient({
      "from:counterparties": [
        okResponse([
          { organization_id: "o2", counterparty_name: "Tidewater Events" },
          { organization_id: "o1", counterparty_name: "Bluewater Partners" },
          { organization_id: "o1", counterparty_name: "Bluewater Partners" },
          { organization_id: null, counterparty_name: "Walk-in" },
        ]),
      ],
      "from:project_shares": [
        okResponse([
          { id: "s1", partner_organization_id: "o1", project_role: "Coordinator", valid_to: null },
        ]),
        okResponse({ id: "s2" }),
        REFUSED("project_share_own_org"),
        okResponse([{ id: "s1" }]),
        okResponse([]),
      ],
    });
    const partners = await listSharePartners(db, "org");
    expect(partners.ok && partners.data.map((p) => p.name)).toEqual([
      "Bluewater Partners",
      "Tidewater Events",
    ]);
    const shares = await listProjectShares(db, "prj");
    expect(shares.ok && shares.data[0]?.projectRole).toBe("Coordinator");
    const input = { projectId: "prj", partnerOrganizationId: "o2", projectRole: "Field" as const };
    expect(await shareProject(db, input)).toEqual({ ok: true, data: "s2" });
    expect((await shareProject(db, input)).ok).toBe(false);
    expect(await revokeProjectShare(db, "s1")).toEqual({ ok: true, data: "s1" });
    expect((await revokeProjectShare(db, "s9")).ok).toBe(false);
  });
});

describe("projects shared with me", () => {
  it("maps the projection", async () => {
    const { db } = fakeClient({
      "rpc:shared_projects": [
        okResponse([
          {
            project_share_id: "s1",
            project_id: "p1",
            owner_org_id: "o1",
            owner_org_name: "Northwind Live",
            partner_organization_id: "o2",
            project_key: "NWL",
            name: "Northwind Summer Series",
            project_state: "Active",
            production_state: "Planning",
            current_phase_code: "3",
            starts_on: "2027-06-01",
            ends_on: null,
            time_zone: "America/New_York",
            project_role: "Coordinator",
            valid_to: null,
          },
        ]),
        REFUSED("anything"),
      ],
    });
    const listed = await listSharedWithMe(db);
    expect(listed.ok && listed.data[0]).toMatchObject({
      ownerOrgName: "Northwind Live",
      projectKey: "NWL",
    });
    expect((await listSharedWithMe(db)).ok).toBe(false);
  });
});
