import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import {
  CAPABILITIES_YAML_PATH,
  CapabilityRegistryError,
  ORG_SETTINGS_SECTIONS,
  REQUIRED_MODULES,
  ROLE_CODES,
  SPEC_NAMED_CAPABILITIES,
  allCapabilities,
  grantsByRole,
  loadCapabilityRegistry,
  parseCapabilityRegistry,
} from "../../src/capabilities/index.ts";

const sourceText = readFileSync(CAPABILITIES_YAML_PATH, "utf8");

interface RawCapability {
  code: string;
  class: string;
  description: string;
  own?: boolean;
  roles?: Record<string, string>;
}
interface RawModule {
  code: string;
  group: string;
  project_scoped: boolean;
  visibility: Record<string, string>;
  capabilities: RawCapability[];
}
interface RawRegistry {
  version: number;
  roles: { code: string; band: number; description: string }[];
  modules: RawModule[];
  settings_sections: { section: string; capability: string }[];
  personal_settings_sections: { section: string; capability: string }[];
}

function raw(): RawRegistry {
  return parse(sourceText) as RawRegistry;
}

function moduleOf(doc: RawRegistry, code: string): RawModule {
  const found = doc.modules.find((m) => m.code === code);
  if (found === undefined) throw new Error(`module ${code} not in registry`);
  return found;
}

function capabilityOf(doc: RawRegistry, code: string): RawCapability {
  const found = doc.modules.flatMap((m) => m.capabilities).find((c) => c.code === code);
  if (found === undefined) throw new Error(`capability ${code} not in registry`);
  return found;
}

function issuesFor(doc: RawRegistry): readonly string[] {
  try {
    parseCapabilityRegistry(stringify(doc));
  } catch (error) {
    if (error instanceof CapabilityRegistryError) return error.issues;
    throw error;
  }
  return [];
}

describe("capabilities.yaml", () => {
  const registry = loadCapabilityRegistry();
  const byRole = grantsByRole(registry);
  const codes = allCapabilities(registry).map((c) => c.code);

  it("covers every module and settings section", () => {
    expect(registry.modules.map((m) => m.code).sort()).toEqual([...REQUIRED_MODULES].sort());
    expect(registry.settingsSections.map((s) => s.section)).toEqual([...ORG_SETTINGS_SECTIONS]);
    expect(registry.personalSettingsSections).toHaveLength(15);
  });

  it("lists the seven platform roles in band order", () => {
    expect(registry.roles.map((r) => [r.code, r.band])).toEqual(
      ROLE_CODES.map((code, i) => [code, i + 1]),
    );
  });

  it("contains every capability the specification names", () => {
    for (const named of SPEC_NAMED_CAPABILITIES) expect(codes).toContain(named);
  });

  it("gives the owner every capability", () => {
    expect([...byRole.owner.keys()].sort()).toEqual([...codes].sort());
  });

  it("keeps billing, legal and restricted data with the owner only", () => {
    for (const code of ["org.billing.manage", "org.legal.accept", "data.restricted.read.payroll"]) {
      for (const role of ROLE_CODES.filter((r) => r !== "owner")) {
        expect(byRole[role].has(code), `${role} ${code}`).toBe(false);
      }
    }
  });

  it("follows the Section 4.5.9 table for representative cells", () => {
    expect(byRole.admin.get("canon.extension.write")).toBe("organization");
    expect(byRole.manager.has("canon.extension.write")).toBe(false);
    expect(byRole.manager.get("canon.taxonomy.read")).toBe("organization");
    expect(byRole.member.get("finance.budget.read")).toBe("organization");
    expect(byRole.member.has("finance.po.approve")).toBe(false);
    expect(byRole.member.get("work.record.write")).toBe("assigned");
    expect(byRole.member.has("projects.project.create")).toBe(false);
    expect(byRole.collaborator.get("work.record.write")).toBe("assigned");
    expect(byRole.collaborator.has("people.directory.read")).toBe(false);
    expect(byRole.field.get("crew.time_entry.write")).toBe("own");
    expect(byRole.field.has("crew.timesheet.approve")).toBe(false);
    expect(byRole.field.get("safety.incident.write")).toBe("assigned");
    expect(byRole.field.has("canon.taxonomy.read")).toBe(false);
    expect(byRole.viewer.get("reports.report.read")).toBe("organization");
    expect(byRole.viewer.has("work.record.write")).toBe(false);
    expect(byRole.viewer.get("me.profile.write")).toBe("own");
    expect(byRole.manager.has("audit.log.read")).toBe(false);
    expect(byRole.admin.get("audit.log.read")).toBe("organization");
    expect(byRole.manager.get("crew.timesheet.approve")).toBe("organization");
    expect(byRole.manager.get("procurement.bid.unseal")).toBe("organization");
  });

  it("parses the source file and the default path identically", () => {
    expect(parseCapabilityRegistry(sourceText)).toEqual(registry);
  });
});

describe("registry validation", () => {
  it("rejects malformed shapes", () => {
    const doc = raw() as unknown as Record<string, unknown>;
    doc["unexpected"] = true;
    expect(issuesFor(doc as unknown as RawRegistry).join("\n")).toMatch(/unexpected|Unrecognized/);
  });

  it("rejects an unknown capability class", () => {
    const doc = raw();
    capabilityOf(doc, "home.alerts.read").class = "delete";
    expect(issuesFor(doc).join("\n")).toMatch(/class/);
  });

  it("rejects roles out of band order", () => {
    const doc = raw();
    doc.roles.reverse();
    const issues = issuesFor(doc);
    expect(issues).toContain(
      "roles must be owner, admin, manager, member, collaborator, field, viewer in band order",
    );
    expect(issues).toContain("role viewer must have band 1");
  });

  it("rejects missing, unknown and duplicate modules", () => {
    const empty = raw();
    moduleOf(empty, "home").capabilities = [];
    expect(issuesFor(empty).join("\n")).toMatch(/^modules\.0\.capabilities/);
    const doc2 = raw();
    doc2.modules = doc2.modules.filter((m) => m.code !== "safety");
    doc2.modules.push({
      ...moduleOf(doc2, "home"),
      code: "lounge",
      capabilities: [{ code: "lounge.seat.read", class: "read", description: "Read seats." }],
    });
    doc2.modules.push(moduleOf(doc2, "inbox"));
    const issues2 = issuesFor(doc2);
    expect(issues2).toContain("module safety is missing");
    expect(issues2).toContain("module lounge is not a known module");
    expect(issues2).toContain("module codes must be unique");
    expect(issues2).toContain("capability inbox.notifications.read is defined twice");
  });

  it("rejects badly formed capability codes and descriptions", () => {
    const doc = raw();
    const home = moduleOf(doc, "home");
    home.capabilities.push(
      { code: "home.read", class: "read", description: "Too short a code." },
      { code: "inbox.items.read", class: "read", description: "Wrong module prefix." },
      { code: "home.notes.read", class: "read", description: "no capital and no period" },
      { code: "home.notes.approve", class: "approve", own: true, description: "Own approval." },
    );
    const issues = issuesFor(doc);
    expect(issues).toContain("capability home.read must be 3 to 5 lowercase dotted segments");
    expect(issues).toContain("capability inbox.items.read must start with its module code home");
    expect(issues).toContain(
      "capability home.notes.read description must be a sentence ending in a period, without em dashes",
    );
    expect(issues).toContain(
      "capability home.notes.approve may be marked own only for read or write classes",
    );
  });

  it("rejects a registry missing a capability the specification names", () => {
    const doc = raw();
    const procurement = moduleOf(doc, "procurement");
    procurement.capabilities = procurement.capabilities.filter(
      (c) => c.code !== "procurement.bid.unseal",
    );
    expect(issuesFor(doc)).toContain(
      "capability procurement.bid.unseal named by the specification is missing",
    );
  });

  it("rejects settings sections out of order or naming unknown capabilities", () => {
    const doc = raw();
    doc.settings_sections.reverse();
    const first = doc.personal_settings_sections[0];
    if (first === undefined) throw new Error("personal settings sections are empty");
    first.capability = "me.nothing.write";
    const issues = issuesFor(doc);
    expect(issues).toContain("settings section must list the Section 4.5.6 sections in order");
    expect(issues).toContain(
      "personal settings section profile names unknown capability me.nothing.write",
    );
  });

  it("rejects grants that break Section 8 role rules", () => {
    const doc = raw();
    capabilityOf(doc, "home.alerts.read").roles = { admin: "organization" };
    capabilityOf(doc, "finance.po.approve").roles = {
      owner: "organization",
      admin: "organization",
      manager: "organization",
      member: "organization",
      field: "own",
    };
    capabilityOf(doc, "procurement.po.write").roles = {
      owner: "organization",
      admin: "organization",
      manager: "organization",
      member: "assigned",
      collaborator: "assigned",
    };
    capabilityOf(doc, "org.billing.read").roles = { owner: "organization", admin: "organization" };
    capabilityOf(doc, "work.record.write").roles = {
      owner: "organization",
      admin: "organization",
      manager: "organization",
      member: "assigned",
      viewer: "organization",
    };
    const issues = issuesFor(doc);
    expect(issues).toContain("owner must hold home.alerts.read");
    expect(issues).toContain(
      "member must not hold finance.po.approve (Section 8: no finance approval)",
    );
    expect(issues).toContain("field must not hold finance.po.approve");
    expect(issues).toContain(
      "collaborator must not hold procurement.po.write (Section 8: no finance or procurement writes)",
    );
    expect(issues).toContain(
      "admin must not hold org.billing.read (Section 4.5.9: Full except Billing and Legal)",
    );
    expect(issues).toContain(
      "viewer must not hold work.record.write beyond own reach (Section 8: read only)",
    );
  });

  it("rejects a narrower role holding more than a wider one", () => {
    const doc = raw();
    moduleOf(doc, "audit").visibility["member"] = "full";
    const issues = issuesFor(doc);
    expect(issues).toContain("manager must hold audit.log.read at least as widely as member");
  });
});
