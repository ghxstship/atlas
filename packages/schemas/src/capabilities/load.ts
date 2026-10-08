import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";
import { allCapabilities, grantsByRole } from "./grants.ts";
import type { CapabilityRegistry, RoleCode } from "./model.ts";
import {
  CAPABILITY_CLASSES,
  CAPABILITY_REACHES,
  NAV_GROUPS,
  ORG_SETTINGS_SECTIONS,
  PERSONAL_SETTINGS_SECTIONS,
  REQUIRED_MODULES,
  ROLE_CODES,
  VISIBILITY_LEVELS,
  reachRank,
} from "./model.ts";

/** Default location of the registry: the package root. */
export const CAPABILITIES_YAML_PATH = fileURLToPath(
  new URL("../../capabilities.yaml", import.meta.url),
);

/** Capabilities the specification names by code; each must exist. */
export const SPEC_NAMED_CAPABILITIES = [
  "finance.po.approve",
  "crew.timesheet.approve",
  "canon.extension.write",
  "org.profile.write",
  "data.restricted.read.payroll",
  "procurement.bid.unseal",
] as const;

const CODE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,4}$/;
const EM_DASH = String.fromCharCode(0x2014);

const roleCode = z.enum(ROLE_CODES);
const reach = z.enum(CAPABILITY_REACHES);
const level = z.enum(VISIBILITY_LEVELS);

const capabilitySchema = z.strictObject({
  code: z.string(),
  class: z.enum(CAPABILITY_CLASSES),
  description: z.string().min(1),
  own: z.boolean().optional(),
  roles: z.partialRecord(roleCode, reach).optional(),
});

const moduleSchema = z.strictObject({
  code: z.string().regex(/^[a-z][a-z0-9_]*$/),
  group: z.enum(NAV_GROUPS),
  project_scoped: z.boolean(),
  visibility: z.record(roleCode, level),
  capabilities: z.array(capabilitySchema).min(1),
});

const sectionSchema = z.strictObject({ section: z.string(), capability: z.string() });

const registrySchema = z.strictObject({
  version: z.literal(1),
  roles: z.array(z.strictObject({ code: roleCode, band: z.int(), description: z.string().min(1) })),
  modules: z.array(moduleSchema),
  settings_sections: z.array(sectionSchema),
  personal_settings_sections: z.array(sectionSchema),
});

/** Raised when the registry text is malformed or breaks a registry rule. */
export class CapabilityRegistryError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`Capability registry is invalid:\n  ${issues.join("\n  ")}`);
    this.name = "CapabilityRegistryError";
    this.issues = issues;
  }
}

function toRegistry(raw: z.infer<typeof registrySchema>): CapabilityRegistry {
  return {
    version: raw.version,
    roles: raw.roles,
    modules: raw.modules.map((m) => ({
      code: m.code,
      group: m.group,
      projectScoped: m.project_scoped,
      visibility: m.visibility,
      capabilities: m.capabilities.map((c) => ({
        code: c.code,
        class: c.class,
        description: c.description,
        own: c.own ?? false,
        roles: c.roles ?? null,
      })),
    })),
    settingsSections: raw.settings_sections,
    personalSettingsSections: raw.personal_settings_sections,
  };
}

function sameList(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((v, i) => v === expected[i]);
}

function checkStructure(registry: CapabilityRegistry, issues: string[]): void {
  const roleCodes = registry.roles.map((r) => r.code);
  if (!sameList(roleCodes, ROLE_CODES)) {
    issues.push(`roles must be ${ROLE_CODES.join(", ")} in band order`);
  }
  registry.roles.forEach((r, i) => {
    if (r.band !== i + 1) issues.push(`role ${r.code} must have band ${i + 1}`);
  });

  const moduleCodes = registry.modules.map((m) => m.code);
  const moduleSet = new Set(moduleCodes);
  if (moduleSet.size !== moduleCodes.length) issues.push("module codes must be unique");
  for (const required of REQUIRED_MODULES) {
    if (!moduleSet.has(required)) issues.push(`module ${required} is missing`);
  }
  for (const code of moduleSet) {
    if (!(REQUIRED_MODULES as readonly string[]).includes(code)) {
      issues.push(`module ${code} is not a known module`);
    }
  }

  const seen = new Set<string>();
  for (const module of registry.modules) {
    for (const cap of module.capabilities) {
      if (seen.has(cap.code)) issues.push(`capability ${cap.code} is defined twice`);
      seen.add(cap.code);
      if (!CODE_PATTERN.test(cap.code)) {
        issues.push(`capability ${cap.code} must be 3 to 5 lowercase dotted segments`);
      }
      if (cap.code.split(".")[0] !== module.code) {
        issues.push(`capability ${cap.code} must start with its module code ${module.code}`);
      }
      if (!/^[A-Z].*\.$/.test(cap.description) || cap.description.includes(EM_DASH)) {
        issues.push(
          `capability ${cap.code} description must be a sentence ending in a period, without em dashes`,
        );
      }
      if (cap.own && cap.class !== "read" && cap.class !== "write") {
        issues.push(`capability ${cap.code} may be marked own only for read or write classes`);
      }
    }
  }
  for (const named of SPEC_NAMED_CAPABILITIES) {
    if (!seen.has(named)) issues.push(`capability ${named} named by the specification is missing`);
  }

  const checkSections = (
    label: string,
    sections: CapabilityRegistry["settingsSections"],
    expected: readonly string[],
  ) => {
    if (
      !sameList(
        sections.map((s) => s.section),
        expected,
      )
    ) {
      issues.push(`${label} must list the Section 4.5.6 sections in order`);
    }
    for (const s of sections) {
      if (!seen.has(s.capability)) {
        issues.push(`${label} ${s.section} names unknown capability ${s.capability}`);
      }
    }
  };
  checkSections("settings section", registry.settingsSections, ORG_SETTINGS_SECTIONS);
  checkSections(
    "personal settings section",
    registry.personalSettingsSections,
    PERSONAL_SETTINGS_SECTIONS,
  );
}

/** A higher band role never holds more than the lower band role it is contained in. */
const CONTAINMENT: readonly (readonly [RoleCode, RoleCode])[] = [
  ["admin", "manager"],
  ["manager", "member"],
  ["member", "collaborator"],
  ["admin", "field"],
  ["admin", "viewer"],
];

function checkGrants(registry: CapabilityRegistry, issues: string[]): void {
  const byRole = grantsByRole(registry);
  const capabilities = allCapabilities(registry);
  const moduleOf = new Map(
    registry.modules.flatMap((m) => m.capabilities.map((c) => [c.code, m] as const)),
  );

  for (const cap of capabilities) {
    if (!byRole.owner.has(cap.code)) issues.push(`owner must hold ${cap.code}`);
  }

  for (const [wider, narrower] of CONTAINMENT) {
    for (const [code, r] of byRole[narrower]) {
      const held = byRole[wider].get(code);
      if (held === undefined || reachRank(held) < reachRank(r)) {
        issues.push(`${wider} must hold ${code} at least as widely as ${narrower}`);
      }
    }
  }

  for (const code of byRole.admin.keys()) {
    if (code.startsWith("org.billing.") || code.startsWith("org.legal.")) {
      issues.push(`admin must not hold ${code} (Section 4.5.9: Full except Billing and Legal)`);
    }
  }

  for (const cap of capabilities) {
    const module = moduleOf.get(cap.code);
    const commercial = module?.code === "finance" || module?.code === "procurement";
    if (!commercial) continue;
    if (cap.class === "approve" && byRole.member.has(cap.code)) {
      issues.push(`member must not hold ${cap.code} (Section 8: no finance approval)`);
    }
    if (cap.class !== "read" && byRole.collaborator.has(cap.code)) {
      issues.push(
        `collaborator must not hold ${cap.code} (Section 8: no finance or procurement writes)`,
      );
    }
    if (byRole.field.has(cap.code)) issues.push(`field must not hold ${cap.code}`);
  }

  for (const cap of capabilities) {
    const r = byRole.viewer.get(cap.code);
    if (r !== undefined && cap.class !== "read" && r !== "own") {
      issues.push(`viewer must not hold ${cap.code} beyond own reach (Section 8: read only)`);
    }
  }
}

/** Every rule breach in a parsed registry; empty when the registry is valid. */
export function validateRegistry(registry: CapabilityRegistry): string[] {
  const issues: string[] = [];
  checkStructure(registry, issues);
  checkGrants(registry, issues);
  return issues;
}

/** Parses and validates registry YAML text. Throws CapabilityRegistryError on any issue. */
export function parseCapabilityRegistry(text: string): CapabilityRegistry {
  const parsed = registrySchema.safeParse(parse(text));
  if (!parsed.success) {
    throw new CapabilityRegistryError(
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    );
  }
  const registry = toRegistry(parsed.data);
  const issues = validateRegistry(registry);
  if (issues.length > 0) throw new CapabilityRegistryError(issues);
  return registry;
}

/** Reads, parses and validates the registry file. */
export function loadCapabilityRegistry(path: string = CAPABILITIES_YAML_PATH): CapabilityRegistry {
  return parseCapabilityRegistry(readFileSync(path, "utf8"));
}
