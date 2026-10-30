import type { XosClient } from "@xos/data";
import { clearPersonalSetting, setPersonalSetting } from "@xos/data/settings";
import { getMessages } from "@xos/i18n";
import { toE164 } from "@xos/i18n/formats";
import { SETTINGS, type SettingDefinition } from "@xos/schemas/settings";
import type { Mutation } from "@xos/sync";
import { describe, expect, it } from "vitest";
import { withQueuedSettings } from "../src/domain/queuedSettings";
import { withQueuedSetting } from "../src/domain/settings";
import {
  checkAwayPeriod,
  checkSettingValue,
  choiceLabelKey,
  controlOf,
  deviceNoteKey,
  isIsoDate,
  PERSONAL_MIRROR,
  personalClear,
  personalRows,
  personalWrite,
  registryKeys,
  sectionSettings,
  settingOf,
  sourceKey,
} from "../src/settings/preferences";

/**
 * The person's registered settings on Compass's Preferences, Accessibility, Out of Office and Work Details screens
 * (A111, S4.5.6-44): the registry decides what each screen shows, so the three shells show one set, and a change
 * queues as the same RPC Atlas and Gateway call.
 */

const def = (key: string): SettingDefinition => {
  const found = SETTINGS.find((s) => s.key === key);
  if (!found) throw new Error(key);
  return found;
};

/** The value, or a failed test when it is missing. */
function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("expected a value");
  return value;
}

function lookup(tree: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (node, key) =>
        typeof node === "object" && node !== null
          ? (node as Record<string, unknown>)[key]
          : undefined,
      tree,
    );
}

function recordingClient() {
  const calls: { name: string; args: unknown }[] = [];
  const db = {
    rpc: (name: string, args: unknown) => {
      calls.push({ name, args });
      return Promise.resolve({ data: "01920000-0000-7000-8000-00000000aaaa", error: null });
    },
  };
  return { db: db as unknown as XosClient, calls };
}

describe("what each section shows", () => {
  it("is every setting the registry puts on the section's page, as Gateway shows it", () => {
    expect(sectionSettings("settings.accessibility").map((s) => s.key)).toEqual([
      "me.text_size",
      "me.high_contrast",
      "me.reduced_motion",
      "me.haptics",
      "me.sounds",
      "me.captions",
    ]);
    expect(sectionSettings("settings.out-of-office").map((s) => s.key)).toEqual([
      "me.out_of_office.enabled",
      "me.out_of_office.starts_on",
      "me.out_of_office.ends_on",
      "me.out_of_office.auto_reply",
    ]);
    expect(sectionSettings("settings.work-details").map((s) => s.key)).toEqual([
      "workforce.work_phone",
    ]);
  });

  it("keeps language, time zone, date and number formats and the start page on Preferences", () => {
    const keys = sectionSettings("settings.preferences").map((s) => s.key);
    for (const key of [
      "locale.language",
      "locale.time_zone",
      "locale.date_format",
      "locale.units",
      "shell.start_page",
    ]) {
      expect(keys).toContain(key);
    }
  });

  it("leaves the theme to Settings itself, where Sunlight sits beside it", () => {
    expect(registryKeys()).not.toContain("me.theme");
  });

  it("never offers a dashboard layout, which a person arranges on its Atlas dashboard (A129)", () => {
    expect(registryKeys()).not.toContain("me.dashboard_layout.home");
    expect(registryKeys()).not.toContain("me.dashboard_layout.partner");
  });

  it("never offers a hidden setting", () => {
    const hidden: SettingDefinition = { ...def("me.sounds"), key: "me.secret", hidden: true };
    expect(
      sectionSettings("settings.accessibility", [...SETTINGS, hidden]).map((s) => s.key),
    ).not.toContain("me.secret");
  });

  it("labels every setting and choice it shows in both launch languages", () => {
    for (const locale of ["en-US", "es-US"] as const) {
      const messages = getMessages(locale);
      for (const key of registryKeys()) {
        const setting = def(key);
        expect(typeof lookup(messages, setting.label), `${locale} ${setting.label}`).toBe("string");
        if (setting.help)
          expect(typeof lookup(messages, setting.help), setting.help).toBe("string");
        for (const choice of setting.choices) {
          const label = choiceLabelKey(key, choice);
          expect(typeof lookup(messages, label), `${locale} ${label}`).toBe("string");
        }
      }
    }
  });
});

describe("how a setting is edited on a phone", () => {
  it("picks a control from the registry type and input", () => {
    expect(controlOf(def("me.haptics"))).toBe("switch");
    expect(controlOf(def("me.text_size"))).toBe("segments");
    expect(controlOf(def("shell.start_page"))).toBe("segments");
    expect(controlOf(def("locale.language"))).toBe("choices");
    expect(controlOf(def("locale.time_zone"))).toBe("zone");
    expect(controlOf(def("me.out_of_office.starts_on"))).toBe("date");
    expect(controlOf(def("me.out_of_office.auto_reply"))).toBe("multiline");
    expect(controlOf(def("workforce.work_phone"))).toBe("text");
  });
});

describe("the values the screens show", () => {
  const rows = personalRows(
    [
      {
        setting_key: "locale.language",
        value_text: "es-US",
        value_boolean: null,
        value_integer: null,
        source: "Organization",
        locked: true,
      },
      {
        setting_key: "me.haptics",
        value_text: null,
        value_boolean: false,
        value_integer: null,
        source: "Personal",
        locked: false,
      },
      {
        setting_key: "time.kiosk_enabled",
        value_text: null,
        value_boolean: true,
        value_integer: null,
        source: "Organization",
        locked: false,
      },
    ],
    registryKeys(),
  );

  it("keep only the settings the sections show, with source and lock", () => {
    expect(rows).toEqual([
      { id: "locale.language", value: "es-US", source: "Organization", locked: true },
      { id: "me.haptics", value: false, source: "Personal", locked: false },
    ]);
  });

  it("say where a value comes from, and who locked it", () => {
    const language = settingOf(def("locale.language"), rows[0]);
    expect(language).toEqual({
      key: "locale.language",
      value: "es-US",
      source: "Organization",
      locked: true,
    });
    expect(sourceKey(language)).toBe("settings.source.lockedForYou");
    expect(sourceKey(settingOf(def("me.haptics"), rows[1]))).toBe(
      "settings.source.personalPersonal",
    );
  });

  it("show the registry default before the first read", () => {
    expect(settingOf(def("me.text_size"), undefined)).toEqual({
      key: "me.text_size",
      value: "default",
      source: "Default",
      locked: false,
    });
    expect(
      settingOf(def("me.persona"), { id: "me.persona", value: null, source: "Default" }).value,
    ).toBeNull();
  });

  it("note what Compass does without the person's own zone or language", () => {
    const zone = (source: string) =>
      deviceNoteKey(
        settingOf(def("locale.time_zone"), { id: "locale.time_zone", value: "UTC", source }),
      );
    expect(zone("Organization")).toBe("compassPersonal.registry.deviceZone");
    expect(zone("Personal")).toBeNull();
    const language = (source: string) =>
      deviceNoteKey(
        settingOf(def("locale.language"), { id: "locale.language", value: "en-US", source }),
      );
    expect(language("Default")).toBe("compassPersonal.registry.deviceLanguage");
    expect(language("Organization")).toBeNull();
    expect(deviceNoteKey(settingOf(def("me.sounds"), undefined))).toBeNull();
  });
});

describe("a typed value", () => {
  it("must be a registered choice", () => {
    expect(checkSettingValue(def("locale.units"), "metric")).toEqual({ ok: true, value: "metric" });
    expect(checkSettingValue(def("locale.units"), "nautical")).toEqual({
      ok: false,
      problem: "setting_choice",
    });
  });

  it("must match the setting's type", () => {
    expect(checkSettingValue(def("me.sounds"), false)).toEqual({ ok: true, value: false });
    expect(checkSettingValue(def("me.sounds"), "false")).toEqual({
      ok: false,
      problem: "setting_value_type",
    });
    expect(checkSettingValue(def("locale.units"), true)).toEqual({
      ok: false,
      problem: "setting_value_type",
    });
  });

  it("is checked against an integer setting's range", () => {
    const count: SettingDefinition = { ...def("me.sounds"), type: "integer", min: 1, max: 5 };
    expect(checkSettingValue(count, "3")).toEqual({ ok: true, value: 3 });
    expect(checkSettingValue(count, "9")).toEqual({ ok: false, problem: "setting_value_type" });
  });

  it("is text no longer than the registry allows, blank meaning none", () => {
    const phone = def("workforce.work_phone");
    expect(checkSettingValue(phone, " +13055550142 ")).toEqual({
      ok: true,
      value: "+13055550142",
    });
    expect(checkSettingValue(phone, "  ")).toEqual({ ok: true, value: null });
    expect(checkSettingValue(phone, "5".repeat(33))).toEqual({
      ok: false,
      problem: "setting_too_long",
    });
  });

  it("is a phone read into E.164 in the person's region, refusing anything else (A139)", () => {
    const phone = def("workforce.work_phone");
    const inUs = (input: string) => toE164(input, "US");
    expect(phone.input).toBe("phone");
    expect(checkSettingValue(phone, "(305) 555-0142", inUs)).toEqual({
      ok: true,
      value: "+13055550142",
    });
    expect(checkSettingValue(phone, "+44 20 7946 0958", inUs)).toEqual({
      ok: true,
      value: "+442079460958",
    });
    expect(checkSettingValue(phone, "desk 4412", inUs)).toEqual({ ok: false, problem: "phone" });
    expect(checkSettingValue(phone, "+1 305 555 0142")).toEqual({ ok: false, problem: "phone" });
  });

  it("is a zone the phone knows", () => {
    expect(checkSettingValue(def("locale.time_zone"), "America/Chicago").ok).toBe(true);
    expect(checkSettingValue(def("locale.time_zone"), "America/Atlantis")).toEqual({
      ok: false,
      problem: "zone",
    });
  });

  it("is a real date", () => {
    expect(checkSettingValue(def("me.out_of_office.starts_on"), "2026-11-02").ok).toBe(true);
    expect(checkSettingValue(def("me.out_of_office.starts_on"), "2026-02-30")).toEqual({
      ok: false,
      problem: "date",
    });
    expect(isIsoDate("2028-02-29")).toBe(true);
    expect(isIsoDate("11/02/2026")).toBe(false);
  });
});

describe("an out-of-office period", () => {
  it("cannot end before it starts; either date may be blank", () => {
    expect(checkAwayPeriod("2026-11-02", "2026-11-09")).toBeNull();
    expect(checkAwayPeriod("2026-11-02", "2026-11-02")).toBeNull();
    expect(checkAwayPeriod("2026-11-09", "2026-11-02")).toBe("order");
    expect(checkAwayPeriod(null, "2026-11-02")).toBeNull();
    expect(checkAwayPeriod("2026-11-02", null)).toBeNull();
  });
});

describe("a change", () => {
  it("queues the RPC Atlas and Gateway call, with its optimistic row", async () => {
    const write = must(personalWrite("locale.units", undefined, "metric"));
    expect(write).toEqual({
      op: "rpc",
      target: "set_personal_setting",
      table: PERSONAL_MIRROR,
      rowId: "locale.units",
      payload: { p_setting_key: "locale.units", p_value_text: "metric" },
      policy: "append",
      optimistic: { id: "locale.units", value: "metric", source: "Personal", locked: false },
    });
    const { db, calls } = recordingClient();
    await setPersonalSetting(db, { key: "locale.units", value: "metric" });
    expect(calls).toEqual([{ name: write.target, args: write.payload }]);
  });

  it("names the typed value argument", () => {
    expect(personalWrite("me.sounds", undefined, false)?.payload).toEqual({
      p_setting_key: "me.sounds",
      p_value_boolean: false,
    });
    expect(personalWrite("x.count", undefined, 4)?.payload).toEqual({
      p_setting_key: "x.count",
      p_value_integer: 4,
    });
  });

  it("sends nothing when the value is already the person's", () => {
    const row = { id: "me.sounds", value: false, source: "Personal", locked: false };
    expect(personalWrite("me.sounds", row, false)).toBeNull();
    expect(personalWrite("me.sounds", { ...row, source: "Default" }, false)).not.toBeNull();
  });

  it("back to the inherited value clears the person's own and shows the default until the next read", async () => {
    const row = { id: "locale.time_zone", value: "Europe/Rome", source: "Personal", locked: false };
    const clear = must(personalClear(def("locale.time_zone"), row));
    expect(clear).toMatchObject({
      target: "clear_personal_setting",
      payload: { p_setting_key: "locale.time_zone" },
      optimistic: { id: "locale.time_zone", value: "UTC", source: "Default", locked: false },
    });
    expect(personalClear(def("locale.time_zone"), { ...row, source: "Organization" })).toBeNull();
    const { db, calls } = recordingClient();
    await clearPersonalSetting(db, { key: "locale.time_zone" });
    expect(calls).toEqual([{ name: clear.target, args: clear.payload }]);
  });
});

describe("a queued change to a setting Compass applies", () => {
  const values = new Map<string, unknown>([
    ["me.haptics", false],
    ["locale.time_zone", "Europe/Rome"],
  ]);
  const queued = (seq: number, target: string, payload: Record<string, unknown>): Mutation =>
    ({
      id: `m${seq}`,
      seq,
      op: "rpc",
      target,
      table: PERSONAL_MIRROR,
      rowId: String(payload["p_setting_key"]),
      payload,
      status: "pending",
    }) as unknown as Mutation;

  it("applies at once, set from these screens as from Settings", () => {
    const write = must(personalWrite("me.haptics", undefined, true));
    expect(withQueuedSetting(values, write).get("me.haptics")).toBe(true);
  });

  it("falls back to what Compass does without a value while a clear waits", () => {
    const clear = must(
      personalClear(def("locale.time_zone"), {
        id: "locale.time_zone",
        value: "Europe/Rome",
        source: "Personal",
      }),
    );
    const next = withQueuedSetting(values, clear);
    expect(next.has("locale.time_zone")).toBe(false);
    expect(values.get("locale.time_zone")).toBe("Europe/Rome");
    expect(withQueuedSetting(next, clear)).toBe(next);
  });

  it("lays set and clear over a resolve in queue order, the latest winning", () => {
    const over = withQueuedSettings(values, [
      queued(2, "clear_personal_setting", { p_setting_key: "locale.time_zone" }),
      queued(1, "set_personal_setting", { p_setting_key: "locale.time_zone", p_value_text: "UTC" }),
      queued(3, "set_personal_setting", { p_setting_key: "me.haptics", p_value_boolean: true }),
    ]);
    expect(over.has("locale.time_zone")).toBe(false);
    expect(over.get("me.haptics")).toBe(true);
  });
});
