import { describe, expect, it } from "vitest";
import type { XosClient } from "../src/client.ts";
import {
  archiveCredentialCategory,
  createCredentialCategory,
  credentialStatus,
  getCredentialCategory,
  getIssuedCredential,
  grantZoneAccess,
  isReplay,
  issueCredential,
  listAccessGrid,
  listAccessLevels,
  listAccessScans,
  listCredentialCategories,
  listIssuedCredentials,
  listMyCredentials,
  listProjectCredentials,
  listProjectZones,
  lookupCredentialByNumber,
  myModuleCapabilities,
  operationsProjectByKey,
  operationsProjects,
  recordScan,
  revokeCredential,
  updateCredentialCategory,
  updateCredentialWindow,
  updateZoneAccess,
  withdrawZoneAccess,
} from "../src/credentials.ts";
import { errorResponse, fakeClient, okResponse, type Response } from "./fake-client.ts";

/** The fake client with `schema()` returning itself, for canon reads. */
function client(queues: Record<string, Response[]>) {
  const fake = fakeClient(queues);
  const db = Object.assign(fake.db, { schema: () => fake.db }) as XosClient;
  return { db, calls: fake.calls };
}

const NOW = new Date("2026-10-14T12:00:00.000Z");
const denied = errorResponse("42501", "denied");
const down = errorResponse("08006", "down");

const credentialRow = {
  id: "c1",
  credential_number: "CR-000001",
  holder_person_id: "p2",
  credential_category_id: "k1",
  valid_from: "2026-10-01T00:00:00.000Z",
  valid_to: null,
  revoked_at: null,
  created_at: "2026-10-01T00:00:00.000Z",
  updated_at: "2026-10-01T00:00:00.000Z",
  holder: { full_name: "Frank Adeyemi" },
  issuer: { full_name: "Carol Nguyen" },
  revoker: null,
  category: { code: "CREW", name: "Crew", project_id: "j1", project: { project_key: "NWL" } },
};

describe("projects and zones", () => {
  it("lists projects and finds one by key", async () => {
    const row = {
      id: "j1",
      project_key: "NWL",
      name: "Northwind",
      venue_id: "v1",
      time_zone: "America/New_York",
    };
    const { db, calls } = client({
      "from:projects": [okResponse([row]), okResponse(row), okResponse(null), denied],
    });
    expect(await operationsProjects(db, "o1")).toEqual({
      ok: true,
      data: [
        { id: "j1", key: "NWL", name: "Northwind", venueId: "v1", timeZone: "America/New_York" },
      ],
    });
    expect((await operationsProjectByKey(db, "o1", "NWL")).ok).toBe(true);
    expect(await operationsProjectByKey(db, "o1", "ZZZ")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect((await operationsProjects(db, "o1")).ok).toBe(false);
    expect(calls[1]?.steps).toContainEqual(["eq", ["project_key", "NWL"]]);
  });

  it("surfaces project lookup failures", async () => {
    const { db } = client({ "from:projects": [down] });
    expect((await operationsProjectByKey(db, "o1", "NWL")).ok).toBe(false);
  });

  it("lists a venue's zones, or every zone without a venue", async () => {
    const zone = { id: "z1", code: "FOH", name: "Front of House", venue_id: "v1" };
    const { db, calls } = client({ "from:zones": [okResponse([zone]), okResponse([]), down] });
    expect((await listProjectZones(db, "o1", "v1")).ok && calls[0]?.steps).toContainEqual([
      "eq",
      ["venue_id", "v1"],
    ]);
    await listProjectZones(db, "o1", null);
    expect(calls[1]?.steps.some(([m, a]) => m === "eq" && a[0] === "venue_id")).toBe(false);
    expect((await listProjectZones(db, "o1", null)).ok).toBe(false);
  });
});

describe("categories", () => {
  const row = {
    id: "k1",
    project_id: "j1",
    code: "CREW",
    name: "Crew",
    project: { project_key: "NWL" },
    credentials: [
      { revoked_at: null, deleted_at: null },
      { revoked_at: "2026-10-02T00:00:00Z", deleted_at: null },
    ],
  };

  it("lists categories by project key then code, counting live credentials", async () => {
    const other = {
      ...row,
      id: "k2",
      code: "ALL",
      project: { project_key: "ABC" },
      credentials: null,
    };
    const { db, calls } = client({ "from:credential_categories": [okResponse([row, other])] });
    const result = await listCredentialCategories(db, { orgId: "o1", projectId: "j1" });
    expect(result.ok && result.data.map((c) => c.id)).toEqual(["k2", "k1"]);
    expect(result.ok && result.data[1]?.activeCount).toBe(1);
    expect(calls[0]?.steps).toContainEqual(["eq", ["project_id", "j1"]]);
  });

  it("reads one category and reports missing ones", async () => {
    const { db } = client({
      "from:credential_categories": [okResponse(row), okResponse(null), denied, denied],
    });
    expect((await getCredentialCategory(db, "k1")).ok).toBe(true);
    expect(await getCredentialCategory(db, "kx")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect((await getCredentialCategory(db, "k1")).ok).toBe(false);
    expect((await listCredentialCategories(db, { orgId: "o1" })).ok).toBe(false);
  });

  it("creates with an upper-case trimmed code and maps conflicts", async () => {
    const { db, calls } = client({
      "from:credential_categories": [
        okResponse({ id: "k9" }),
        errorResponse("23505", "duplicate key value violates unique constraint"),
      ],
    });
    expect(
      await createCredentialCategory(db, {
        orgId: "o1",
        projectId: "j1",
        code: " vip ",
        name: " VIP ",
      }),
    ).toEqual({ ok: true, data: { id: "k9" } });
    expect(calls[0]?.steps[0]).toEqual([
      "insert",
      [{ org_id: "o1", project_id: "j1", code: "VIP", name: "VIP" }],
    ]);
    const conflict = await createCredentialCategory(db, {
      orgId: "o1",
      projectId: "j1",
      code: "VIP",
      name: "VIP",
    });
    expect(!conflict.ok && conflict.error.kind).toBe("conflict");
  });

  it("updates and archives, answering not-found for rows out of reach", async () => {
    const { db } = client({
      "from:credential_categories": [
        okResponse([{ id: "k1" }]),
        okResponse([]),
        okResponse([{ id: "k1" }]),
        okResponse([]),
        down,
        down,
      ],
    });
    expect((await updateCredentialCategory(db, "k1", { code: "crew", name: "Crew" })).ok).toBe(
      true,
    );
    expect(await updateCredentialCategory(db, "k1", { code: "CREW", name: "Crew" })).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect((await archiveCredentialCategory(db, "k1")).ok).toBe(true);
    expect((await archiveCredentialCategory(db, "k1")).ok).toBe(false);
    expect((await updateCredentialCategory(db, "k1", { code: "A", name: "A" })).ok).toBe(false);
    expect((await archiveCredentialCategory(db, "k1")).ok).toBe(false);
  });
});

describe("issued credentials", () => {
  it("derives status from the window and revocation", () => {
    const base = { validFrom: "2026-10-01T00:00:00Z", validTo: null, revokedAt: null };
    expect(credentialStatus(base, NOW)).toBe("active");
    expect(credentialStatus({ ...base, validFrom: "2026-11-01T00:00:00Z" }, NOW)).toBe("scheduled");
    expect(credentialStatus({ ...base, validTo: "2026-10-10T00:00:00Z" }, NOW)).toBe("expired");
    expect(credentialStatus({ ...base, revokedAt: "2026-10-02T00:00:00Z" }, NOW)).toBe("revoked");
    expect(credentialStatus(base)).toBe("active");
  });

  it("lists with every filter and maps names", async () => {
    const { db, calls } = client({ "from:credentials": [okResponse([credentialRow])] });
    const result = await listIssuedCredentials(db, {
      orgId: "o1",
      projectId: "j1",
      categoryId: "k1",
      holderPersonId: "p2",
    });
    expect(result.ok && result.data[0]).toMatchObject({
      number: "CR-000001",
      holderName: "Frank Adeyemi",
      issuedByName: "Carol Nguyen",
      projectKey: "NWL",
      categoryCode: "CREW",
    });
    expect(calls[0]?.steps).toContainEqual(["eq", ["category.project_id", "j1"]]);
    expect(calls[0]?.steps).toContainEqual(["eq", ["holder_person_id", "p2"]]);
  });

  it("maps a row whose embedded rows are hidden", async () => {
    const bare = { ...credentialRow, holder: null, issuer: null, category: null };
    const { db } = client({ "from:credentials": [okResponse([bare])] });
    const result = await listProjectCredentials(db, "o1", "j1");
    expect(result.ok && result.data[0]).toMatchObject({
      holderName: null,
      categoryCode: "",
      projectKey: "",
    });
  });

  it("reads my credentials, one by id, and one by printed number", async () => {
    const { db, calls } = client({
      "from:credentials": [
        okResponse([credentialRow]),
        okResponse(credentialRow),
        okResponse(null),
        okResponse(credentialRow),
        okResponse(null),
        down,
        down,
        down,
        down,
      ],
    });
    expect((await listMyCredentials(db, "p2")).ok).toBe(true);
    expect((await getIssuedCredential(db, "c1")).ok).toBe(true);
    expect((await getIssuedCredential(db, "cx")).ok).toBe(false);
    expect((await lookupCredentialByNumber(db, "o1", " cr-000001 ")).ok).toBe(true);
    expect(calls[3]?.steps).toContainEqual(["eq", ["credential_number", "CR-000001"]]);
    expect(await lookupCredentialByNumber(db, "o1", "CR-1")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect((await listMyCredentials(db, "p2")).ok).toBe(false);
    expect((await getIssuedCredential(db, "c1")).ok).toBe(false);
    expect((await lookupCredentialByNumber(db, "o1", "CR-1")).ok).toBe(false);
    expect((await listIssuedCredentials(db, { orgId: "o1" })).ok).toBe(false);
  });

  it("issues, surfacing the self-issue refusal by rule", async () => {
    const { db, calls } = client({
      "from:credentials": [
        okResponse({ id: "c2", credential_number: "CR-000002" }),
        errorResponse(
          "XR001",
          "credential_self_issue: A person never issues their own credential or certification.",
          "credential_self_issue",
        ),
      ],
    });
    expect(
      await issueCredential(db, {
        orgId: "o1",
        projectId: "j1",
        categoryId: "k1",
        holderPersonId: "p2",
        validFrom: "2026-10-14T00:00:00Z",
      }),
    ).toEqual({ ok: true, data: { id: "c2", number: "CR-000002" } });
    expect(calls[0]?.steps[0]?.[1]).toEqual([
      {
        org_id: "o1",
        project_id: "j1",
        credential_category_id: "k1",
        holder_person_id: "p2",
        engagement_id: null,
        valid_from: "2026-10-14T00:00:00Z",
        valid_to: null,
      },
    ]);
    const refused = await issueCredential(db, {
      orgId: "o1",
      projectId: "j1",
      categoryId: "k1",
      holderPersonId: "p1",
    });
    expect(!refused.ok && refused.error).toEqual({
      kind: "refusal",
      rule: "credential_self_issue",
      message: "A person never issues their own credential or certification.",
    });
  });

  it("changes the window and revokes", async () => {
    const { db } = client({
      "from:credentials": [
        okResponse([{ id: "c1" }]),
        okResponse([]),
        okResponse([{ id: "c1" }]),
        okResponse([]),
        down,
        down,
      ],
    });
    const window = { validFrom: "2026-10-01T00:00:00Z", validTo: null };
    expect((await updateCredentialWindow(db, "c1", window)).ok).toBe(true);
    expect((await updateCredentialWindow(db, "c1", window)).ok).toBe(false);
    expect((await revokeCredential(db, "c1")).ok).toBe(true);
    expect((await revokeCredential(db, "c1")).ok).toBe(false);
    expect((await updateCredentialWindow(db, "c1", window)).ok).toBe(false);
    expect((await revokeCredential(db, "c1")).ok).toBe(false);
  });
});

describe("access grid", () => {
  it("reads canon access levels in canon order", async () => {
    const { db } = client({
      "from:std_enumeration": [
        okResponse([
          { record_id: "ENM-036", enum_code: "ACC_FULL", enum_label: "Full Access", sort_order: 1 },
          { record_id: "ENM-099", enum_code: null, enum_label: null, sort_order: null },
        ]),
        down,
      ],
    });
    const result = await listAccessLevels(db);
    expect(result.ok && result.data).toEqual([
      { id: "ENM-036", code: "ACC_FULL", label: "Full Access", sortOrder: 1 },
      { id: "ENM-099", code: "ENM-099", label: "ENM-099", sortOrder: 0 },
    ]);
    expect((await listAccessLevels(db)).ok).toBe(false);
  });

  it("lists, grants, changes and withdraws grid rows", async () => {
    const row = {
      id: "g1",
      credential_category_id: "k1",
      zone_id: "z1",
      access_level_enum_id: "ENM-036",
      window_starts_at: "2026-10-01T00:00:00Z",
      window_ends_at: "2026-10-20T00:00:00Z",
      zone: { code: "FOH", name: "Front of House" },
      category: { project_id: "j1" },
    };
    const { db } = client({
      "from:access_grid": [
        okResponse([row, { ...row, id: "g2", zone: null }]),
        okResponse({ id: "g3" }),
        okResponse([{ id: "g1" }]),
        okResponse([]),
        okResponse([{ id: "g1" }]),
        okResponse([]),
        down,
        down,
        down,
        down,
      ],
    });
    const listed = await listAccessGrid(db, "o1", "j1");
    expect(listed.ok && listed.data.map((g) => g.zoneCode)).toEqual(["FOH", ""]);
    const input = {
      orgId: "o1",
      projectId: "j1",
      categoryId: "k1",
      zoneId: "z1",
      accessLevelId: "ENM-036",
      windowStartsAt: "2026-10-01T00:00:00Z",
      windowEndsAt: "2026-10-20T00:00:00Z",
    };
    expect(await grantZoneAccess(db, input)).toEqual({ ok: true, data: { id: "g3" } });
    expect((await updateZoneAccess(db, "g1", input)).ok).toBe(true);
    expect((await updateZoneAccess(db, "g1", input)).ok).toBe(false);
    expect((await withdrawZoneAccess(db, "g1")).ok).toBe(true);
    expect((await withdrawZoneAccess(db, "g1")).ok).toBe(false);
    expect((await listAccessGrid(db, "o1", "j1")).ok).toBe(false);
    expect((await grantZoneAccess(db, input)).ok).toBe(false);
    expect((await updateZoneAccess(db, "g1", input)).ok).toBe(false);
    expect((await withdrawZoneAccess(db, "g1")).ok).toBe(false);
  });
});

describe("scans", () => {
  const scanRow = {
    id: "s1",
    credential_id: "c1",
    zone_id: "z1",
    scanned_at: "2026-10-14T12:00:00Z",
    result: "Granted",
    zone: { code: "FOH", name: "Front of House" },
    credential: {
      credential_number: "CR-000001",
      holder: { full_name: "Frank Adeyemi" },
      category: { code: "CREW", project_id: "j1", project: { project_key: "NWL" } },
    },
  };

  it("lists the scan log newest first with filters", async () => {
    const { db, calls } = client({
      "from:access_scans": [
        okResponse([scanRow, { ...scanRow, id: "s2", zone: null, credential: null }]),
        down,
      ],
    });
    const result = await listAccessScans(db, {
      orgId: "o1",
      projectId: "j1",
      credentialId: "c1",
      result: "Denied",
      limit: 10,
    });
    expect(result.ok && result.data[0]).toMatchObject({
      holderName: "Frank Adeyemi",
      zoneCode: "FOH",
      projectKey: "NWL",
    });
    expect(result.ok && result.data[1]?.credentialNumber).toBe("");
    expect(calls[0]?.steps).toContainEqual(["order", ["scanned_at", { ascending: false }]]);
    expect(calls[0]?.steps).toContainEqual(["limit", [10]]);
    expect((await listAccessScans(db, { orgId: "o1" })).ok).toBe(false);
  });

  it("records a scan through app.record_scan and passes the offline contract", async () => {
    const decision = {
      id: "s9",
      credential_id: "c1",
      credential_number: "CR-000001",
      holder_name: "Frank Adeyemi",
      category_code: null,
      zone_id: "z1",
      zone_code: "FOH",
      scanned_at: "2026-10-14T12:00:00Z",
      result: "Denied",
      replayed: true,
    };
    const { db, calls } = client({
      "rpc:record_scan": [
        okResponse([decision]),
        okResponse([]),
        errorResponse(
          "XR001",
          "credential_unknown: No credential of this organization matches the scanned code.",
          "credential_unknown",
        ),
      ],
    });
    const result = await recordScan(db, {
      zoneId: "z1",
      credentialNumber: "CR-000001",
      id: "01920000-0000-7000-8000-00000000a001",
      deviceAt: "2026-10-14T11:00:00Z",
      offlineResult: "Granted",
    });
    expect(result).toEqual({
      ok: true,
      data: {
        id: "s9",
        credentialId: "c1",
        credentialNumber: "CR-000001",
        holderName: "Frank Adeyemi",
        categoryCode: "",
        zoneId: "z1",
        zoneCode: "FOH",
        scannedAt: "2026-10-14T12:00:00Z",
        result: "Denied",
        replayed: true,
      },
    });
    expect(calls[0]?.steps[0]).toEqual([
      "args",
      [
        {
          p_zone_id: "z1",
          p_credential_number: "CR-000001",
          p_id: "01920000-0000-7000-8000-00000000a001",
          p_device_scanned_at: "2026-10-14T11:00:00Z",
          p_offline_result: "Granted",
        },
      ],
    ]);
    expect((await recordScan(db, { zoneId: "z1", credentialId: "c1" })).ok).toBe(false);
    const refused = await recordScan(db, { zoneId: "z1", credentialNumber: "CR-9" });
    expect(!refused.ok && refused.error.kind === "refusal" && refused.error.rule).toBe(
      "credential_unknown",
    );
  });

  it("recognizes a replayed client id", () => {
    const duplicate = { code: "23505", message: 'duplicate key value violates "incidents_pkey"' };
    expect(isReplay(duplicate, "x")).toBe(true);
    expect(isReplay(duplicate, undefined)).toBe(false);
    expect(isReplay({ code: "23505", message: "incidents_number_key" }, "x")).toBe(false);
  });
});

describe("module capabilities", () => {
  it("returns the capabilities held on a project", async () => {
    const { db } = client({
      "rpc:my_capabilities_on_project": [
        okResponse(["credentials.credential.issue"]),
        okResponse(null),
        down,
      ],
    });
    const held = await myModuleCapabilities(db, "j1");
    expect(held.ok && held.data.has("credentials.credential.issue")).toBe(true);
    const none = await myModuleCapabilities(db, "j1");
    expect(none.ok && none.data.size).toBe(0);
    expect((await myModuleCapabilities(db, "j1")).ok).toBe(false);
  });
});
