import type { DataError } from "@xos/data";
import type { SettingValue } from "@xos/data/settings";
import { SETTINGS, type SettingDefinition } from "@xos/schemas/settings";

/**
 * The settings registry as Atlas pages use it (Section 4.5.6): lookups, catalog keys for choices
 * and refusals, and parsing of submitted form values against a definition. The database checks
 * every value again; parsing here only turns form text into the typed value and catches what a
 * person can fix before submitting.
 */

export function settingByKey(key: string): SettingDefinition | undefined {
  return SETTINGS.find((s) => s.key === key);
}

/** Settings shown on a page at the given scope group, in registry order. */
export function pageSettings(node: string, group: "org" | "personal"): SettingDefinition[] {
  return SETTINGS.filter((s) => s.pages[group] === node);
}

/** Settings a workspace may override, in registry order. */
export function workspaceSettings(): SettingDefinition[] {
  return SETTINGS.filter((s) => s.scopes.includes("workspace"));
}

/** Catalog key of a choice label: `settings.choices.<key with underscores>.<choice>`. */
export function choiceLabelKey(settingKey: string, choice: string): string {
  return `settings.choices.${settingKey.replaceAll(".", "_")}.${choice}`;
}

/** Refusal rules with their own message under `settings.errors`. */
export const KNOWN_SETTING_ERRORS = new Set([
  "setting_locked",
  "setting_choice",
  "setting_too_long",
  "setting_out_of_range",
  "setting_value_type",
  "setting_scope_not_allowed",
  "setting_scope_org",
  "setting_not_lockable",
  "setting_unknown",
  "not_member",
  "plan_feature_required",
  "favorites_limit",
  "module_not_switchable",
  "domain_immutable",
  "auto_join_role_band",
  "ip_allowlist_empty",
  "plan_feature_ip_allowlist",
  "setting_fixed",
  "work_phone_e164",
]);

/** The `settings.errors.*` key for a repository error. */
export function settingErrorKey(error: DataError): string {
  if (error.kind === "refusal") {
    return KNOWN_SETTING_ERRORS.has(error.rule) ? error.rule : "unexpected";
  }
  if (error.kind === "not-found") return "denied";
  if (error.kind === "conflict") return "conflict";
  if (error.kind === "invalid") return "invalid";
  return "unexpected";
}

export type ParsedValue =
  | { readonly ok: true; readonly value: Exclude<SettingValue, null> }
  | { readonly ok: false; readonly error: string };

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY = /^[A-Z]{3}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A phone setting arrives here already read into E.164 by the saving action (toE164, A139). */
const E164 = /^\+[1-9]\d{7,14}$/;

function validUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function validTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Parses the submitted form text of one setting into its typed value, or names the problem. */
export function parseSettingValue(def: SettingDefinition, raw: string | null): ParsedValue {
  const text = (raw ?? "").trim();
  switch (def.type) {
    case "boolean":
      return { ok: true, value: text === "on" || text === "true" };
    case "integer": {
      if (!/^-?\d+$/.test(text)) return { ok: false, error: "integer" };
      const value = Number(text);
      if ((def.min !== null && value < def.min) || (def.max !== null && value > def.max)) {
        return { ok: false, error: "setting_out_of_range" };
      }
      return { ok: true, value };
    }
    case "choice":
      return def.choices.includes(text)
        ? { ok: true, value: text }
        : { ok: false, error: "setting_choice" };
    case "text": {
      if (text === "") return { ok: false, error: "required" };
      if (def.maxLength !== null && text.length > def.maxLength) {
        return { ok: false, error: "setting_too_long" };
      }
      const valid =
        def.input === "email"
          ? EMAIL.test(text)
          : def.input === "url"
            ? validUrl(text)
            : def.input === "date"
              ? DATE.test(text) && !Number.isNaN(Date.parse(text))
              : def.input === "currency"
                ? CURRENCY.test(text)
                : def.input === "time_zone"
                  ? validTimeZone(text)
                  : def.input === "workspace"
                    ? UUID.test(text)
                    : def.input === "phone"
                      ? E164.test(text)
                      : true;
      return valid ? { ok: true, value: text } : { ok: false, error: def.input };
    }
  }
}

/** The text a form control starts with for a value. */
export function formText(value: SettingValue): string {
  if (value === null) return "";
  return typeof value === "boolean" ? (value ? "on" : "") : String(value);
}
