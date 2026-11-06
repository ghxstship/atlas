import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import enUS from "../../i18n/messages/en-US/workDetails.json" with { type: "json" };
import esUS from "../../i18n/messages/es-US/workDetails.json" with { type: "json" };
import type { XosClient } from "../src/client.ts";
import { looksSensitive, SENSITIVE_WORDS } from "../src/import-parse.ts";
import {
  canonicalNotice,
  giveSensitiveConsent,
  listGuestNeedsStates,
  listMySensitiveStates,
  sensitiveStepFor,
  ungrantedMealPreferences,
  SENSITIVE_CATEGORIES,
  SENSITIVE_NOTICE_KEYS,
  SENSITIVE_NOTICE_VERSIONS,
  setGuestNeeds,
  standingFor,
  withdrawSensitiveConsent,
} from "../src/sensitive-consent.ts";
import { guestNeedsCsv, parseGuestNeedsForm } from "../src/work-details-forms.ts";

const CONSENT_SQL = readFileSync(
  new URL("../../../supabase/migrations/6160_sensitive_data_consent.sql", import.meta.url),
  "utf8",
);
const GUEST_SQL = readFileSync(
  new URL("../../../supabase/migrations/6162_guest_needs_and_attestation.sql", import.meta.url),
  "utf8",
);

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

function rpcClient(data: unknown, error: unknown = null) {
  const rpc = vi.fn().mockResolvedValue({ data, error });
  return { db: { rpc } as unknown as XosClient, rpc };
}

function form(values: Record<string, string | readonly string[]>): FormData {
  const f = new FormData();
  for (const [name, value] of Object.entries(values)) {
    for (const v of typeof value === "string" ? [value] : value) f.append(name, v);
  }
  return f;
}

describe("the wording of a consent", () => {
  it.each(SENSITIVE_CATEGORIES)(
    "%s has the hash of its current version in the database",
    (category) => {
      const key = SENSITIVE_NOTICE_KEYS[category] as keyof typeof enUS.consent.notices;
      const version = SENSITIVE_NOTICE_VERSIONS[category];
      const row = `('${category}', '${version}', '${sha(canonicalNotice(enUS.consent.notices[key]))}', '${sha(canonicalNotice(esUS.consent.notices[key]))}')`;
      // A change to the words needs a new version: a new row in the migration block and in SENSITIVE_NOTICE_VERSIONS.
      expect(CONSENT_SQL).toContain(row);
    },
  );

  it("says what is collected, why, who sees it and how to withdraw, in both languages", () => {
    for (const catalog of [enUS, esUS]) {
      for (const notice of Object.values(catalog.consent.notices)) {
        for (const part of ["title", "collected", "why", "who", "withdraw", "attest"] as const) {
          expect(notice[part].length).toBeGreaterThan(10);
        }
      }
    }
  });

  it("hashes every statement someone ticks and everything an attester reads", () => {
    for (const catalog of [enUS, esUS]) {
      const { dietary, accessibility, diversity } = catalog.consent.notices;
      for (const notice of [dietary, accessibility, diversity]) {
        expect(notice.attestAuthority.length).toBeGreaterThan(10);
        expect(notice.attestNotice.length).toBeGreaterThan(10);
        expect(canonicalNotice(notice)).toContain(notice.attestAuthority);
        expect(canonicalNotice(notice)).toContain(notice.attestNotice);
      }
      for (const notice of [dietary, accessibility]) {
        for (const part of ["attestCollected", "attestWhy", "attestWho"] as const) {
          expect(canonicalNotice(notice)).toContain(notice[part]);
        }
      }
      for (const part of ["mealTitle", "mealBody", "mealWho"] as const) {
        expect(canonicalNotice(dietary)).toContain(dietary[part]);
      }
      expect(catalog.consent.attest).toEqual({ required: catalog.consent.attest.required });
    }
  });

  it("says who reads a meal preference truthfully: the company cannot", () => {
    expect(enUS.consent.notices.dietary.who).toContain("Your company cannot read them");
    expect(enUS.consent.notices.dietary.who).toContain("it cannot read it back");
    expect(enUS.consent.notices.dietary.collected).toContain("meal preference");
    expect(enUS.consent.notices.dietary.withdraw).toContain("Work Details");
    expect(esUS.consent.notices.dietary.withdraw).toContain("Datos de trabajo");
  });

  it("never claims anyone reviewed it", () => {
    const text = JSON.stringify([enUS.consent, esUS.consent]);
    expect(text).not.toMatch(/attorney|counsel|lawyer|abogad|legally/i);
  });
});

describe("what a section shows", () => {
  const grant = { category: "Accessibility", noticeVersion: "2026-11-06", givenAt: "" } as const;
  const state = (over: object) => ({
    category: "Dietary and Allergies" as const,
    waiting: false,
    held: false,
    mealPreferences: [],
    ...over,
  });

  it("is the form only under the person's own standing grant", () => {
    expect(sensitiveStepFor("Accessibility", [grant], [])).toBe("form");
    expect(sensitiveStepFor("Dietary and Allergies", [grant], [])).toBe("first");
  });

  it("says a value waits, also for someone who holds only a meal preference", () => {
    const states = [state({ waiting: true, mealPreferences: ["Halal"] })];
    expect(sensitiveStepFor("Dietary and Allergies", [], states)).toBe("waiting");
    expect(ungrantedMealPreferences(states)).toEqual(["Halal"]);
  });

  it("says a hold keeps a value after a withdrawal, not that it is from before", () => {
    expect(sensitiveStepFor("Dietary and Allergies", [], [state({ held: true })])).toBe("held");
  });

  it("reads the states from the database", async () => {
    const { db, rpc } = rpcClient([
      { category: "Accessibility", waiting: true, held: false, meal_preferences: [] },
    ]);
    const read = await listMySensitiveStates(db);
    expect(read.ok && read.data[0]).toEqual({
      category: "Accessibility",
      waiting: true,
      held: false,
      mealPreferences: [],
    });
    expect(rpc).toHaveBeenCalledWith("my_sensitive_states", {});
  });
});

describe("recording consent", () => {
  it("sends the version, the language and the surface", async () => {
    const { db, rpc } = rpcClient("consent-id");
    const result = await giveSensitiveConsent(db, {
      category: "Accessibility",
      locale: "es-US",
      surface: "Compass",
    });
    expect(result).toEqual({ ok: true, data: { id: "consent-id" } });
    expect(rpc).toHaveBeenCalledWith("give_sensitive_consent", {
      p_category: "Accessibility",
      p_notice_version: SENSITIVE_NOTICE_VERSIONS.Accessibility,
      p_locale: "es-US",
      p_surface: "Compass",
    });
  });

  it("passes the address the web app's server saw, and nothing when there is none", async () => {
    const { db, rpc } = rpcClient("consent-id");
    await giveSensitiveConsent(db, {
      category: "Accessibility",
      locale: "en-US",
      surface: "Atlas",
      clientIp: "203.0.113.9",
    });
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({ p_client_ip: "203.0.113.9" });
    await giveSensitiveConsent(db, {
      category: "Accessibility",
      locale: "en-US",
      surface: "Atlas",
      clientIp: null,
    });
    expect(rpc.mock.calls[1]?.[1]).not.toHaveProperty("p_client_ip");
  });

  it("sends a company's two statements only when given", async () => {
    const { db, rpc } = rpcClient("consent-id");
    await giveSensitiveConsent(db, {
      category: "Supplier Diversity",
      locale: "en-US",
      surface: "Gateway",
      accountId: "account",
      authorityConfirmed: true,
      noticeConfirmed: true,
    });
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({
      p_account_id: "account",
      p_authority_confirmed: true,
      p_notice_confirmed: true,
    });
  });

  it("reports when a legal hold keeps the values", async () => {
    expect(await withdrawSensitiveConsent(rpcClient(false).db, "Accessibility")).toEqual({
      ok: true,
      data: { erased: false },
    });
    expect(await withdrawSensitiveConsent(rpcClient(true).db, "Accessibility")).toEqual({
      ok: true,
      data: { erased: true },
    });
  });

  it("finds the standing grant of a category", () => {
    const grant = {
      category: "Accessibility" as const,
      noticeVersion: "2026-11-06",
      givenAt: "2026-11-06T00:00:00Z",
    };
    expect(standingFor([grant], "Accessibility")).toBe(grant);
    expect(standingFor([grant], "Supplier Diversity")).toBeNull();
  });
});

describe("a guest's needs", () => {
  const entry = "01920000-0000-7000-8000-000000000001";

  it("requires no field", () => {
    const parsed = parseGuestNeedsForm(form({ guestId: entry }));
    expect(parsed).toMatchObject({
      ok: true,
      value: { dietaryNeeds: [], allergies: null, guestEmail: null, authorityConfirmed: false },
    });
  });

  it("names what to fix", () => {
    expect(
      parseGuestNeedsForm(form({ guestId: "nope", guestEmail: "not an email" })),
    ).toMatchObject({
      ok: false,
      fields: expect.arrayContaining(["guestId", "guestEmail"]),
    });
  });

  it("keeps only known needs, and the statements as sent", () => {
    const parsed = parseGuestNeedsForm(
      form({
        guestId: entry,
        dietaryNeeds: ["Vegan", "Made Up"],
        accessibilityNeeds: ["Seating"],
        authorityConfirmed: "true",
        noticeConfirmed: "true",
      }),
    );
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        dietaryNeeds: ["Vegan"],
        accessibilityNeeds: ["Seating"],
        authorityConfirmed: true,
        noticeConfirmed: true,
      },
    });
  });

  it("sends the attestation with the wording's version", async () => {
    const { db, rpc } = rpcClient("needs-id");
    await setGuestNeeds(db, {
      guestListEntryId: entry,
      dietaryNeeds: ["Vegan"],
      allergies: "Peanuts",
      dietaryNotes: null,
      accessibilityNeeds: [],
      accessibilityNotes: null,
      guestEmail: null,
      authorityConfirmed: true,
      noticeConfirmed: true,
      locale: "en-US",
      surface: "Atlas",
    });
    expect(rpc.mock.calls[0]?.[0]).toBe("set_guest_care_needs");
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({
      p_authority_confirmed: true,
      p_notice_confirmed: true,
      p_dietary_notice_version: SENSITIVE_NOTICE_VERSIONS["Dietary and Allergies"],
      p_accessibility_notice_version: SENSITIVE_NOTICE_VERSIONS.Accessibility,
      p_allergies: "Peanuts",
    });
  });

  it("reads who keeps the list the state, never a value", async () => {
    const { db } = rpcClient([
      {
        guest_list_entry_id: entry,
        categories: ["Accessibility"],
        given_by_name: "Carol",
        given_at: "2026-11-06T00:00:00Z",
      },
    ]);
    const states = await listGuestNeedsStates(db, "project");
    expect(states.ok && Object.keys(states.data[0] ?? {})).toEqual([
      "guestListEntryId",
      "categories",
      "givenByName",
      "givenAt",
    ]);
  });

  it("downloads as CSV for whoever may read it", () => {
    const csv = guestNeedsCsv([
      {
        guestListEntryId: entry,
        guestName: "Jordan, Vale",
        dietaryNeeds: ["Vegan", "Kosher"],
        allergies: "Peanuts",
        dietaryNotes: null,
        accessibilityNeeds: [],
        accessibilityNotes: null,
      },
    ]);
    expect(csv).toContain('"Jordan, Vale",Vegan; Kosher,Peanuts,,,');
  });
});

describe("free text with no consent step", () => {
  it("uses the same words as the database", () => {
    expect(GUEST_SQL).toContain(`(${SENSITIVE_WORDS})`);
  });

  it.each(["Nut allergy", "Vegan", "wheelchair", "silla de ruedas", "Halal meal", "women-owned"])(
    "%s reads as sensitive",
    (text) => expect(looksSensitive(text)).toBe(true),
  );

  it.each(["Side stage", "Press", "VIP table 4", "Producer's guest"])("%s does not", (text) =>
    expect(looksSensitive(text)).toBe(false),
  );
});
