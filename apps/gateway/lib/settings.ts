import type { SettingValue } from "@xos/data/settings";
import { SETTINGS, type SettingDefinition } from "@xos/schemas/settings";

/**
 * Personal settings in Gateway (Section 4.5.6, A30 registry): the same personal values Atlas and
 * Compass use, shown on the Gateway settings section that matches each Atlas `me.*` page. The
 * database checks every value again; parsing here only turns form text into the typed value.
 */

/** The Atlas personal settings page a Gateway settings section shows. */
export function registryPage(gatewayNode: string): string | null {
  return gatewayNode.startsWith("settings.") && !gatewayNode.startsWith("settings.company")
    ? `me.${gatewayNode.slice("settings.".length)}`
    : null;
}

/** Personal settings shown on a Gateway settings section, in registry order. */
export function personalSettings(gatewayNode: string): SettingDefinition[] {
  const page = registryPage(gatewayNode);
  return page ? SETTINGS.filter((s) => s.pages.personal === page) : [];
}

export function settingByKey(key: string): SettingDefinition | undefined {
  return SETTINGS.find((s) => s.key === key);
}

/** Catalog key of a choice label: `settings.choices.<key with underscores>.<choice>`. */
export function choiceLabelKey(settingKey: string, choice: string): string {
  return `settings.choices.${settingKey.replaceAll(".", "_")}.${choice}`;
}

export type ParsedValue =
  | { readonly ok: true; readonly value: Exclude<SettingValue, null> }
  | { readonly ok: false; readonly error: string };

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY = /^[A-Z]{3}$/;

function validUrl(value: string): boolean {
  return URL.canParse(value) && /^https?:$/.test(new URL(value).protocol);
}

function validTimeZone(value: string): boolean {
  return Intl.supportedValuesOf("timeZone").includes(value) || value === "UTC";
}

/** Parses submitted text for one setting, or names the `settings.errors.*` problem. */
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
      return def.choices.includes(text) ? { ok: true, value: text } : { ok: false, error: "setting_choice" };
    case "text": {
      if (text === "") return { ok: false, error: "required" };
      if (def.maxLength !== null && text.length > def.maxLength) return { ok: false, error: "setting_too_long" };
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

/**
 * resolve_settings needs an org; personal values with no org apply everywhere. Gateway resolves
 * against the nil uuid, which matches no org, so only personal values and defaults come back.
 */
export const NO_ORG = "00000000-0000-0000-0000-000000000000";
