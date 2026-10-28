/**
 * The settings registry model (Section 4.5.6). Every setting is declared once, in one
 * contributor's file under packages/schemas/settings/, and the database holds the same definition
 * through private.define_setting, so pages, the API and the guards agree.
 */

import type { CapabilityCode } from "../capabilities/codes.generated.ts";

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
  readonly capability: CapabilityCode;
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
  /**
   * True while the setting is saved but nothing applies it yet, by a recorded decision (the
   * registry file's `deferred` block). Settings pages say so next to the control.
   */
  readonly deferred: boolean;
  /**
   * True for a setting kept in the registry and the database but offered on no settings screen (the
   * registry file's `hidden: true`, with no pages). It is always deferred, and its writes are refused.
   */
  readonly hidden: boolean;
}

/**
 * One place a setting takes effect (ADR 0032, A65-001): the module or migration that reads it and
 * the test that changes it and observes the behavior. Paths are relative to the repository root;
 * a consumer may name a symbol after `#`, such as `supabase/migrations/0941_record_punch.sql#app.record_punch`.
 */
export interface SettingConsumer {
  readonly consumer: string;
  readonly test: string;
}

/** Why a setting is not applied yet, and the owner decision or work package it waits on. */
export interface SettingDeferral {
  readonly reason: string;
  readonly decision: string;
}

/** How a setting takes effect: its consumers, or the recorded reason it does not yet. */
export type SettingEnforcement =
  | { readonly kind: "enforced"; readonly by: readonly SettingConsumer[] }
  | { readonly kind: "deferred"; readonly deferral: SettingDeferral };

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
