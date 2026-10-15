import { describe, expect, it } from "vitest";
import {
  addFavorite,
  addOrgDomain,
  clearPersonalSetting,
  clearSetting,
  EMPTY_BRAND,
  type BrandInput,
  getOrgBrand,
  getPersona,
  listBrandFonts,
  listDisabledModules,
  listFavorites,
  listOrgDomains,
  listOrgLegalAcceptances,
  listSettingValues,
  recordLegalAcceptances,
  removeFavorite,
  removeOrgDomain,
  resolveSettings,
  saveOrgBrand,
  setModuleEnabled,
  setPersonalSetting,
  setSetting,
} from "../src/settings.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

const refusal = () =>
  errorResponse("XR001", "setting_locked: The org locked it.", "setting_locked");
const brandRow = {
  id: "b1",
  display_name: "Northwind",
  logo_light_path: null,
  logo_dark_path: null,
  favicon_path: null,
  app_icon_path: null,
  accent_hex: "#2F6FEB",
  neutral_tint_hex: null,
  font_family: "Inter",
  radius_scale: "Default",
  email_sender_name: null,
  support_email: null,
  legal_entity_name: null,
  suppress_powered_by: true,
};

describe("resolved settings", () => {
  it("maps each row to its typed value and source", async () => {
    const { db, calls } = fakeClient({
      "rpc:resolve_settings": [
        okResponse([
          {
            setting_key: "a",
            value_text: "x",
            value_boolean: null,
            value_integer: null,
            source: "Organization",
            locked: true,
            value_type: "Text",
          },
          {
            setting_key: "b",
            value_text: null,
            value_boolean: false,
            value_integer: null,
            source: "Default",
            locked: false,
            value_type: "Boolean",
          },
          {
            setting_key: "c",
            value_text: null,
            value_boolean: null,
            value_integer: 3,
            source: "Personal",
            locked: false,
            value_type: "Integer",
          },
          {
            setting_key: "d",
            value_text: null,
            value_boolean: null,
            value_integer: null,
            source: "Default",
            locked: false,
            value_type: "Text",
          },
        ]),
      ],
    });
    const result = await resolveSettings(db, {
      orgId: "o1",
      workspaceId: "w1",
      projectId: "p1",
      teamId: "t1",
    });
    expect(result.ok && result.data.get("a")).toEqual({
      key: "a",
      value: "x",
      source: "Organization",
      locked: true,
    });
    expect(result.ok && result.data.get("b")?.value).toBe(false);
    expect(result.ok && result.data.get("c")?.value).toBe(3);
    expect(result.ok && result.data.get("d")?.value).toBeNull();
    expect(calls[0]?.steps[0]).toEqual([
      "args",
      [{ p_org_id: "o1", p_project_id: "p1", p_team_id: "t1", p_workspace_id: "w1" }],
    ]);
  });

  it("returns errors", async () => {
    const { db } = fakeClient({ "rpc:resolve_settings": [errorResponse("42501", "denied")] });
    expect(await resolveSettings(db, { orgId: "o1" })).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
  });
});

describe("setting values", () => {
  it("lists stored values", async () => {
    const { db } = fakeClient({
      "from:setting_values": [
        okResponse([
          {
            id: "v1",
            setting_key: "a",
            scope_kind: "Workspace",
            scope_id: "w1",
            value_text: "x",
            value_boolean: null,
            value_integer: null,
            locked: false,
          },
        ]),
        errorResponse("08000", "down"),
      ],
    });
    const result = await listSettingValues(db, "o1");
    expect(result.ok && result.data[0]).toEqual({
      id: "v1",
      key: "a",
      scopeKind: "Workspace",
      scopeId: "w1",
      value: "x",
      locked: false,
    });
    expect((await listSettingValues(db, "o1")).ok).toBe(false);
  });

  it("sets each value type in its own column and returns refusals", async () => {
    const { db, calls } = fakeClient({
      "rpc:set_setting": [okResponse("v1"), okResponse("v2"), okResponse("v3"), refusal()],
    });
    const base = { orgId: "o1", key: "k", scopeKind: "Organization" as const, scopeId: "o1" };
    expect(await setSetting(db, { ...base, value: "x", locked: true })).toEqual({
      ok: true,
      data: { id: "v1" },
    });
    await setSetting(db, { ...base, value: true });
    await setSetting(db, { ...base, value: 4 });
    expect(calls.map((c) => c.steps[0]?.[1])).toEqual([
      [expect.objectContaining({ p_value_text: "x", p_locked: true })],
      [expect.objectContaining({ p_value_boolean: true, p_locked: false })],
      [expect.objectContaining({ p_value_integer: 4 })],
    ]);
    const refused = await setSetting(db, { ...base, value: "y" });
    expect(!refused.ok && refused.error).toEqual({
      kind: "refusal",
      rule: "setting_locked",
      message: "The org locked it.",
    });
  });

  it("clears values", async () => {
    const { db } = fakeClient({
      "rpc:clear_setting": [okResponse(true), errorResponse("42501", "no")],
    });
    const input = { orgId: "o1", key: "k", scopeKind: "Workspace" as const, scopeId: "w1" };
    expect(await clearSetting(db, input)).toEqual({ ok: true, data: true });
    expect((await clearSetting(db, input)).ok).toBe(false);
  });

  it("sets and clears personal values", async () => {
    const { db, calls } = fakeClient({
      "rpc:set_personal_setting": [okResponse("p1"), refusal()],
      "rpc:clear_personal_setting": [okResponse(false), errorResponse("08000", "down")],
    });
    expect(await setPersonalSetting(db, { key: "me.theme", value: "dark", orgId: "o1" })).toEqual({
      ok: true,
      data: { id: "p1" },
    });
    expect(calls[0]?.steps[0]).toEqual([
      "args",
      [{ p_setting_key: "me.theme", p_org_id: "o1", p_value_text: "dark" }],
    ]);
    expect((await setPersonalSetting(db, { key: "me.theme", value: "dark" })).ok).toBe(false);
    expect(await clearPersonalSetting(db, { key: "me.theme" })).toEqual({ ok: true, data: false });
    expect((await clearPersonalSetting(db, { key: "me.theme", orgId: "o1" })).ok).toBe(false);
  });
});

describe("legal acceptances", () => {
  it("records documents with their versions and the client IP", async () => {
    const { db, calls } = fakeClient({
      "rpc:record_legal_acceptances": [okResponse(2), errorResponse("42501", "no")],
    });
    const documents = [
      { slug: "terms-of-service", version: "1.0.0" },
      { slug: "data-processing-agreement", version: "1.0.0" },
    ];
    expect(
      await recordLegalAcceptances(db, { orgId: "o1", documents, clientIp: "203.0.113.7" }),
    ).toEqual({ ok: true, data: 2 });
    expect(calls[0]?.steps[0]).toEqual([
      "args",
      [
        {
          p_org_id: "o1",
          p_document_slugs: ["terms-of-service", "data-processing-agreement"],
          p_document_versions: ["1.0.0", "1.0.0"],
          p_client_ip: "203.0.113.7",
        },
      ],
    ]);
    expect((await recordLegalAcceptances(db, { orgId: null, documents, clientIp: null })).ok).toBe(
      false,
    );
  });

  it("lists an org's acceptances with who accepted", async () => {
    const { db } = fakeClient({
      "from:legal_acceptances": [
        okResponse([
          {
            document_slug: "terms-of-service",
            document_version: "1.0.0",
            accepted_at: "2026-10-01",
            person_id: "p1",
            person: { full_name: "Ada" },
          },
          {
            document_slug: "terms-of-service",
            document_version: "0.9.0",
            accepted_at: "2026-09-01",
            person_id: "p2",
            person: null,
          },
        ]),
        errorResponse("08000", "down"),
      ],
    });
    const result = await listOrgLegalAcceptances(db, "o1");
    expect(result.ok && result.data.map((a) => a.personName)).toEqual(["Ada", null]);
    expect((await listOrgLegalAcceptances(db, "o1")).ok).toBe(false);
  });
});

describe("brand", () => {
  it("reads the saved brand or the empty brand", async () => {
    const { db } = fakeClient({
      "from:org_brands": [okResponse(brandRow), okResponse(null), errorResponse("08000", "down")],
    });
    const saved = await getOrgBrand(db, "o1");
    expect(saved.ok && saved.data.accentHex).toBe("#2F6FEB");
    expect(saved.ok && saved.data.suppressPoweredBy).toBe(true);
    expect(await getOrgBrand(db, "o1")).toEqual({ ok: true, data: EMPTY_BRAND });
    expect((await getOrgBrand(db, "o1")).ok).toBe(false);
  });

  it("inserts the first brand and updates it afterwards", async () => {
    const { db, calls } = fakeClient({
      "from:org_brands": [
        okResponse(null),
        okResponse(null),
        okResponse({ id: "b1" }),
        refusal(),
        errorResponse("08000", "down"),
      ],
    });
    const input: BrandInput = { ...EMPTY_BRAND, accentHex: "#2F6FEB" };
    expect(await saveOrgBrand(db, "o1", input)).toEqual({ ok: true, data: null });
    expect(calls[1]?.steps[0]?.[0]).toBe("insert");
    const refused = await saveOrgBrand(db, "o1", input);
    expect(calls[3]?.steps[0]?.[0]).toBe("update");
    expect(!refused.ok && refused.error.kind).toBe("refusal");
    expect((await saveOrgBrand(db, "o1", input)).ok).toBe(false);
  });

  it("lists brand fonts", async () => {
    const { db } = fakeClient({
      "from:brand_fonts": [
        okResponse([
          { font_family: "Inter", sort_order: 1 },
          { font_family: null, sort_order: 2 },
        ]),
        errorResponse("08000", "down"),
      ],
    });
    expect(await listBrandFonts(db)).toEqual({ ok: true, data: ["Inter"] });
    expect((await listBrandFonts(db)).ok).toBe(false);
  });
});

describe("domains", () => {
  it("lists, adds and removes domains", async () => {
    const { db, calls } = fakeClient({
      "from:org_domains": [
        okResponse([
          {
            id: "d1",
            hostname: "gateway.example.com",
            purpose: "Gateway",
            verification_state: "Pending",
            verification_token: "t",
            verified_at: null,
            auto_join_role_id: null,
          },
        ]),
        errorResponse("08000", "down"),
        okResponse(null),
        refusal(),
        okResponse([{ id: "d1" }]),
        okResponse([]),
        errorResponse("08000", "down"),
      ],
    });
    const listed = await listOrgDomains(db, "o1");
    expect(listed.ok && listed.data[0]?.state).toBe("Pending");
    expect((await listOrgDomains(db, "o1")).ok).toBe(false);
    expect(
      await addOrgDomain(db, {
        orgId: "o1",
        hostname: " Gateway.Example.com ",
        purpose: "Gateway",
      }),
    ).toEqual({ ok: true, data: null });
    expect(calls[2]?.steps[0]?.[1]).toEqual([
      expect.objectContaining({ hostname: "gateway.example.com", auto_join_role_id: null }),
    ]);
    expect(
      (
        await addOrgDomain(db, {
          orgId: "o1",
          hostname: "x.example.com",
          purpose: "Atlas",
          autoJoinRoleId: "r1",
        })
      ).ok,
    ).toBe(false);
    expect(await removeOrgDomain(db, "d1")).toEqual({ ok: true, data: null });
    expect(await removeOrgDomain(db, "d2")).toEqual({ ok: false, error: { kind: "not-found" } });
    expect((await removeOrgDomain(db, "d3")).ok).toBe(false);
  });
});

describe("modules and favorites", () => {
  it("lists disabled modules and switches them", async () => {
    const { db } = fakeClient({
      "from:org_module_states": [
        okResponse([{ module_code: "logistics" }, { module_code: "hospitality" }]),
        errorResponse("08000", "down"),
      ],
      "rpc:set_module_enabled": [okResponse("m1"), errorResponse("42501", "no")],
    });
    expect(await listDisabledModules(db, "o1")).toEqual({
      ok: true,
      data: ["hospitality", "logistics"],
    });
    expect((await listDisabledModules(db, "o1")).ok).toBe(false);
    expect(
      await setModuleEnabled(db, { orgId: "o1", module: "hospitality", enabled: false }),
    ).toEqual({ ok: true, data: null });
    expect(
      (await setModuleEnabled(db, { orgId: "o1", module: "hospitality", enabled: true })).ok,
    ).toBe(false);
  });

  it("lists, adds and removes favorites", async () => {
    const { db } = fakeClient({
      "from:favorites": [
        okResponse([{ id: "f1", node_id: "finance.budgets", target_id: null, sort_order: 0 }]),
        errorResponse("08000", "down"),
        okResponse(null),
        refusal(),
        okResponse([{ id: "f1" }]),
        okResponse([]),
        errorResponse("08000", "down"),
      ],
    });
    const listed = await listFavorites(db, { orgId: "o1", personId: "p1" });
    expect(listed.ok && listed.data).toEqual([
      { id: "f1", nodeId: "finance.budgets", targetId: null, sortOrder: 0 },
    ]);
    expect((await listFavorites(db, { orgId: "o1", personId: "p1" })).ok).toBe(false);
    expect((await addFavorite(db, { orgId: "o1", personId: "p1", nodeId: "schedule" })).ok).toBe(
      true,
    );
    expect(
      (
        await addFavorite(db, {
          orgId: "o1",
          personId: "p1",
          nodeId: "schedule",
          targetId: "r1",
          sortOrder: 2,
        })
      ).ok,
    ).toBe(false);
    expect(await removeFavorite(db, "f1")).toEqual({ ok: true, data: null });
    expect(await removeFavorite(db, "f2")).toEqual({ ok: false, error: { kind: "not-found" } });
    expect((await removeFavorite(db, "f3")).ok).toBe(false);
  });
});

describe("persona", () => {
  it("prefers the value kept for the org", async () => {
    const { db } = fakeClient({
      "from:personal_setting_values": [
        okResponse([
          { org_id: null, value_text: "producer" },
          { org_id: "o1", value_text: "finance-lead" },
        ]),
        okResponse([{ org_id: null, value_text: "producer" }]),
        okResponse([]),
        errorResponse("08000", "down"),
      ],
    });
    expect(await getPersona(db, "o1")).toEqual({ ok: true, data: "finance-lead" });
    expect(await getPersona(db, "o1")).toEqual({ ok: true, data: "producer" });
    expect(await getPersona(db, "o1")).toEqual({ ok: true, data: null });
    expect((await getPersona(db, "o1")).ok).toBe(false);
  });
});
