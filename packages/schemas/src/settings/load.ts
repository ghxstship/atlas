import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";
import { allCapabilities } from "../capabilities/grants.ts";
import { loadCapabilityRegistry } from "../capabilities/load.ts";
import {
  SETTING_SCOPES,
  SETTING_TYPES,
  TEXT_INPUTS,
  pageGroup,
  type SettingDefinition,
  type SettingEnforcement,
} from "./model.ts";

/** Directory of the per-contributor registry files. */
export const SETTINGS_DIR = fileURLToPath(new URL("../../settings/", import.meta.url));

const KEY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const CHOICE = /^[A-Za-z0-9][A-Za-z0-9_./+:-]*$/;
const CATALOG_KEY = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/;
const NODE = /^(settings|me)(\.[a-z0-9-]+)?$/;
const CONTRIBUTOR = /^[a-z][a-z0-9-]*$/;
/** A repository-relative file, optionally followed by `#symbol`. */
const CONSUMER =
  /^(apps|packages|supabase)\/[A-Za-z0-9_./()[\]-]+\.(ts|tsx|sql)(#[A-Za-z0-9_.]+)?$/;
const TEST = /^(apps|packages|supabase)\/[A-Za-z0-9_./()[\]-]+\.(test\.tsx?|test\.sql|spec\.ts)$/;

const settingSchema = z.strictObject({
  key: z.string().regex(KEY).max(120),
  type: z.enum(SETTING_TYPES),
  scopes: z.array(z.enum(SETTING_SCOPES)).min(1),
  capability: z.string(),
  lockable: z.boolean().optional(),
  default: z.union([z.string(), z.number().int(), z.boolean()]).optional(),
  choices: z.array(z.string().regex(CHOICE).max(80)).optional(),
  min: z.number().int().optional(),
  max: z.number().int().optional(),
  max_length: z.number().int().min(1).max(4000).optional(),
  input: z.enum(TEXT_INPUTS).optional(),
  label: z.string().regex(CATALOG_KEY),
  help: z.string().regex(CATALOG_KEY).optional(),
  pages: z.strictObject({
    org: z.string().regex(NODE).optional(),
    personal: z.string().regex(NODE).optional(),
  }),
  hidden: z.literal(true).optional(),
  enforced_by: z
    .array(z.strictObject({ consumer: z.string().regex(CONSUMER), test: z.string().regex(TEST) }))
    .min(1)
    .optional(),
  deferred: z
    .strictObject({
      reason: z.string().min(20).max(400),
      decision: z.string().min(5).max(200),
    })
    .optional(),
});

const fileSchema = z.strictObject({
  contributor: z.string().regex(CONTRIBUTOR),
  settings: z.array(settingSchema).min(1),
});

type RawSetting = z.infer<typeof settingSchema>;

/** Raised when a registry file is malformed or breaks a registry rule. */
export class SettingsRegistryError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`Settings registry is invalid:\n  ${issues.join("\n  ")}`);
    this.name = "SettingsRegistryError";
    this.issues = issues;
  }
}

/** Every rule a single setting must follow, as messages naming the setting. */
export function validateSetting(raw: RawSetting, capabilities: ReadonlySet<string>): string[] {
  const issues: string[] = [];
  const at = `setting ${raw.key}`;
  if (new Set(raw.scopes).size !== raw.scopes.length) issues.push(`${at} repeats a scope`);
  if (!capabilities.has(raw.capability)) {
    issues.push(`${at} names unknown capability ${raw.capability}`);
  }
  if (raw.lockable && !raw.scopes.includes("organization")) {
    issues.push(`${at} is lockable but has no organization scope`);
  }
  if (raw.type === "choice") {
    if (!raw.choices?.length) issues.push(`${at} is a choice setting without choices`);
    else if (new Set(raw.choices).size !== raw.choices.length) {
      issues.push(`${at} repeats a choice`);
    }
  } else if (raw.choices) {
    issues.push(`${at} has choices but is not a choice setting`);
  }
  if (raw.type !== "integer" && (raw.min !== undefined || raw.max !== undefined)) {
    issues.push(`${at} has bounds but is not an integer setting`);
  }
  if (raw.min !== undefined && raw.max !== undefined && raw.min > raw.max) {
    issues.push(`${at} has min above max`);
  }
  if (raw.type !== "text" && (raw.max_length !== undefined || raw.input !== undefined)) {
    issues.push(`${at} has text options but is not a text setting`);
  }
  if (raw.default !== undefined) {
    const d = raw.default;
    const fits =
      raw.type === "boolean"
        ? typeof d === "boolean"
        : raw.type === "integer"
          ? typeof d === "number" &&
            (raw.min === undefined || d >= raw.min) &&
            (raw.max === undefined || d <= raw.max)
          : raw.type === "choice"
            ? typeof d === "string" && (raw.choices ?? []).includes(d)
            : typeof d === "string" && d.length <= (raw.max_length ?? 4000);
    if (!fits) issues.push(`${at} has a default that does not fit its type`);
  }
  if (raw.enforced_by && raw.deferred) {
    issues.push(`${at} is both enforced and deferred; keep one`);
  } else if (!raw.enforced_by && !raw.deferred) {
    issues.push(
      `${at} names no consumer: add enforced_by (the module that applies it and its test) or a deferred reason (A65-001)`,
    );
  }
  if (raw.hidden) {
    if (raw.pages.org || raw.pages.personal) issues.push(`${at} is hidden but names a page`);
    if (!raw.deferred) {
      issues.push(`${at} is hidden, so it must be deferred with the reason no screen offers it`);
    }
  }
  const groups = new Set(raw.scopes.map(pageGroup));
  for (const group of ["org", "personal"] as const) {
    const page = raw.pages[group];
    if (groups.has(group) && !page && !raw.hidden) issues.push(`${at} needs a ${group} page`);
    if (!groups.has(group) && page) issues.push(`${at} has a ${group} page without such a scope`);
    if (page && !page.startsWith(group === "org" ? "settings." : "me.")) {
      issues.push(`${at} shows its ${group} scope on ${page}`);
    }
  }
  return issues;
}

function toDefinition(contributor: string, raw: RawSetting): SettingDefinition {
  return {
    key: raw.key,
    contributor,
    type: raw.type,
    scopes: [...raw.scopes].sort((a, b) => SETTING_SCOPES.indexOf(a) - SETTING_SCOPES.indexOf(b)),
    capability: raw.capability,
    lockable: raw.lockable ?? false,
    default: raw.default ?? null,
    choices: raw.choices ?? [],
    min: raw.min ?? null,
    max: raw.max ?? null,
    maxLength: raw.max_length ?? null,
    input: raw.input ?? "text",
    label: raw.label,
    help: raw.help ?? null,
    pages: {
      ...(raw.pages.org ? { org: raw.pages.org } : {}),
      ...(raw.pages.personal ? { personal: raw.pages.personal } : {}),
    },
    deferred: raw.deferred !== undefined,
    hidden: raw.hidden === true,
  };
}

function toEnforcement(raw: RawSetting): SettingEnforcement {
  return raw.deferred
    ? {
        kind: "deferred",
        deferral: { reason: raw.deferred.reason, decision: raw.deferred.decision },
      }
    : {
        kind: "enforced",
        by: (raw.enforced_by ?? []).map((c) => ({ consumer: c.consumer, test: c.test })),
      };
}

/** Parses registry files (name to text) into definitions, contributor files in name order. */
export function parseSettingsFiles(
  files: ReadonlyMap<string, string>,
  capabilities: ReadonlySet<string>,
): SettingDefinition[] {
  return parseSettingsRegistry(files, capabilities).settings;
}

/** Definitions and how each takes effect, keyed by setting key in registry order. */
export interface ParsedSettingsRegistry {
  readonly settings: SettingDefinition[];
  readonly enforcement: Map<string, SettingEnforcement>;
}

/** Parses registry files into definitions and their enforcement metadata. */
export function parseSettingsRegistry(
  files: ReadonlyMap<string, string>,
  capabilities: ReadonlySet<string>,
): ParsedSettingsRegistry {
  const issues: string[] = [];
  const out: SettingDefinition[] = [];
  const enforcement = new Map<string, SettingEnforcement>();
  const seen = new Map<string, string>();
  for (const name of [...files.keys()].sort()) {
    const parsed = fileSchema.safeParse(parse(files.get(name) ?? ""));
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        issues.push(`${name}: ${issue.path.join(".")} ${issue.message}`);
      }
      continue;
    }
    if (`${parsed.data.contributor}.yaml` !== name) {
      issues.push(`${name}: contributor must match the file name`);
    }
    for (const raw of parsed.data.settings) {
      const prior = seen.get(raw.key);
      if (prior) issues.push(`${name}: setting ${raw.key} is already declared in ${prior}`);
      seen.set(raw.key, name);
      issues.push(...validateSetting(raw, capabilities).map((i) => `${name}: ${i}`));
      out.push(toDefinition(parsed.data.contributor, raw));
      enforcement.set(raw.key, toEnforcement(raw));
    }
  }
  if (issues.length > 0) throw new SettingsRegistryError(issues);
  return { settings: out, enforcement };
}

/** Reads every contributor file in the settings directory. */
export function readSettingsFiles(dir: string = SETTINGS_DIR): Map<string, string> {
  return new Map(
    readdirSync(dir)
      .filter((f) => f.endsWith(".yaml"))
      .map((f) => [f, readFileSync(join(dir, f), "utf8")] as const),
  );
}

/** Loads and validates the whole registry against the capability registry. */
export function loadSettingsRegistry(dir: string = SETTINGS_DIR): SettingDefinition[] {
  return loadSettingsWithEnforcement(dir).settings;
}

/** The whole registry with each setting's consumers or deferral (A65-001 regression guard). */
export function loadSettingsWithEnforcement(dir: string = SETTINGS_DIR): ParsedSettingsRegistry {
  const capabilities = new Set(allCapabilities(loadCapabilityRegistry()).map((c) => c.code));
  return parseSettingsRegistry(readSettingsFiles(dir), capabilities);
}
