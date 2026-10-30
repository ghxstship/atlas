import { describe, expect, it } from "vitest";
import {
  createClientOrg,
  endSupportSession,
  getDefaultBrand,
  getEffectiveBrand,
  getPartnerAgreement,
  getPartnerOf,
  grantSupportSession,
  listClientOrgs,
  listClientPrices,
  listClientUsage,
  listClientVenues,
  listSupportSessions,
  listWholesaleStatements,
  monthStart,
  runWholesaleBilling,
  saveDefaultBrand,
  setClientPrice,
  EMPTY_DEFAULT_BRAND,
} from "../src/partner.ts";
import {
  explainAccess,
  parseViewAsCookie,
  previewOrgCapabilities,
  viewAsCapabilities,
} from "../src/access.ts";
import { moduleClient, stepsOf } from "./module-client.ts";

const ok = (data: unknown) => ({ data, error: null });
const refused = (rule: string) => ({
  data: null,
  error: { code: "XR001", message: `${rule}: Refused.`, hint: rule },
});
const denied = { data: null, error: { code: "42501", message: "denied" } };

describe("partner console repository", () => {
  it("lists client orgs with billing facts and the open support session", async () => {
    const { db, calls } = moduleClient({
      "rpc:partner_client_orgs": [
        ok([
          {
            org_id: "c1",
            name: "Tidewater Events",
            slug: "tidewater",
            plan_code: "core",
            subscription_state: "active",
            seats: 3,
            field_members: 1,
            created_at: "2026-10-01T00:00:00Z",
            owner_joined: true,
            support_session_id: "s1",
            support_session_ends_at: "2026-10-02T00:00:00Z",
          },
        ]),
      ],
    });
    const result = await listClientOrgs(db, "p1");
    expect(result).toEqual({
      ok: true,
      data: [
        {
          id: "c1",
          name: "Tidewater Events",
          slug: "tidewater",
          planCode: "core",
          subscriptionState: "active",
          seats: 3,
          fieldMembers: 1,
          createdAt: "2026-10-01T00:00:00Z",
          ownerJoined: true,
          supportSessionId: "s1",
          supportSessionEndsAt: "2026-10-02T00:00:00Z",
        },
      ],
    });
    expect(stepsOf(calls[0], "args")[0]).toEqual([{ p_partner_org_id: "p1" }]);
  });

  it("creates a client org and returns the Owner invitation once", async () => {
    const { db } = moduleClient({
      "rpc:create_client_organization": [
        ok([{ org_id: "c1", invite_id: "i1", invite_token: "tok" }]),
        ok([]),
        refused("org_slug_taken"),
      ],
    });
    const input = {
      partnerOrgId: "p1",
      name: "Tide",
      slug: "tide",
      ownerEmail: "o@example.com",
      planCode: "core",
    };
    expect(await createClientOrg(db, input)).toEqual({
      ok: true,
      data: { orgId: "c1", inviteId: "i1", inviteToken: "tok" },
    });
    expect((await createClientOrg(db, input)).ok).toBe(false);
    const third = await createClientOrg(db, input);
    expect(third.ok === false && third.error.kind).toBe("refusal");
  });

  it("reads, creates and updates the default brand", async () => {
    const row = {
      id: "b1",
      accent_hex: "#1F6FEB",
      neutral_tint_hex: null,
      font_family: null,
      radius_scale: "Rounded",
      email_sender_name: null,
      support_email: null,
      allow_client_override: false,
    };
    const { db, calls } = moduleClient({
      "from:partner_default_brands": [
        ok([]),
        ok([]),
        ok([{ id: "b1" }]),
        ok([row]),
        ok([row]),
        ok([{ id: "b1" }]),
        denied,
      ],
    });
    expect(await getDefaultBrand(db, "p1")).toEqual({ ok: true, data: EMPTY_DEFAULT_BRAND });
    const input = { ...EMPTY_DEFAULT_BRAND, accentHex: "#1F6FEB" };
    expect(await saveDefaultBrand(db, "p1", input)).toEqual({ ok: true, data: "b1" });
    expect(stepsOf(calls[2], "insert")[0]?.[0]).toMatchObject({
      org_id: "p1",
      accent_hex: "#1F6FEB",
    });
    const read = await getDefaultBrand(db, "p1");
    expect(read.ok && read.data.allowClientOverride).toBe(false);
    expect(await saveDefaultBrand(db, "p1", input)).toEqual({ ok: true, data: "b1" });
    expect(stepsOf(calls[5], "update")).toHaveLength(1);
    expect((await saveDefaultBrand(db, "p1", input)).ok).toBe(false);
  });

  it("reads the effective brand, or null when the caller may not", async () => {
    const { db } = moduleClient({
      "rpc:effective_brand": [
        ok([
          {
            accent_hex: "#1F6FEB",
            font_family: null,
            radius_scale: "Rounded",
            inherited: true,
            override_allowed: true,
          },
        ]),
        ok([]),
      ],
    });
    expect(await getEffectiveBrand(db, "c1")).toEqual({
      ok: true,
      data: {
        accentHex: "#1F6FEB",
        fontFamily: null,
        radiusScale: "Rounded",
        inherited: true,
        overrideAllowed: true,
      },
    });
    expect(await getEffectiveBrand(db, "x")).toEqual({ ok: true, data: null });
  });

  it("sets a client price by inserting, then updating", async () => {
    const { db, calls } = moduleClient({
      "from:partner_client_prices": [
        ok([]),
        ok([{ id: "pr1" }]),
        ok([{ id: "pr1", client_org_id: "c1", monthly_minor: 6500, currency_code: "USD" }]),
        ok([{ id: "pr1" }]),
        denied,
      ],
    });
    const input = { partnerOrgId: "p1", clientOrgId: "c1", monthlyMinor: 6500, currency: "USD" };
    expect(await setClientPrice(db, input)).toEqual({ ok: true, data: "pr1" });
    expect(await setClientPrice(db, { ...input, monthlyMinor: 7000 })).toEqual({
      ok: true,
      data: "pr1",
    });
    expect(stepsOf(calls[3], "update")[0]).toEqual([{ monthly_minor: 7000, currency_code: "USD" }]);
    expect((await listClientPrices(db, "p1")).ok).toBe(false);
  });

  it("reads the agreement and statements, and runs wholesale billing", async () => {
    const { db } = moduleClient({
      "from:partner_agreements": [
        ok([{ wholesale_discount_bps: 2000, currency_code: "USD", signed_on: "2026-10-01" }]),
        ok([]),
      ],
      "from:wholesale_statements": [
        ok([
          {
            id: "w1",
            period_start: "2026-10-01",
            currency_code: "USD",
            wholesale_discount_bps: 2000,
            client_count: 2,
            list_total_minor: 4900,
            wholesale_total_minor: 3920,
            unpriced_count: 1,
            wholesale_statement_lines: [
              {
                client_org_id: "c1",
                plan_code: "core",
                list_minor: 4900,
                wholesale_minor: 3920,
                client_price_minor: 6500,
              },
              {
                client_org_id: "c2",
                plan_code: "core",
                list_minor: null,
                wholesale_minor: null,
                client_price_minor: null,
              },
            ],
          },
        ]),
      ],
      "rpc:run_wholesale_billing": [ok("w2"), refused("wholesale_statement_exists")],
      "rpc:partner_client_usage": [ok([{ org_id: "c1", meter_code: "emails_sent", quantity: 12 }])],
    });
    expect(await getPartnerAgreement(db, "p1")).toEqual({
      ok: true,
      data: { discountBps: 2000, currency: "USD", signedOn: "2026-10-01" },
    });
    expect(await getPartnerAgreement(db, "p1")).toEqual({ ok: true, data: null });
    const statements = await listWholesaleStatements(db, "p1");
    expect(statements.ok && statements.data[0]?.lines[1]?.listMinor).toBeNull();
    expect(await runWholesaleBilling(db, "p1", "2026-10-01")).toEqual({ ok: true, data: "w2" });
    const again = await runWholesaleBilling(db, "p1", "2026-10-01");
    expect(again.ok === false && again.error.kind === "refusal" && again.error.rule).toBe(
      "wholesale_statement_exists",
    );
    expect(await listClientUsage(db, "p1", "2026-10-01")).toEqual({
      ok: true,
      data: [{ orgId: "c1", meter: "emails_sent", quantity: 12 }],
    });
  });

  it("reads a client org's partner", async () => {
    const { db } = moduleClient({
      "from:organizations": [ok([{ parent_org_id: "p1" }]), ok([{ parent_org_id: null }]), denied],
    });
    expect(await getPartnerOf(db, "c1")).toEqual({ ok: true, data: "p1" });
    expect(await getPartnerOf(db, "o1")).toEqual({ ok: true, data: null });
    expect((await getPartnerOf(db, "o1")).ok).toBe(false);
  });

  it("formats the first of the month in UTC", () => {
    expect(monthStart(new Date("2026-03-31T23:59:00Z"))).toBe("2026-03-01");
    expect(monthStart(new Date("2026-12-05T00:00:00Z"))).toBe("2026-12-01");
  });

  it("grants, lists and ends support sessions, and reads client venues under RLS", async () => {
    const { db, calls } = moduleClient({
      "rpc:grant_support_session": [ok("s1")],
      "rpc:end_support_session": [ok("s1")],
      "from:support_sessions": [
        ok([
          {
            id: "s1",
            org_id: "c1",
            grantee_org_id: "p1",
            reason: "Help.",
            starts_at: "2026-10-16T10:00:00Z",
            ends_at: "2026-10-16T14:00:00Z",
            ended_at: null,
          },
          {
            id: "s0",
            org_id: "c1",
            grantee_org_id: "p1",
            reason: "Old.",
            starts_at: "2026-10-01T10:00:00Z",
            ends_at: "2026-10-01T14:00:00Z",
            ended_at: "2026-10-01T11:00:00Z",
          },
        ]),
      ],
      "from:venues": [ok([{ id: "v1", name: "Boathouse", locality: null }]), denied],
    });
    expect(await grantSupportSession(db, { orgId: "c1", hours: 4, reason: "Help." })).toEqual({
      ok: true,
      data: "s1",
    });
    const sessions = await listSupportSessions(db, "c1", new Date("2026-10-16T12:00:00Z"));
    expect(sessions.ok && sessions.data.map((s) => s.open)).toEqual([true, false]);
    expect(await endSupportSession(db, "s1")).toEqual({ ok: true, data: "s1" });
    expect(await listClientVenues(db, "c1")).toEqual({
      ok: true,
      data: [{ id: "v1", name: "Boathouse", locality: null }],
    });
    expect((await listClientVenues(db, "c1")).ok).toBe(false);
    // A client's archived venues are left out (A124).
    expect(
      stepsOf(
        calls.find((c) => c.target === "from:venues"),
        "is",
      ),
    ).toContainEqual(["archived_at", null]);
  });
});

describe("access transparency repository", () => {
  it("lists preview roles and the capped preview", async () => {
    const { db } = moduleClient({
      "rpc:view_as_capabilities": [
        ok([
          {
            capability_code: "crew.time.write",
            role_reach: "own",
            viewer_reach: "organization",
            preview_reach: "own",
          },
          {
            capability_code: "crew.shift.read",
            role_reach: "organization",
            viewer_reach: "organization",
            preview_reach: "organization",
          },
          {
            capability_code: "org.secret.read",
            role_reach: "organization",
            viewer_reach: null,
            preview_reach: null,
          },
        ]),
      ],
    });
    const preview = await viewAsCapabilities(db, "o1", "r6");
    expect(preview.ok && [...previewOrgCapabilities(preview.data)]).toEqual(["crew.shift.read"]);
  });

  it("explains a record, and parses the View as cookie for its org only", async () => {
    const { db } = moduleClient({
      "rpc:explain_access": [
        ok([{ path_kind: "Membership", label: "Demo", detail: "admin", valid_to: null }]),
        denied,
      ],
    });
    expect(await explainAccess(db, "projects", "p1")).toEqual({
      ok: true,
      data: [{ kind: "Membership", label: "Demo", detail: "admin", validTo: null }],
    });
    const hidden = await explainAccess(db, "projects", "p2");
    expect(hidden.ok === false && hidden.error.kind).toBe("not-found");
    const role = "01920000-0000-7000-8000-00000000a106";
    expect(parseViewAsCookie(`demo:${role}`, "demo")).toBe(role);
    expect(parseViewAsCookie(`other:${role}`, "demo")).toBeNull();
    expect(parseViewAsCookie("demo:not-a-role", "demo")).toBeNull();
    expect(parseViewAsCookie(undefined, "demo")).toBeNull();
  });
});
