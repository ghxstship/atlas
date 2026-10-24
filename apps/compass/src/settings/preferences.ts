/**
 * The person's registered settings on Compass's Preferences, Accessibility, Out of Office and Work Details screens
 * (Section 4.5.6 personal settings items 6, 7, 9 and 10, ADR 0071). The settings registry decides which settings a
 * screen shows and the choices each offers, so Atlas, Gateway and Compass show one set; the values come from
 * app.resolve_settings with where each comes from and whether the org locked it.
 *
 * Compass keeps the values it read in a device-local table, so the screens open offline, and a change queues as
 * set_personal_setting (or clear_personal_setting, to inherit again) with its optimistic row. The guard of migration
 * 0850 checks each value again and refuses a locked one (setting_locked).
 */
import { isTimeZone } from "@xos/data/calendar";
import { SETTINGS, type SettingDefinition } from "@xos/schemas/settings";
import type { MutationInput, Row } from "@xos/sync";

/** The device-local copy of the person's registered settings, one row per setting key. */
export const PERSONAL_MIRROR = "_me_personal_settings";

/** The registry page of each Compass settings section that shows registered settings. */
export const SECTION_PAGES = {
  "settings.preferences": "me.preferences",
  "settings.accessibility": "me.accessibility",
  "settings.out-of-office": "me.out-of-office",
  "settings.work-details": "me.work-details",
} as const;

export type RegistrySection = keyof typeof SECTION_PAGES;

/** Settings Compass draws elsewhere: the theme stays on Settings itself, beside Sunlight, the device's own theme. */
export const SHOWN_ELSEWHERE: ReadonlySet<string> = new Set(["me.theme"]);

/** The registered settings a section shows, in registry order; a hidden setting is never offered. */
export function sectionSettings(
  section: RegistrySection,
  settings: readonly SettingDefinition[] = SETTINGS,
): SettingDefinition[] {
  const page = SECTION_PAGES[section];
  return settings.filter(
    (s) => s.pages.personal === page && !s.hidden && !SHOWN_ELSEWHERE.has(s.key),
  );
}

/** Every setting key a Compass settings section shows. */
export function registryKeys(settings: readonly SettingDefinition[] = SETTINGS): string[] {
  return (Object.keys(SECTION_PAGES) as RegistrySection[]).flatMap((section) =>
    sectionSettings(section, settings).map((s) => s.key),
  );
}

/** Catalog key of a choice label: `settings.choices.<key with underscores>.<choice>`, as Atlas and Gateway read it. */
export function choiceLabelKey(settingKey: string, choice: string): string {
  return `settings.choices.${settingKey.replaceAll(".", "_")}.${choice}`;
}

export type SettingValue = string | boolean | number | null;

/** Where a value comes from (app.setting_source). */
export type SettingSource =
  "Personal" | "Project" | "Team" | "Workspace" | "Organization" | "Default";

/** A row of app.resolve_settings. */
export interface ResolvedRow {
  readonly setting_key: string;
  readonly value_text: string | null;
  readonly value_boolean: boolean | null;
  readonly value_integer: number | null;
  readonly source: string;
  readonly locked: boolean;
}

/** The device rows of the given settings from a resolve: the value, its source and the org's lock. */
export function personalRows(rows: readonly ResolvedRow[], keys: readonly string[]): Row[] {
  return rows
    .filter((r) => keys.includes(r.setting_key))
    .map((r) => ({
      id: r.setting_key,
      value: r.value_text ?? r.value_boolean ?? r.value_integer ?? null,
      source: r.source,
      locked: r.locked,
    }));
}

export interface PersonalSetting {
  readonly key: string;
  readonly value: SettingValue;
  readonly source: SettingSource;
  /** The org set this value and locked it; the person cannot change it. */
  readonly locked: boolean;
}

const SOURCES: readonly SettingSource[] = [
  "Personal",
  "Project",
  "Team",
  "Workspace",
  "Organization",
  "Default",
];

/** A setting as the screen shows it: its device row, or the registry default before the first read. */
export function settingOf(def: SettingDefinition, row: Row | undefined): PersonalSetting {
  const source = SOURCES.find((s) => s === row?.["source"]) ?? "Default";
  const value = row?.["value"];
  return {
    key: def.key,
    value:
      row && (typeof value === "string" || typeof value === "boolean" || typeof value === "number")
        ? value
        : row
          ? null
          : def.default,
    source,
    locked: row?.["locked"] === true && source !== "Personal",
  };
}

/** How a setting is edited on a phone. */
export type Control = "switch" | "segments" | "choices" | "zone" | "date" | "multiline" | "text";

/** Up to four choices fit as segments; more open a list. */
export const MAX_SEGMENTS = 4;

export function controlOf(def: SettingDefinition): Control {
  if (def.type === "boolean") return "switch";
  if (def.type === "choice") return def.choices.length <= MAX_SEGMENTS ? "segments" : "choices";
  if (def.input === "time_zone") return "zone";
  if (def.input === "date") return "date";
  if (def.input === "multiline") return "multiline";
  return "text";
}

/** The catalog key of where a value comes from, as Gateway's personal settings say it. */
export function sourceKey(setting: PersonalSetting): string {
  return setting.locked
    ? "settings.source.lockedForYou"
    : `settings.source.personal${setting.source}`;
}

/**
 * What Compass itself does without the person's own value, when that differs from the shells: the person's calendar
 * is the phone's time zone (A71), and the phone's language stands until someone chooses one (A65-001). The catalog
 * key of the note, or null.
 */
export function deviceNoteKey(setting: PersonalSetting): string | null {
  if (setting.key === "locale.time_zone" && setting.source !== "Personal")
    return "compassPersonal.registry.deviceZone";
  if (setting.key === "locale.language" && setting.source === "Default")
    return "compassPersonal.registry.deviceLanguage";
  return null;
}

/** What is wrong with a typed value: a refusal rule of the 0850 guard, or a date or zone the phone cannot read. */
export type SettingProblem =
  "setting_choice" | "setting_too_long" | "setting_value_type" | "date" | "zone";

export type ValueCheck =
  | { readonly ok: true; readonly value: Exclude<SettingValue, null> | null }
  | { readonly ok: false; readonly problem: SettingProblem };

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date written `YYYY-MM-DD`. */
export function isIsoDate(value: string): boolean {
  const match = DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/**
 * Checks a value before it queues, as the 0850 guard will: a registered choice, a boolean for a switch, text no
 * longer than the registry allows, a real date, a known zone. Blank text is null, which clears the person's value.
 */
export function checkSettingValue(def: SettingDefinition, raw: string | boolean): ValueCheck {
  if (def.type === "boolean") {
    return typeof raw === "boolean"
      ? { ok: true, value: raw }
      : { ok: false, problem: "setting_value_type" };
  }
  if (typeof raw !== "string") return { ok: false, problem: "setting_value_type" };
  if (def.type === "choice") {
    return def.choices.includes(raw)
      ? { ok: true, value: raw }
      : { ok: false, problem: "setting_choice" };
  }
  if (def.type === "integer") {
    const n = Number(raw);
    return Number.isInteger(n) &&
      (def.min === null || n >= def.min) &&
      (def.max === null || n <= def.max)
      ? { ok: true, value: n }
      : { ok: false, problem: "setting_value_type" };
  }
  const value = raw.trim();
  if (value === "") return { ok: true, value: null };
  if (def.maxLength !== null && value.length > def.maxLength)
    return { ok: false, problem: "setting_too_long" };
  if (def.input === "time_zone" && !isTimeZone(value)) return { ok: false, problem: "zone" };
  if (def.input === "date" && !isIsoDate(value)) return { ok: false, problem: "date" };
  return { ok: true, value };
}

function valueArgument(
  value: Exclude<SettingValue, null>,
): { p_value_text: string } | { p_value_boolean: boolean } | { p_value_integer: number } {
  if (typeof value === "string") return { p_value_text: value };
  if (typeof value === "boolean") return { p_value_boolean: value };
  return { p_value_integer: value };
}

/**
 * Sets the person's own value for every org (set_personal_setting, as Atlas and Gateway save it), or null when the
 * value is already theirs.
 */
export function personalWrite(
  key: string,
  row: Row | undefined,
  value: Exclude<SettingValue, null>,
): MutationInput | null {
  if (row?.["source"] === "Personal" && row["value"] === value) return null;
  return {
    op: "rpc",
    target: "set_personal_setting",
    table: PERSONAL_MIRROR,
    rowId: key,
    payload: { p_setting_key: key, ...valueArgument(value) },
    policy: "append",
    optimistic: { ...row, id: key, value, source: "Personal", locked: false },
  };
}

/**
 * Clears the person's own value so the setting inherits again (clear_personal_setting). Until the next read the row
 * shows the registry default, the value the person sees when nothing else applies. Null when there is nothing of
 * theirs to clear.
 */
export function personalClear(def: SettingDefinition, row: Row | undefined): MutationInput | null {
  if (row?.["source"] !== "Personal") return null;
  return {
    op: "rpc",
    target: "clear_personal_setting",
    table: PERSONAL_MIRROR,
    rowId: def.key,
    payload: { p_setting_key: def.key },
    policy: "append",
    optimistic: { ...row, id: def.key, value: def.default, source: "Default", locked: false },
  };
}

/** What is wrong with an out-of-office period: it ends before it starts. */
export type AwayProblem = "order";

/**
 * Checks the out-of-office dates together (me.out_of_office.starts_on and ends_on): an end before the start would
 * never make the person away (private.person_away, 1325). Either date may be blank.
 */
export function checkAwayPeriod(
  startsOn: string | null,
  endsOn: string | null,
): AwayProblem | null {
  if (startsOn && endsOn && endsOn < startsOn) return "order";
  return null;
}
