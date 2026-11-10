import type * as Offerings from "@xos/data/offerings";
import type { StoredSettingValue } from "@xos/data/settings";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { settingByKey } from "@/lib/settings/registry";

/**
 * R3 (owner decision 7). Project Settings, Offerings shows each offering's project value, else the
 * org value, else Not Offered, and says which; a value the org locked is read-only there. The rule
 * form has the six fields of an audience rule, and the actions send only valid rules. The database
 * checks projects.settings.write and every constraint again; these tests cover what Atlas shows
 * and sends.
 */
const state = vi.hoisted(() => ({ ctx: null as unknown }));
const data = vi.hoisted(() => ({
  create: vi.fn(async () => ({ ok: true, data: { id: "r1" } }) as unknown),
  remove: vi.fn(async () => ({ ok: true, data: null }) as unknown),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/shell/context", () => ({ getOrgContext: async () => state.ctx }));
vi.mock("@xos/data/offerings", async (importOriginal) => ({
  ...(await importOriginal<typeof Offerings>()),
  createOfferingRule: data.create,
  removeOfferingRule: data.remove,
}));

const { projectOfferingField, projectOfferingSettings } =
  await import("@/components/projects/project-offerings");
const { OfferingRuleForm } = await import("@/components/projects/offering-rule-form");
const { createOfferingRuleAction, removeOfferingRuleAction } =
  await import("@/components/projects/offering-actions");

const t = (key: string) => key;
const travel = settingByKey("offerings.travel");
if (!travel) throw new Error("R3 registers offerings.travel.");

function value(
  scopeKind: "Organization" | "Project",
  text: string,
  locked = false,
): StoredSettingValue {
  return {
    id: `${scopeKind}-${text}`,
    key: "offerings.travel",
    scopeKind,
    scopeId: scopeKind === "Project" ? "project-1" : "org-1",
    value: text,
    locked,
  };
}

function form(values: Record<string, string>): FormData {
  const result = new FormData();
  for (const [key, v] of Object.entries(values)) result.set(key, v);
  return result;
}

describe("Project Settings, Offerings", () => {
  it("shows the nine offerings, project scope only", () => {
    const keys = projectOfferingSettings().map((s) => s.key);
    expect(keys.filter((k) => k.startsWith("offerings."))).toEqual([
      "offerings.travel",
      "offerings.lodging",
      "offerings.catering",
      "offerings.parking",
      "offerings.uniforms",
      "offerings.per_diem",
      "offerings.radios",
      "offerings.carts",
      "offerings.guest_list",
    ]);
    for (const def of projectOfferingSettings()) expect(def.scopes).toContain("project");
  });

  it("names where each value comes from", () => {
    const none = projectOfferingField(t, travel, [], "project-1", true);
    expect(none).toMatchObject({
      initial: "not-offered",
      sourceText: "settings.source.projectDefault",
      setHere: false,
      lockedByOrg: false,
      canEdit: true,
    });
    const fromOrg = projectOfferingField(
      t,
      travel,
      [value("Organization", "provided")],
      "project-1",
      true,
    );
    expect(fromOrg).toMatchObject({
      initial: "provided",
      sourceText: "settings.source.projectOrganization",
    });
    const here = projectOfferingField(
      t,
      travel,
      [value("Organization", "provided"), value("Project", "reimbursed")],
      "project-1",
      true,
    );
    expect(here).toMatchObject({
      initial: "reimbursed",
      sourceText: "settings.source.projectProject",
      setHere: true,
    });
    expect(here.options.map((o) => o.value)).toEqual([
      "not-offered",
      "provided",
      "reimbursed",
      "buyout",
    ]);
  });

  it("keeps a value the org locked read-only", () => {
    const locked = projectOfferingField(
      t,
      travel,
      [value("Organization", "not-offered", true), value("Project", "provided")],
      "project-1",
      true,
    );
    expect(locked).toMatchObject({
      initial: "not-offered",
      sourceText: "settings.source.organizationLocked",
      lockedByOrg: true,
      setHere: false,
    });
  });

  it("is read-only without projects.settings.write", () => {
    expect(projectOfferingField(t, travel, [], "project-1", false).canEdit).toBe(false);
  });
});

describe("the offering rule form", () => {
  const options = [{ value: "a", label: "A" }];
  const html = renderToStaticMarkup(
    createElement(OfferingRuleForm, {
      scope: { org: "northwind-live", projectId: "", projectKey: "" },
      copy: {
        offering: "Offering",
        roleType: "Role type",
        vendorClass: "Vendor class",
        mode: "Mode",
        capPerEngagement: "Cap per engagement",
        capPerPerson: "Cap per person",
        capHelp: "Blank for none",
        addRule: "Add rule",
        added: "Added",
        remove: "Remove",
        errors: {},
      },
      offerings: options,
      roleTypes: options,
      vendorClasses: options,
      modes: options,
    }),
  );

  it("has exactly six fields", () => {
    const selects = html.match(/<select[^>]*name="([^"]+)"/g) ?? [];
    const inputs = (html.match(/<input[^>]*>/g) ?? []).filter((i) => !i.includes('type="hidden"'));
    expect(selects.map((s) => /name="([^"]+)"/.exec(s)?.[1])).toEqual([
      "offering",
      "roleType",
      "vendorClassId",
      "mode",
    ]);
    expect(inputs.map((i) => /name="([^"]+)"/.exec(i)?.[1])).toEqual([
      "capPerEngagement",
      "capPerPerson",
    ]);
  });
});

describe("the offering rule actions", () => {
  beforeEach(() => {
    state.ctx = {
      org: { id: "org-1", slug: "northwind-live" },
      viewer: { db: {} },
      capabilities: new Set(["projects.settings.write"]),
    };
    data.create.mockClear();
    data.remove.mockClear();
  });

  const rule = {
    org: "northwind-live",
    projectId: "01920000-0000-7000-8000-000000000107",
    projectKey: "DEMO",
    offering: "Travel",
    roleType: "Crew",
    vendorClassId: "",
    mode: "Not Offered",
    capPerEngagement: "",
    capPerPerson: "",
  };

  it("sends a valid rule, blank caps and audiences as NULL", async () => {
    expect(await createOfferingRuleAction({}, form(rule))).toMatchObject({ ok: true });
    expect(data.create).toHaveBeenCalledWith(
      {},
      {
        orgId: "org-1",
        projectId: "01920000-0000-7000-8000-000000000107",
        offering: "Travel",
        roleType: "Crew",
        vendorClassId: null,
        mode: "Not Offered",
        capPerEngagement: null,
        capPerPerson: null,
      },
    );
  });

  it("refuses an unknown offering or a cap out of range before sending", async () => {
    expect(await createOfferingRuleAction({}, form({ ...rule, offering: "Boats" }))).toMatchObject({
      error: "invalid",
    });
    expect(
      await createOfferingRuleAction(
        {},
        form({ ...rule, mode: "Provided", capPerPerson: "10001" }),
      ),
    ).toMatchObject({ error: "invalid" });
    expect(data.create).not.toHaveBeenCalled();
  });

  it("explains a duplicate audience and another org's class", async () => {
    data.create.mockResolvedValueOnce({ ok: false, error: { kind: "conflict", message: "dup" } });
    expect(await createOfferingRuleAction({}, form(rule))).toMatchObject({ error: "conflict" });
    data.create.mockResolvedValueOnce({
      ok: false,
      error: { kind: "refusal", rule: "cross_org_reference", message: "other org" },
    });
    expect(await createOfferingRuleAction({}, form(rule))).toMatchObject({ error: "crossOrg" });
  });

  it("removes a rule by id", async () => {
    const id = "01920000-0000-7000-8000-0000000000aa";
    expect(
      await removeOfferingRuleAction({}, form({ org: "northwind-live", id, projectKey: "" })),
    ).toMatchObject({
      ok: true,
    });
    expect(data.remove).toHaveBeenCalledWith({}, id);
    expect(
      await removeOfferingRuleAction({}, form({ org: "northwind-live", id: "x" })),
    ).toMatchObject({
      error: "notFound",
    });
  });
});
