import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import { describe, expect, it } from "vitest";
import { GENERATED_PATH, renderRegistryModule } from "../../src/settings/generate.ts";
import {
  loadSettingsRegistry,
  parseSettingsFiles,
  readSettingsFiles,
  SettingsRegistryError,
} from "../../src/settings/load.ts";
import { dbValueType, pageGroup, settingsForPage } from "../../src/settings/model.ts";
import {
  definedStatements,
  registryDrift,
  renderContributorSql,
  renderDefineSetting,
} from "../../src/settings/sql.ts";
import { SETTINGS } from "../../src/settings/index.ts";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const migrationsDir = fileURLToPath(new URL("../../../../supabase/migrations/", import.meta.url));
const CAPS = new Set(["org.general.write", "me.preferences.write"]);

function files(yaml: string, name = "x1.yaml"): Map<string, string> {
  return new Map([[name, yaml]]);
}

function issuesOf(yaml: string, name?: string): string[] {
  try {
    parseSettingsFiles(files(yaml, name), CAPS);
    return [];
  } catch (error) {
    if (error instanceof SettingsRegistryError) return [...error.issues];
    throw error;
  }
}

const VALID = `contributor: x1
settings:
  - key: org.sample
    type: choice
    choices: [a, b]
    default: a
    scopes: [personal, organization]
    lockable: true
    capability: org.general.write
    label: sample.fields.sample.label
    pages: { org: settings.general, personal: me.preferences }
    deferred: { reason: "Waits on the sample decision for this test fixture.", decision: "Sample decision" }
`;

describe("settings registry files", () => {
  it("parses a valid file and sorts scopes widest first", () => {
    const [s] = parseSettingsFiles(files(VALID), CAPS);
    expect(s?.scopes).toEqual(["organization", "personal"]);
    expect(s?.contributor).toBe("x1");
    expect(s?.input).toBe("text");
  });

  it("refuses broken rules with a message naming the setting", () => {
    const broken = VALID.replace("org.general.write", "org.unknown.write")
      .replace("default: a", "default: c")
      .replace("scopes: [personal, organization]", "scopes: [personal, personal]");
    const issues = issuesOf(broken);
    expect(issues.some((i) => i.includes("unknown capability"))).toBe(true);
    expect(issues.some((i) => i.includes("default that does not fit"))).toBe(true);
    expect(issues.some((i) => i.includes("repeats a scope"))).toBe(true);
    expect(issues.some((i) => i.includes("lockable but has no organization scope"))).toBe(true);
  });

  it("checks types, bounds, pages and contributor names", () => {
    const yaml = `contributor: other
settings:
  - key: org.a
    type: text
    min: 1
    max: 0
    choices: [x, x]
    scopes: [organization]
    capability: org.general.write
    label: sample.a.label
    pages: { personal: me.preferences }
    deferred: { reason: "Waits on the sample decision for this test fixture.", decision: "Sample decision" }
  - key: org.b
    type: integer
    max_length: 4
    default: true
    scopes: [personal]
    capability: me.preferences.write
    label: sample.b.label
    pages: { personal: settings.general }
    deferred: { reason: "Waits on the sample decision for this test fixture.", decision: "Sample decision" }
  - key: org.c
    type: choice
    scopes: [organization]
    capability: org.general.write
    label: sample.c.label
    pages: { org: settings.general }
    deferred: { reason: "Waits on the sample decision for this test fixture.", decision: "Sample decision" }
  - key: org.c
    type: boolean
    default: 1
    scopes: [organization]
    capability: org.general.write
    label: sample.c.label
    pages: { org: settings.general }
    deferred: { reason: "Waits on the sample decision for this test fixture.", decision: "Sample decision" }
`;
    const issues = issuesOf(yaml);
    for (const expected of [
      "contributor must match the file name",
      "has choices but is not a choice setting",
      "has bounds but is not an integer setting",
      "has min above max",
      "has text options but is not a text setting",
      "needs a org page",
      "has a personal page without such a scope",
      "shows its personal scope on settings.general",
      "choice setting without choices",
      "already declared",
      "default that does not fit",
    ]) {
      expect(
        issues.some((i) => i.includes(expected)),
        expected,
      ).toBe(true);
    }
  });

  it("reports schema errors by path", () => {
    expect(issuesOf("contributor: x1\nsettings: []\n").length).toBeGreaterThan(0);
    expect(issuesOf(VALID.replace("type: choice", "type: colour")).length).toBeGreaterThan(0);
  });

  it("flags repeated choices and integer defaults outside the bounds", () => {
    const yaml = `contributor: x1
settings:
  - key: org.d
    type: choice
    choices: [a, a]
    scopes: [organization]
    capability: org.general.write
    label: sample.d.label
    pages: { org: settings.general }
    deferred: { reason: "Waits on the sample decision for this test fixture.", decision: "Sample decision" }
  - key: org.e
    type: integer
    min: 1
    max: 3
    default: 9
    scopes: [organization]
    capability: org.general.write
    label: sample.e.label
    pages: { org: settings.general }
    deferred: { reason: "Waits on the sample decision for this test fixture.", decision: "Sample decision" }
  - key: org.f
    type: text
    max_length: 2
    default: long
    scopes: [organization]
    capability: org.general.write
    label: sample.f.label
    pages: { org: settings.general }
    deferred: { reason: "Waits on the sample decision for this test fixture.", decision: "Sample decision" }
`;
    const issues = issuesOf(yaml);
    expect(issues.some((i) => i.includes("repeats a choice"))).toBe(true);
    expect(issues.filter((i) => i.includes("default that does not fit"))).toHaveLength(2);
  });
});

describe("rendered SQL", () => {
  it("renders every option of define_setting", () => {
    const [s] = parseSettingsFiles(files(VALID), CAPS);
    if (!s) throw new Error("parsed nothing");
    expect(renderDefineSetting(s)).toBe(
      "select private.define_setting('org.sample', 'Choice', 'org.general.write', array['organization', 'personal'], true, p_default_text => 'a', p_choices => array['a', 'b']);",
    );
    expect(
      renderDefineSetting({ ...s, type: "integer", choices: [], default: 3, min: 1, max: 5 }),
    ).toContain("p_default_integer => 3, p_min_integer => 1, p_max_integer => 5");
    expect(
      renderDefineSetting({ ...s, type: "boolean", choices: [], default: false, lockable: false }),
    ).toContain("false, p_default_boolean => false");
    expect(
      renderDefineSetting({ ...s, type: "text", choices: [], default: "it's", maxLength: 9 }),
    ).toContain("p_default_text => 'it''s', p_max_length => 9");
    expect(renderContributorSql([s], "x1")).toBe(renderDefineSetting(s));
    expect(renderContributorSql([s], "x2")).toBe("");
  });

  it("detects drift between the registry and migrations", () => {
    const [s] = parseSettingsFiles(files(VALID), CAPS);
    if (!s) throw new Error("parsed nothing");
    const statement = renderDefineSetting(s);
    expect(registryDrift([s], [statement])).toEqual([]);
    expect(registryDrift([s], [])).toEqual(["org.sample is not defined by any migration"]);
    expect(registryDrift([s], [statement.replace("true", "false")])).toEqual([
      "org.sample differs from its latest migration",
    ]);
    const stray = statement.replaceAll("org.sample", "org.stray");
    expect(registryDrift([s], [statement, stray])).toEqual([
      "org.stray is defined in a migration but in no registry file",
    ]);
    expect(registryDrift([s], [stray, statement], (k) => k === "org.stray")).toEqual([]);
    expect(definedStatements(["select private.define_setting('it''s', 'Text');"]).has("it's")).toBe(
      true,
    );
  });
});

describe("the committed registry", () => {
  const settings = loadSettingsRegistry();

  it("loads every contributor file", () => {
    expect(readSettingsFiles().size).toBeGreaterThan(0);
    expect(settings.length).toBeGreaterThan(0);
  });

  it("matches the generated module", async () => {
    const target = join(packageRoot, GENERATED_PATH);
    const options = (await resolveConfig(target)) ?? {};
    const expected = await format(renderRegistryModule(settings), { ...options, filepath: target });
    expect(readFileSync(target, "utf8")).toBe(expected);
    expect(SETTINGS).toEqual(settings);
  });

  it("is declared in the database by the migrations", () => {
    const migrations = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => readFileSync(join(migrationsDir, f), "utf8"));
    expect(registryDrift(settings, migrations)).toEqual([]);
  });

  it("offers helpers for pages", () => {
    expect(settingsForPage(settings, "settings.localization").length).toBeGreaterThan(0);
    expect(pageGroup("workspace")).toBe("org");
    expect(dbValueType("text")).toBe("Text");
    expect(dbValueType("boolean")).toBe("Boolean");
    expect(dbValueType("integer")).toBe("Integer");
    expect(dbValueType("choice")).toBe("Choice");
  });
});
