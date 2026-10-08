import { describe, expect, it } from "vitest";
import type {
  CapabilityDefinition,
  ModuleDefinition,
  RoleCode,
} from "../../src/capabilities/index.ts";
import {
  ROLE_CODES,
  deriveRoleGrants,
  grantFor,
  loadCapabilityRegistry,
  renderCapabilitySeedSql,
  sqlLiteral,
} from "../../src/capabilities/index.ts";

function cap(
  partial: Partial<CapabilityDefinition> & Pick<CapabilityDefinition, "class">,
): CapabilityDefinition {
  return {
    code: "work.thing.verb",
    description: "Does a thing.",
    own: false,
    roles: null,
    ...partial,
  };
}

function mod(
  visibility: Partial<Record<RoleCode, ModuleDefinition["visibility"][RoleCode]>>,
  projectScoped = true,
): ModuleDefinition {
  const base = Object.fromEntries(ROLE_CODES.map((r) => [r, "hidden"])) as Record<
    RoleCode,
    ModuleDefinition["visibility"][RoleCode]
  >;
  return {
    code: "work",
    group: "production",
    projectScoped,
    visibility: { ...base, ...visibility },
    capabilities: [],
  };
}

describe("grantFor", () => {
  it("grants everything at organization reach for full visibility", () => {
    const m = mod({ admin: "full" });
    for (const cls of ["read", "write", "approve", "manage", "export"] as const) {
      expect(grantFor("admin", m, cap({ class: cls }))).toBe("organization");
    }
  });

  it("narrows member writes to assigned projects and drops manage", () => {
    const scoped = mod({ member: "full" });
    expect(grantFor("member", scoped, cap({ class: "read" }))).toBe("organization");
    expect(grantFor("member", scoped, cap({ class: "write" }))).toBe("assigned");
    expect(grantFor("member", scoped, cap({ class: "approve" }))).toBe("assigned");
    expect(grantFor("member", scoped, cap({ class: "export" }))).toBe("assigned");
    expect(grantFor("member", scoped, cap({ class: "manage" }))).toBeNull();
    const orgLevel = mod({ member: "full" }, false);
    expect(grantFor("member", orgLevel, cap({ class: "write" }))).toBe("organization");
  });

  it("applies read, assigned, own and hidden levels by class", () => {
    const m = mod({ viewer: "read", collaborator: "assigned", field: "own" });
    expect(grantFor("viewer", m, cap({ class: "read" }))).toBe("organization");
    expect(grantFor("viewer", m, cap({ class: "write" }))).toBeNull();
    expect(grantFor("collaborator", m, cap({ class: "write" }))).toBe("assigned");
    expect(grantFor("collaborator", m, cap({ class: "approve" }))).toBeNull();
    expect(grantFor("field", m, cap({ class: "write", own: true }))).toBe("own");
    expect(grantFor("field", m, cap({ class: "write" }))).toBeNull();
    expect(grantFor("field", m, cap({ class: "approve", own: true }))).toBeNull();
    expect(grantFor("owner", m, cap({ class: "read" }))).toBeNull();
  });

  it("lets a capability's role list override the module level", () => {
    const m = mod({ admin: "full", owner: "full" });
    const c = cap({ class: "manage", roles: { owner: "organization" } });
    expect(grantFor("owner", m, c)).toBe("organization");
    expect(grantFor("admin", m, c)).toBeNull();
  });
});

describe("capability seed SQL", () => {
  const registry = loadCapabilityRegistry();

  it("is deterministic", () => {
    expect(renderCapabilitySeedSql(registry)).toBe(
      renderCapabilitySeedSql(loadCapabilityRegistry()),
    );
  });

  it("states its counts and covers every grant", () => {
    const sql = renderCapabilitySeedSql(registry);
    const grants = deriveRoleGrants(registry);
    const capabilityCount = registry.modules.reduce((n, m) => n + m.capabilities.length, 0);
    expect(sql).toContain(`${registry.modules.length} modules, ${capabilityCount} capabilities`);
    expect(sql).toContain(`${grants.length} system role grants`);
    expect(sql.match(/::app\.capability_reach\)/g)).toHaveLength(grants.length);
    expect(sql).toContain("('owner', 'finance.po.approve', 'organization'::app.capability_reach)");
  });

  it("escapes single quotes in literals", () => {
    expect(sqlLiteral("the org's plan")).toBe("'the org''s plan'");
  });
});
