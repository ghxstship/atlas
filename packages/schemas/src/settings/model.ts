/**
 * The settings registry model (Section 4.5.6). Every setting is declared once, in one
 * contributor's file under packages/schemas/settings/, and the database holds the same definition
 * through private.define_setting, so pages, the API and the guards agree.
 */

export const SETTING_TYPES = ["text", "boolean", "integer", "choice"] as const;
export type SettingType = (typeof SETTING_TYPES)[number];

/** Scopes widest first; personal values belong to the person. */
export const SETTING_SCOPES = ["organization", "workspace", "team", "project", "personal"] as const;
export type SettingScope = (typeof SETTING_SCOPES)[number];

/** How a text setting is edited. */
export const TEXT_INPUTS = [
  "text",
  "multiline",
  "email",
  "url",
  "time_zone",
  "currency",
  "date",
  "workspace",
] as const;
export type TextInput = (typeof TEXT_INPUTS)[number];

/** The settings page group a scope belongs to. */
export type PageGroup = "org" | "personal";

export interface SettingDefinition {
  readonly key: string;
  readonly contributor: string;
  readonly type: SettingType;
  readonly scopes: readonly SettingScope[];
  readonly capability: string;
  readonly lockable: boolean;
  readonly default: string | number | boolean | null;
  readonly choices: readonly string[];
  readonly min: number | null;
  readonly max: number | null;
  readonly maxLength: number | null;
  readonly input: TextInput;
  readonly label: string;
  readonly help: string | null;
  readonly pages: Readonly<Partial<Record<PageGroup, string>>>;
}

/** The database enum value of a registry type. */
export function dbValueType(type: SettingType): "Text" | "Boolean" | "Integer" | "Choice" {
  return type === "text"
    ? "Text"
    : type === "boolean"
      ? "Boolean"
      : type === "integer"
        ? "Integer"
        : "Choice";
}

/** The scope group (org pages or personal pages) of a scope. */
export function pageGroup(scope: SettingScope): PageGroup {
  return scope === "personal" ? "personal" : "org";
}

/** Settings shown on one page, in registry order. */
export function settingsForPage(
  settings: readonly SettingDefinition[],
  node: string,
): SettingDefinition[] {
  return settings.filter((s) => s.pages.org === node || s.pages.personal === node);
}
