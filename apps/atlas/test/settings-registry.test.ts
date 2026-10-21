import { describe, expect, it } from "vitest";
import { getMessages } from "@xos/i18n";
import type { SettingDefinition } from "@xos/schemas/settings";
import { planHasFeature } from "../lib/settings/plan";
import {
  choiceLabelKey,
  formText,
  pageSettings,
  parseSettingValue,
  settingByKey,
  settingErrorKey,
  workspaceSettings,
} from "../lib/settings/registry";

const base: SettingDefinition = {
  key: "test.text",
  contributor: "a30",
  type: "text",
  scopes: ["organization"],
  capability: "org.general.write",
  lockable: false,
  default: null,
  choices: [],
  min: null,
  max: null,
  maxLength: 5,
  input: "text",
  label: "settings.fields.legalName.label",
  help: null,
  pages: { org: "settings.general" },
  deferred: false,
  hidden: false,
};

describe("registry lookups", () => {
  it("finds settings by key, page and workspace scope", () => {
    expect(settingByKey("locale.time_zone")?.lockable).toBe(true);
    expect(settingByKey("missing.key")).toBeUndefined();
    expect(pageSettings("settings.localization", "org").map((s) => s.key)).toContain(
      "locale.time_zone",
    );
    expect(pageSettings("me.preferences", "personal").map((s) => s.key)).toContain("me.theme");
    expect(workspaceSettings().every((s) => s.scopes.includes("workspace"))).toBe(true);
    expect(choiceLabelKey("shell.start_page", "my-work")).toBe(
      "settings.choices.shell_start_page.my-work",
    );
  });

  it("maps repository errors to catalog keys", () => {
    expect(settingErrorKey({ kind: "refusal", rule: "setting_locked", message: "" })).toBe(
      "setting_locked",
    );
    expect(settingErrorKey({ kind: "refusal", rule: "other_rule", message: "" })).toBe(
      "unexpected",
    );
    expect(settingErrorKey({ kind: "not-found" })).toBe("denied");
    expect(settingErrorKey({ kind: "conflict", message: "" })).toBe("conflict");
    expect(settingErrorKey({ kind: "invalid", message: "" })).toBe("invalid");
    expect(settingErrorKey({ kind: "unexpected", message: "" })).toBe("unexpected");
  });

  // A69-007 (migration 1299): settings nothing enforces keep their defaults, and the page says why.
  it("explains a refused unenforced security setting in both locales", () => {
    expect(settingErrorKey({ kind: "refusal", rule: "setting_not_enforced", message: "" })).toBe(
      "setting_not_enforced",
    );
    for (const locale of ["en-US", "es-US"] as const) {
      const catalog = (
        getMessages(locale) as unknown as {
          settings: {
            errors: Record<string, string>;
            fields: Record<string, { help: string }>;
          };
        }
      ).settings;
      expect(catalog.errors["setting_not_enforced"]).toMatch(/\S/);
      for (const field of ["mfaPolicy", "sessionHours", "idleTimeout"] as const) {
        expect(catalog.fields[field]?.help).toMatch(/XOS/);
      }
    }
  });

  // ADR 0038 (migration 1329): record keys are fixed, so numbering.record_key_format is on no page and its
  // writes are refused with setting_fixed.
  it("keeps the fixed record key format off every page and explains a refused write", () => {
    expect(settingByKey("numbering.record_key_format")?.hidden).toBe(true);
    expect(pageSettings("settings.numbering", "org").map((s) => s.key)).toEqual([
      "numbering.document_number_padding",
    ]);
    expect(settingErrorKey({ kind: "refusal", rule: "setting_fixed", message: "" })).toBe(
      "setting_fixed",
    );
    for (const locale of ["en-US", "es-US"] as const) {
      const catalog = (
        getMessages(locale) as unknown as { settings: { errors: Record<string, string> } }
      ).settings;
      expect(catalog.errors["setting_fixed"]).toMatch(/\S/);
    }
  });
});

describe("parsing submitted values", () => {
  it("parses booleans, integers and choices", () => {
    expect(parseSettingValue({ ...base, type: "boolean" }, "on")).toEqual({
      ok: true,
      value: true,
    });
    expect(parseSettingValue({ ...base, type: "boolean" }, null)).toEqual({
      ok: true,
      value: false,
    });
    const int = { ...base, type: "integer" as const, min: 1, max: 12 };
    expect(parseSettingValue(int, " 7 ")).toEqual({ ok: true, value: 7 });
    expect(parseSettingValue(int, "13")).toEqual({ ok: false, error: "setting_out_of_range" });
    expect(parseSettingValue(int, "seven")).toEqual({ ok: false, error: "integer" });
    const choice = { ...base, type: "choice" as const, choices: ["a", "b"] };
    expect(parseSettingValue(choice, "b")).toEqual({ ok: true, value: "b" });
    expect(parseSettingValue(choice, "c")).toEqual({ ok: false, error: "setting_choice" });
  });

  it("checks text by its input kind", () => {
    expect(parseSettingValue(base, "")).toEqual({ ok: false, error: "required" });
    expect(parseSettingValue(base, "toolong")).toEqual({ ok: false, error: "setting_too_long" });
    expect(parseSettingValue(base, "fine")).toEqual({ ok: true, value: "fine" });
    const text = { ...base, maxLength: null };
    const cases: [SettingDefinition["input"], string, boolean][] = [
      ["email", "a@b.co", true],
      ["email", "nope", false],
      ["url", "https://example.com/help", true],
      ["url", "ftp://example.com", false],
      ["url", "not a url", false],
      ["date", "2026-12-24", true],
      ["date", "24/12/2026", false],
      ["currency", "USD", true],
      ["currency", "usd", false],
      ["time_zone", "America/New_York", true],
      ["time_zone", "Mars/Olympus", false],
      ["workspace", "01920000-0000-7000-8000-000000000401", true],
      ["workspace", "miami", false],
      ["multiline", "line one\nline two", true],
    ];
    for (const [input, raw, valid] of cases) {
      expect(parseSettingValue({ ...text, input }, raw).ok, `${input} ${raw}`).toBe(valid);
    }
  });

  it("renders values as form text", () => {
    expect(formText(null)).toBe("");
    expect(formText(true)).toBe("on");
    expect(formText(false)).toBe("");
    expect(formText(4)).toBe("4");
    expect(formText("x")).toBe("x");
  });
});

describe("plan features", () => {
  it("follows the extends chain", () => {
    expect(planHasFeature("team", "white_label")).toBe(true);
    expect(planHasFeature("pro", "custom_domain")).toBe(true);
    expect(planHasFeature("core", "white_label")).toBe(false);
    expect(planHasFeature("access", "white_label")).toBe(false);
    expect(planHasFeature("unknown", "white_label")).toBe(false);
  });
});
