import type { SupabaseClient } from "@supabase/supabase-js";
import { getMessages } from "@xos/i18n";
import { describe, expect, it, vi } from "vitest";
import type { OrgContext } from "../src/data/identity";
import {
  accountRoleKey,
  organizationRows,
  readDefaultOrg,
  roleLabelKey,
} from "../src/settings/organizations";
import { readDefaultOrgRow, readMyProfile, readMyRows } from "../src/settings/reads";

/**
 * Settings, Organizations and the identity reads in Compass (A110, ADR 0070): every membership and engagement, the
 * open and default orgs, and the person's own rows read with their session.
 */

function context(orgId: string, orgName: string, kind: "member" | "engaged"): OrgContext {
  return {
    orgId,
    orgName,
    kind,
    identity: {
      personId: "person-1",
      displayName: "Ana Ruiz",
      audience: kind === "member" ? "field" : "crew",
      capabilities: [],
      membershipId: kind === "member" ? `m-${orgId}` : null,
      engagements:
        kind === "engaged"
          ? [
              {
                id: "e1",
                orgId,
                orgName,
                projectId: "p1",
                projectName: "Summer Series",
                roleType: "crew",
                state: "Active",
              },
              {
                id: "e2",
                orgId,
                orgName,
                projectId: "p2",
                projectName: "Winter Gala",
                roleType: "crew",
                state: "Active",
              },
            ]
          : [],
    },
    scope: {} as OrgContext["scope"],
    projects: [],
  };
}

describe("the organizations list", () => {
  const contexts = [
    context("o-zed", "Zed Events", "member"),
    context("o-acme", "Acme Live", "engaged"),
    context("o-north", "Northwind", "member"),
  ];

  it("puts memberships first, then orgs the person works with, each by name", () => {
    const rows = organizationRows({
      contexts,
      openOrgId: "o-zed",
      defaultOrgId: "o-north",
      roles: new Map([["o-north", [{ code: "manager", name: null }]]]),
      brandName: (orgId) => (orgId === "o-zed" ? "ZED" : undefined),
    });
    expect(rows.map((r) => [r.orgId, r.name, r.kind])).toEqual([
      ["o-north", "Northwind", "member"],
      ["o-zed", "ZED", "member"],
      ["o-acme", "Acme Live", "engaged"],
    ]);
    expect(rows.find((r) => r.orgId === "o-zed")).toMatchObject({ open: true, isDefault: false });
    expect(rows.find((r) => r.orgId === "o-north")).toMatchObject({
      open: false,
      isDefault: true,
      canLeave: true,
      roles: [{ code: "manager", name: null }],
    });
    expect(rows.find((r) => r.orgId === "o-acme")).toMatchObject({
      canLeave: false,
      engagements: 2,
      roles: [],
    });
  });

  it("labels a system role from the catalog and a custom role by its own name", () => {
    expect(roleLabelKey({ code: "field", name: null })).toEqual({ key: "shell.roles.field" });
    expect(roleLabelKey({ code: "custom", name: "Head Rigger" })).toEqual({ name: "Head Rigger" });
    expect(accountRoleKey("Account Owner")).toBe("gateway.enums.accountRole.accountOwner");
    const es = getMessages("es-US") as unknown as {
      gateway: { enums: { accountRole: Record<string, string> } };
    };
    for (const role of ["Account Owner", "Account Admin", "Account Finance", "Account Member"]) {
      const key = accountRoleKey(role).split(".").at(-1) ?? "";
      expect(typeof es.gateway.enums.accountRole[key], role).toBe("string");
    }
  });
});

/** A stand-in for the query builder: records the calls and answers with the scripted reply. */
function client(reply: { data: unknown; error: { message: string } | null }, rpc?: unknown) {
  const calls: string[] = [];
  const chain = (table: string) => {
    const c = {
      select: (columns: string) => (calls.push(`select ${table} ${columns}`), c),
      eq: (col: string, value: unknown) => (calls.push(`eq ${col}=${String(value)}`), c),
      is: (col: string, value: unknown) => (calls.push(`is ${col}=${String(value)}`), c),
      order: () => c,
      maybeSingle: () => Promise.resolve(reply),
      then: (resolve: (value: typeof reply) => unknown) => Promise.resolve(reply).then(resolve),
    };
    return c;
  };
  const fake = {
    from: chain,
    schema: () => ({ from: chain }),
    rpc: vi.fn(async () => rpc ?? { data: "prof-1", error: null }),
  } as unknown as SupabaseClient;
  return { fake, calls };
}

describe("the identity reads", () => {
  it("reads the default org the person chose, or none", async () => {
    expect(
      await readDefaultOrg(client({ data: { org_id: "o-north" }, error: null }).fake, "u1"),
    ).toBe("o-north");
    expect(await readDefaultOrg(client({ data: null, error: null }).fake, "u1")).toBeNull();
    expect(
      await readDefaultOrg(client({ data: null, error: { message: "x" } }).fake, "u1"),
    ).toBeNull();
    expect(
      await readDefaultOrgRow(
        client({ data: [{ org_id: "o-north", selected_at: "t" }], error: null }).fake,
        "u1",
      ),
    ).toEqual([{ id: "default", org_id: "o-north", selected_at: "t" }]);
    expect(await readDefaultOrgRow(client({ data: [], error: null }).fake, "u1")).toEqual([]);
  });

  it("ensures the profile before reading it, and reads only live rows of the person's own lists", async () => {
    const profile = client({ data: [{ id: "prof-1", handle: "ana-ruiz" }], error: null });
    expect(await readMyProfile(profile.fake)).toEqual([{ id: "prof-1", handle: "ana-ruiz" }]);
    expect(profile.calls).toEqual(["select person_profiles *", "eq id=prof-1"]);

    const list = client({
      data: [{ id: "s1", cat_urid: "0101.01.02" }, { cat_urid: "no id" }],
      error: null,
    });
    expect(await readMyRows(list.fake, "person_skills", "person-1")).toEqual([
      { id: "s1", cat_urid: "0101.01.02" },
    ]);
    expect(list.calls).toEqual([
      "select person_skills *",
      "eq person_id=person-1",
      "is deleted_at=null",
    ]);
  });

  it("keeps what the device has when a read fails", async () => {
    expect(
      await readMyRows(client({ data: null, error: { message: "x" } }).fake, "t", "p"),
    ).toBeNull();
    const noProfile = client(
      { data: [], error: null },
      { data: null, error: { message: "denied" } },
    );
    expect(await readMyProfile(noProfile.fake)).toBeNull();
  });
});
