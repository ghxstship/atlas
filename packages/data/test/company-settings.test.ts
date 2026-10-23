import { describe, expect, it } from "vitest";
import {
  addOfferedCapability,
  addServiceRegion,
  getAccountNotificationDefaults,
  listOfferedCapabilities,
  listServiceRegions,
  myOwnerRoleId,
  removeProfileEntry,
  saveAccountNotificationDefaults,
} from "../src/company-settings.ts";
import { getTeam, listWorkspaceMembershipIds } from "../src/org-setup.ts";
import { listMyNotificationPreferences } from "../src/party-notifications.ts";
import { commercialClient, errorResponse, okResponse } from "./commercial-fake.ts";

/** Gateway company settings and the workspace and team pages (A86, RRR-131; 0710, 0860, 1434). */

const denied = () => errorResponse("42501", "denied");

describe("company regions and capabilities (0860)", () => {
  it("lists, adds and removes service regions", async () => {
    const { db } = commercialClient({
      "from:organization_service_regions": [
        okResponse([{ id: "r1", jurisdiction_id: "US-FL" }]),
        denied(),
        okResponse({ id: "r2" }),
        errorResponse("23505", "duplicate"),
        okResponse([{ id: "r1" }]),
        okResponse([]),
        denied(),
      ],
    });
    expect(await listServiceRegions(db, "acct-1")).toEqual({
      ok: true,
      data: [{ id: "r1", jurisdictionId: "US-FL" }],
    });
    expect((await listServiceRegions(db, "acct-1")).ok).toBe(false);
    expect(await addServiceRegion(db, "acct-1", "US-NY")).toEqual({ ok: true, data: { id: "r2" } });
    const duplicate = await addServiceRegion(db, "acct-1", "US-FL");
    expect(!duplicate.ok && duplicate.error.kind).toBe("conflict");
    expect((await removeProfileEntry(db, "organization_service_regions", "r1")).ok).toBe(true);
    expect((await removeProfileEntry(db, "organization_service_regions", "r1")).ok).toBe(false);
    expect((await removeProfileEntry(db, "organization_service_regions", "r1")).ok).toBe(false);
  });

  it("lists capabilities with their canon names and adds one", async () => {
    const { db } = commercialClient({
      "from:organization_profile_capabilities": [
        okResponse([
          { id: "c1", cat_urid: "5000.01.01" },
          { id: "c2", cat_urid: "5000.01.02" },
        ]),
        okResponse([]),
        denied(),
        okResponse({ id: "c3" }),
        denied(),
      ],
      "from:xpms:dim_category": [okResponse([{ cat_urid: "5000.01.01", category: "Lighting" }])],
    });
    const capabilities = await listOfferedCapabilities(db, "acct-1");
    expect(capabilities.ok && capabilities.data).toEqual([
      { id: "c1", categoryUrid: "5000.01.01", categoryName: "Lighting" },
      { id: "c2", categoryUrid: "5000.01.02", categoryName: null },
    ]);
    expect(await listOfferedCapabilities(db, "acct-1")).toEqual({ ok: true, data: [] });
    expect((await listOfferedCapabilities(db, "acct-1")).ok).toBe(false);
    expect(await addOfferedCapability(db, "acct-1", "5000.01.03")).toEqual({
      ok: true,
      data: { id: "c3" },
    });
    expect((await addOfferedCapability(db, "acct-1", "5000.01.03")).ok).toBe(false);
  });

  it("finds the caller's own Account Owner role", async () => {
    const { db } = commercialClient({
      "from:account_membership_roles": [okResponse([{ id: "role-1" }]), okResponse([]), denied()],
    });
    expect(await myOwnerRoleId(db, "m1")).toEqual({ ok: true, data: "role-1" });
    expect(await myOwnerRoleId(db, "m1")).toEqual({ ok: true, data: null });
    expect((await myOwnerRoleId(db, "m1")).ok).toBe(false);
  });
});

describe("company notification defaults (1434)", () => {
  it("reads one account's defaults, or every account's, and drops cells it does not know", async () => {
    const { db, calls } = commercialClient({
      "from:account_notification_defaults": [
        okResponse([
          { category_code: "finance", channel: "Email", enabled: false },
          { category_code: "safety", channel: "Email", enabled: true },
          { category_code: "finance", channel: "SMS", enabled: true },
        ]),
        okResponse([]),
        denied(),
      ],
      "rpc:set_account_notification_defaults": [okResponse(null), denied()],
    });
    expect(await getAccountNotificationDefaults(db, "acct-1")).toEqual({
      ok: true,
      data: [{ category: "finance", channel: "Email", enabled: false }],
    });
    expect(calls[0]?.steps).toContainEqual(["eq", ["org_id", "acct-1"]]);
    expect(await getAccountNotificationDefaults(db)).toEqual({ ok: true, data: [] });
    expect(calls[1]?.steps.some(([step]) => step === "eq")).toBe(false);
    expect((await getAccountNotificationDefaults(db)).ok).toBe(false);
    const defaults = [{ category: "finance" as const, channel: "Push" as const, enabled: false }];
    expect((await saveAccountNotificationDefaults(db, "acct-1", defaults)).ok).toBe(true);
    expect(calls.at(-1)?.steps).toContainEqual([
      "args",
      [{ p_account_id: "acct-1", p_defaults: defaults }],
    ]);
    expect((await saveAccountNotificationDefaults(db, "acct-1", defaults)).ok).toBe(false);
  });

  it("shows the company default where the person never chose", async () => {
    const { db } = commercialClient({
      "from:person_notification_preferences": [
        okResponse([{ category_code: "finance", channel: "Push", enabled: true }]),
      ],
    });
    const prefs = await listMyNotificationPreferences(db, [
      { category: "finance", channel: "Email", enabled: false },
      { category: "finance", channel: "Push", enabled: false },
    ]);
    expect(prefs.ok && prefs.data).toEqual([
      { category: "finance", channel: "Email", enabled: false },
      { category: "finance", channel: "Push", enabled: true },
    ]);
  });
});

describe("workspace and team pages", () => {
  it("lists a workspace's memberships", async () => {
    const { db } = commercialClient({
      "from:workspace_members": [okResponse([{ membership_id: "m1" }]), denied()],
    });
    expect(await listWorkspaceMembershipIds(db, "ws-1")).toEqual({ ok: true, data: ["m1"] });
    expect((await listWorkspaceMembershipIds(db, "ws-1")).ok).toBe(false);
  });

  it("reads one team of the org with its live members", async () => {
    const { db } = commercialClient({
      "from:teams": [
        okResponse({
          id: "t1",
          name: "Riggers",
          description: null,
          team_members: [
            { membership_id: "m1", deleted_at: null },
            { membership_id: "m2", deleted_at: "2026-10-01" },
          ],
        }),
        okResponse({ id: "t2", name: "Audio", description: "Sound", team_members: null }),
        okResponse(null),
        denied(),
      ],
    });
    expect(await getTeam(db, "org-1", "t1")).toEqual({
      ok: true,
      data: { id: "t1", name: "Riggers", description: null, membershipIds: ["m1"] },
    });
    const audio = await getTeam(db, "org-1", "t2");
    expect(audio.ok && audio.data.membershipIds).toEqual([]);
    const gone = await getTeam(db, "org-1", "t3");
    expect(!gone.ok && gone.error.kind).toBe("not-found");
    expect((await getTeam(db, "org-1", "t1")).ok).toBe(false);
  });
});
