import { dbValueType, type SettingDefinition } from "./model.ts";

/** A SQL string literal. */
function lit(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function textArray(values: readonly string[]): string {
  return `array[${values.map(lit).join(", ")}]`;
}

/**
 * The one private.define_setting statement that declares a setting in the database. Migrations
 * paste these statements verbatim, so the settings check can compare them as text.
 */
export function renderDefineSetting(s: SettingDefinition): string {
  const args = [
    lit(s.key),
    lit(dbValueType(s.type)),
    lit(s.capability),
    textArray(s.scopes),
    s.lockable ? "true" : "false",
  ];
  if (s.default !== null) {
    if (typeof s.default === "boolean") args.push(`p_default_boolean => ${String(s.default)}`);
    else if (typeof s.default === "number") args.push(`p_default_integer => ${s.default}`);
    else args.push(`p_default_text => ${lit(s.default)}`);
  }
  if (s.choices.length > 0) args.push(`p_choices => ${textArray(s.choices)}`);
  if (s.min !== null) args.push(`p_min_integer => ${s.min}`);
  if (s.max !== null) args.push(`p_max_integer => ${s.max}`);
  if (s.maxLength !== null) args.push(`p_max_length => ${s.maxLength}`);
  return `select private.define_setting(${args.join(", ")});`;
}

/** The statements of one contributor, in registry order. */
export function renderContributorSql(
  settings: readonly SettingDefinition[],
  contributor: string,
): string {
  return settings
    .filter((s) => s.contributor === contributor)
    .map(renderDefineSetting)
    .join("\n");
}

const STATEMENT = /select private\.define_setting\('((?:[^']|'')*)'[^;]*\);/g;

/** The last define_setting statement for each key across migration texts, in file order. */
export function definedStatements(migrations: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const text of migrations) {
    for (const match of text.matchAll(STATEMENT)) {
      out.set((match[1] ?? "").replaceAll("''", "'"), match[0]);
    }
  }
  return out;
}

/**
 * Differences between the registry and the migrations: settings whose latest statement is
 * missing or differs from the rendered one, and statements for keys no registry file declares.
 */
export function registryDrift(
  settings: readonly SettingDefinition[],
  migrations: readonly string[],
  ignoreKeys: (key: string) => boolean = () => false,
): string[] {
  const defined = definedStatements(migrations);
  const issues: string[] = [];
  for (const s of settings) {
    const expected = renderDefineSetting(s);
    const actual = defined.get(s.key);
    if (actual === undefined) issues.push(`${s.key} is not defined by any migration`);
    else if (actual !== expected) issues.push(`${s.key} differs from its latest migration`);
  }
  const declared = new Set(settings.map((s) => s.key));
  for (const key of defined.keys()) {
    if (!declared.has(key) && !ignoreKeys(key)) {
      issues.push(`${key} is defined in a migration but in no registry file`);
    }
  }
  return issues;
}
