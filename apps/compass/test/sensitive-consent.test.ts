import type { XosClient } from "@xos/data";
import {
  giveSensitiveConsent,
  listMySensitiveConsents,
  listMySensitiveStates,
  rosterMealConsentStands,
  sensitiveStepFor,
  ungrantedMealPreferences,
  withdrawSensitiveConsent,
} from "@xos/data/sensitive-consent";
import { describe, expect, it } from "vitest";
import enUS from "../../../packages/i18n/messages/en-US/workDetails.json" with { type: "json" };
import esUS from "../../../packages/i18n/messages/es-US/workDetails.json" with { type: "json" };
import { saveProjectFact } from "../src/domain/projectDetails";

/**
 * Consent for sensitive data in Compass (ADR 0164): the Work Details cards and the project's meal preference choose their
 * step from what the database says, and every act is an RPC with Compass as the surface, never the offline queue. A
 * Maestro journey needs a device; this holds the rules the screens depend on.
 */

function recordingClient(answers: Record<string, unknown> = {}) {
  const calls: { name: string; args: unknown }[] = [];
  const db = {
    rpc: (name: string, args: unknown) => {
      calls.push({ name, args });
      return Promise.resolve({ data: answers[name] ?? null, error: null });
    },
    from: (table: string) => {
      throw new Error(`no table writes: ${table}`);
    },
  } as unknown as XosClient;
  return { db, calls };
}

describe("the consent step on the phone", () => {
  it("records the wording's version, the language and Compass as the surface", async () => {
    const { db, calls } = recordingClient({ give_sensitive_consent: "consent-id" });
    await giveSensitiveConsent(db, {
      category: "Dietary and Allergies",
      locale: "es-US",
      surface: "Compass",
    });
    expect(calls[0]?.name).toBe("give_sensitive_consent");
    expect(calls[0]?.args).toMatchObject({ p_locale: "es-US", p_surface: "Compass" });
    // The phone calls the database directly, so the database reads the address from the request.
    expect(calls[0]?.args).not.toHaveProperty("p_client_ip");
  });

  it("withdraws in one call and says when a legal hold keeps the values", async () => {
    const { db, calls } = recordingClient({ withdraw_sensitive_consent: false });
    const held = await withdrawSensitiveConsent(db, "Accessibility");
    expect(calls.map((c) => c.name)).toEqual(["withdraw_sensitive_consent"]);
    expect(held).toEqual({ ok: true, data: { erased: false } });
  });

  it("shows the waiting step to someone who holds only a meal preference", async () => {
    const { db } = recordingClient({
      my_sensitive_consents: [],
      my_sensitive_states: [
        {
          category: "Dietary and Allergies",
          waiting: true,
          held: false,
          meal_preferences: ["Halal"],
        },
      ],
    });
    const consents = await listMySensitiveConsents(db);
    const states = await listMySensitiveStates(db);
    expect(consents.ok && states.ok).toBe(true);
    if (!consents.ok || !states.ok) return;
    expect(sensitiveStepFor("Dietary and Allergies", consents.data, states.data)).toBe("waiting");
    expect(sensitiveStepFor("Accessibility", consents.data, states.data)).toBe("first");
    expect(ungrantedMealPreferences(states.data)).toEqual(["Halal"]);
  });

  it("asks the database whether the meal preference field shows", async () => {
    const { db, calls } = recordingClient({ roster_meal_consent_stands: true });
    expect(await rosterMealConsentStands(db, "entry")).toBe(true);
    expect(calls[0]).toEqual({
      name: "roster_meal_consent_stands",
      args: { p_roster_entry_id: "entry" },
    });
  });

  it("saves a meal preference through the project's RPC, so the database decides", async () => {
    const { db, calls } = recordingClient({ save_roster_travel_request: "row" });
    await saveProjectFact(db, "00000000-0000-4000-8000-000000000001", "Travel", {
      inboundAirportCode: "MIA",
      mealPreference: "Halal",
    });
    expect(calls[0]?.name).toBe("save_roster_travel_request");
    expect(calls[0]?.args).toMatchObject({ p_meal_preference: "Halal" });
  });

  it("has every string the phone reads, in both languages", () => {
    for (const catalog of [enUS, esUS]) {
      for (const key of ["waiting", "held", "onFile", "mealOnFile", "confirm"] as const) {
        expect(catalog.consent.gate[key].length).toBeGreaterThan(3);
      }
    }
  });
});
