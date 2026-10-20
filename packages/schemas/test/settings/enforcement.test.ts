import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  loadSettingsWithEnforcement,
  parseSettingsRegistry,
  SettingsRegistryError,
} from "../../src/settings/load.ts";
import { SETTINGS } from "../../src/settings/index.ts";

/**
 * The A65-001 regression guard (ADR 0032): every registered setting names where it takes effect, a consumer
 * module or migration that reads its key and a test that changes it and observes the behavior, or a recorded
 * reason it is deferred. A setting that is stored, audited and read by nothing cannot be added.
 */

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const CAPS = new Set(["org.general.write"]);
const { settings, enforcement } = loadSettingsWithEnforcement();

function read(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("every setting takes effect or says why not", () => {
  it("covers every registered setting", () => {
    expect(enforcement.size).toBe(settings.length);
    for (const s of settings) expect(enforcement.has(s.key), s.key).toBe(true);
  });

  for (const s of settings) {
    const e = enforcement.get(s.key);
    if (e?.kind !== "enforced") continue;
    it(`${s.key} is read by its consumers and changed by their tests`, () => {
      for (const { consumer, test } of e.by) {
        const [file = "", symbol] = consumer.split("#");
        expect(existsSync(join(repoRoot, file)), `${s.key}: ${file} exists`).toBe(true);
        const source = read(file);
        expect(source.includes(s.key), `${s.key}: ${file} reads the key`).toBe(true);
        if (symbol)
          expect(source.includes(symbol), `${s.key}: ${file} defines ${symbol}`).toBe(true);
        expect(existsSync(join(repoRoot, test)), `${s.key}: ${test} exists`).toBe(true);
        expect(read(test).includes(s.key), `${s.key}: ${test} changes the key`).toBe(true);
      }
    });
  }

  it("defers only the settings that wait on a recorded decision", () => {
    const deferred = [...enforcement]
      .filter(([, e]) => e.kind === "deferred")
      .map(([key]) => key)
      .sort();
    // Adding a deferral is a decision: name it here with its reason in the registry file.
    expect(deferred).toEqual([
      "communication.auto_translate",
      "me.captions",
      "numbering.record_key_format",
      "security.idle_timeout_minutes",
      "security.mfa_policy",
      "security.session_hours",
    ]);
    for (const key of deferred) {
      const e = enforcement.get(key);
      if (e?.kind !== "deferred") throw new Error(key);
      expect(e.deferral.decision.length, key).toBeGreaterThan(4);
      expect(e.deferral.reason.length, key).toBeGreaterThan(19);
    }
  });

  it("marks deferred settings in the generated registry so pages can say so", () => {
    for (const s of SETTINGS) {
      expect(s.deferred, s.key).toBe(enforcement.get(s.key)?.kind === "deferred");
    }
  });

  it("keeps the fixed record key format off every screen (ADR 0038)", () => {
    const hidden = SETTINGS.filter((s) => s.hidden).map((s) => s.key);
    expect(hidden).toEqual(["numbering.record_key_format"]);
    for (const s of SETTINGS.filter((d) => d.hidden)) {
      expect(s.pages, s.key).toEqual({});
      expect(s.deferred, s.key).toBe(true);
    }
  });
});

describe("the registry refuses a setting without a consumer", () => {
  const base = `contributor: x1
settings:
  - key: org.sample
    type: boolean
    default: false
    scopes: [organization]
    capability: org.general.write
    label: sample.fields.sample.label
    pages: { org: settings.general }
`;

  function issues(yaml: string): string[] {
    try {
      parseSettingsRegistry(new Map([["x1.yaml", yaml]]), CAPS);
      return [];
    } catch (error) {
      if (error instanceof SettingsRegistryError) return [...error.issues];
      throw error;
    }
  }

  it("names a setting that nothing reads", () => {
    expect(issues(base).some((i) => i.includes("org.sample names no consumer"))).toBe(true);
  });

  it("hides a setting only when it is deferred and on no page", () => {
    const deferred = `    deferred: { reason: "Waits on a decision about the sample.", decision: "Sample decision" }
`;
    const onPage = `${base}    hidden: true
${deferred}`;
    expect(issues(onPage).some((i) => i.includes("is hidden but names a page"))).toBe(true);
    const noPage = base.replace("pages: { org: settings.general }", "pages: {}");
    expect(issues(`${noPage}    hidden: true\n`).some((i) => i.includes("must be deferred"))).toBe(
      true,
    );
    expect(issues(`${noPage}    hidden: true\n${deferred}`)).toEqual([]);
    expect(issues(`${noPage}${deferred}`).some((i) => i.includes("needs a org page"))).toBe(true);
  });

  it("refuses a setting both enforced and deferred", () => {
    const both = `${base}    enforced_by:
      - consumer: packages/schemas/src/settings/load.ts
        test: packages/schemas/test/settings/enforcement.test.ts
    deferred: { reason: "Waits on a decision about the sample.", decision: "Sample decision" }
`;
    expect(issues(both).some((i) => i.includes("both enforced and deferred"))).toBe(true);
  });

  it("refuses consumers and tests outside the repository's source folders", () => {
    const wrong = `${base}    enforced_by:
      - consumer: ../elsewhere/consumer.ts
        test: notes.md
`;
    expect(issues(wrong).length).toBeGreaterThan(0);
  });

  it("accepts a setting with a consumer and its test", () => {
    const fine = `${base}    enforced_by:
      - consumer: packages/schemas/src/settings/load.ts#parseSettingsRegistry
        test: packages/schemas/test/settings/enforcement.test.ts
`;
    const parsed = parseSettingsRegistry(new Map([["x1.yaml", fine]]), CAPS);
    expect(parsed.enforcement.get("org.sample")).toEqual({
      kind: "enforced",
      by: [
        {
          consumer: "packages/schemas/src/settings/load.ts#parseSettingsRegistry",
          test: "packages/schemas/test/settings/enforcement.test.ts",
        },
      ],
    });
    expect(parsed.settings[0]?.deferred).toBe(false);
  });
});
