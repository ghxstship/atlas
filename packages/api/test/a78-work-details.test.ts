/**
 * Contract tests for the Work Details handlers (A78, migration 1340). Requests run through
 * `contractApp` against the in-memory client and every success is checked against openapi/v1.json
 * with `expectContract`. Owner-only reads, consent-scoped org reads, masking and the audited reveals
 * are the database's (pgTAP 1340); here the RPCs answer the way the database does, and queued
 * failures stand in for its refusals.
 */
import { describe, expect, it } from "vitest";
import { handlers as identity } from "../src/handlers/identity.ts";
import { contractApp, expectContract, testContext } from "./support/contract.ts";
import { globalRow, memoryDb, refusal, requests, success, tenantRow } from "./support/memory-db.ts";
import type { Row } from "./support/memory-db.ts";

const ORG = testContext().org?.id as string;
const ME = testContext().personId as string;
const id = (n: number) => `0192f1e2-7c3a-7b4d-9e8f-${String(78000 + n).padStart(12, "0")}`;
const MISSING = id(9999);
const MASKED = {
  masked: true,
  reason:
    "The passport number is Restricted: read it through workDetails.revealPassport, which is logged.",
};

describe("Identity: work details", () => {
  const DETAILS = id(1);

  function world(existing = true) {
    const rows: Row[] = existing
      ? [
          globalRow(DETAILS, {
            person_id: ME,
            // Retired in R6a (2664): always null.
            shirt_size: null,
            jacket_size: null,
            pants_size: null,
            shoe_size: null,
            glove_size: null,
            hat_size: null,
            uniform_notes: null,
            dietary_needs: ["Vegan"],
            allergies: "Peanuts, severe",
            dietary_notes: null,
            accessibility_needs: [],
            accessibility_notes: null,
            seat_preference: null,
            meal_preference: null,
            home_airport: null,
            passport_number_last4: "TEST",
            passport_issuing_country: "IT",
            passport_expires_on: "2031-04-30",
            passport_name: "IVY MARCHETTI",
          }),
        ]
      : [];
    const db = memoryDb(
      { person_work_details: rows },
      {
        ensure_my_work_details: () => {
          if (rows.length === 0)
            rows.push(
              globalRow(DETAILS, { person_id: ME, dietary_needs: [], accessibility_needs: [] }),
            );
          return DETAILS;
        },
        set_my_passport_number: (args) => {
          const value = args["p_passport_number"] as string | null;
          if (value !== null && value.replace(/[^0-9A-Za-z]/g, "").length < 5) {
            throw refusal("passport_number_format");
          }
          Object.assign(rows[0] as Row, {
            passport_number_last4:
              value === null
                ? null
                : value
                    .replace(/[^0-9A-Za-z]/g, "")
                    .slice(-4)
                    .toUpperCase(),
          });
          return null;
        },
        reveal_my_passport_number: () => "YA0000TEST",
        // Allergies are Restricted (R6a, 2663): the owner reads them through their own RPC.
        my_allergies: () => (rows[0]?.["allergies"] as string | undefined) ?? null,
      },
    );
    return { db, http: requests(contractApp({ handlers: [identity], db })) };
  }

  it("lists and reads the owner's details with the passport number always masked", async () => {
    const { db, http } = world();
    const page = (await expectContract(
      await success(http.get("/work-details")),
      "workDetails.list",
    )) as {
      data: { passport_number: unknown; passport_number_last4: string; allergies: string }[];
    };
    expect(page.data[0]?.passport_number).toEqual(MASKED);
    expect(page.data[0]?.allergies).toBe("Peanuts, severe");
    expect(db.calls.map((c) => c.name)).toContain("my_allergies");
    expect(page.data[0]?.passport_number_last4).toBe("TEST");
    await expectContract(await success(http.get(`/work-details/${DETAILS}`)), "workDetails.get");
    expect((await http.get(`/work-details/${MISSING}`)).status).toBe(404);
  });

  it("creates through ensure_my_work_details and encrypts the passport number through its RPC", async () => {
    const { db, http } = world(false);
    const response1 = await success(
      http.post("/work-details", { dietary_notes: "No pork.", passport_number: "ya 0000-test" }),
    );
    const made = (await expectContract(response1, "workDetails.create")) as {
      id: string;
      dietary_notes: string;
      passport_number_last4: string;
      passport_number: unknown;
    };
    expect(made.dietary_notes).toBe("No pork.");
    expect(made.passport_number_last4).toBe("TEST");
    expect(made.passport_number).toEqual(MASKED);
    expect(db.calls.map((c) => c.name)).toEqual([
      "ensure_my_work_details",
      "set_my_passport_number",
      "my_allergies",
    ]);
    expect(db.writes.some((w) => JSON.stringify(w.values).includes('passport_number"'))).toBe(
      false,
    );
  });

  it("updates, refuses a short passport number, reveals it and deletes", async () => {
    const { http } = world();
    const response2 = await success(
      http.patch(`/work-details/${DETAILS}`, {
        allergies: null,
        dietary_needs: ["Vegan", "Nut Free"],
      }),
    );
    await expectContract(response2, "workDetails.update");
    const short = await http.patch(`/work-details/${DETAILS}`, { passport_number: "AB-12" });
    expect(short.status).toBe(422);
    const shown = (await expectContract(
      await success(http.post(`/work-details/${DETAILS}/reveal-passport`)),
      "workDetails.revealPassport",
    )) as { passport_number: string };
    expect(shown.passport_number).toBe("YA0000TEST");
    await expectContract(
      await success(http.delete(`/work-details/${DETAILS}`)),
      "workDetails.delete",
    );
  });

  it("refuses a retired uniform size or travel preference with work_detail_field_moved (R6a)", async () => {
    const { db, http } = world();
    db.fail(
      "person_work_details",
      refusal(
        "work_detail_field_moved",
        "Uniform sizes and travel preferences are no longer kept on your profile.",
      ),
    );
    const moved = await http.patch(`/work-details/${DETAILS}`, { shirt_size: "L" });
    expect(moved.status).toBe(422);
    expect(JSON.stringify(await moved.json())).toContain("work_detail_field_moved");
  });
});

describe("Identity: emergency contacts and loyalty programs", () => {
  const CONTACT = id(11);
  const PROGRAM = id(21);

  function world() {
    const db = memoryDb(
      {
        person_emergency_contacts: [
          globalRow(CONTACT, {
            person_id: ME,
            full_name: "Marco Marchetti",
            relationship: "Brother",
            phone_e164: "+393471234567",
            alternate_phone_e164: null,
            email: null,
            sort_order: 0,
          }),
        ],
        person_loyalty_programs: [
          globalRow(PROGRAM, {
            person_id: ME,
            program_kind: "Airline",
            program_name: "SkyMiles",
            member_number: "SM-0000-TEST",
            sort_order: 0,
          }),
        ],
      },
      {},
      {
        person_emergency_contacts: {
          sort_order: 0,
          relationship: null,
          alternate_phone_e164: null,
          email: null,
        },
        person_loyalty_programs: { sort_order: 0 },
      },
    );
    return { db, http: requests(contractApp({ handlers: [identity], db })) };
  }

  it("keeps the owner's emergency contacts, with the database's limit", async () => {
    const { db, http } = world();
    await expectContract(await success(http.get("/emergency-contacts")), "emergencyContacts.list");
    await expectContract(
      await success(http.get(`/emergency-contacts/${CONTACT}`)),
      "emergencyContacts.get",
    );
    const response3 = await success(
      http.post("/emergency-contacts", { full_name: "Ana Ruiz", phone_e164: "+13055550142" }),
    );
    const made = (await expectContract(response3, "emergencyContacts.create")) as {
      id: string;
      person_id: string;
    };
    expect(made.person_id).toBe(ME);
    const response4 = await success(
      http.patch(`/emergency-contacts/${made.id}`, { relationship: "Friend", sort_order: 1 }),
    );
    await expectContract(response4, "emergencyContacts.update");
    await expectContract(
      await success(http.delete(`/emergency-contacts/${made.id}`)),
      "emergencyContacts.delete",
    );
    expect(
      (await http.post("/emergency-contacts", { full_name: "Bad", phone_e164: "305-555-0142" }))
        .status,
    ).toBe(422);
    db.fail(
      "person_emergency_contacts",
      refusal("emergency_contact_limit", "Keep at most 5; remove one first."),
    );
    expect(
      (await http.post("/emergency-contacts", { full_name: "Sixth", phone_e164: "+13055550109" }))
        .status,
    ).toBe(422);
  });

  it("keeps the owner's loyalty programs", async () => {
    const { http } = world();
    await expectContract(await success(http.get("/loyalty-programs")), "loyaltyPrograms.list");
    await expectContract(
      await success(http.get(`/loyalty-programs/${PROGRAM}`)),
      "loyaltyPrograms.get",
    );
    const response5 = await success(
      http.post("/loyalty-programs", {
        program_kind: "Hotel",
        program_name: "Bonvoy",
        member_number: "BV-0000-TEST",
      }),
    );
    const made = (await expectContract(response5, "loyaltyPrograms.create")) as { id: string };
    const response6 = await success(
      http.patch(`/loyalty-programs/${made.id}`, { member_number: "BV-0001-TEST" }),
    );
    await expectContract(response6, "loyaltyPrograms.update");
    await expectContract(
      await success(http.delete(`/loyalty-programs/${made.id}`)),
      "loyaltyPrograms.delete",
    );
  });
});

describe("Identity: work detail shares and the access log", () => {
  const SHARE = id(31);
  const ENGAGEMENT = id(41);
  const CONSENT = id(51);
  const ENTRY = id(81);

  function world() {
    const shares: Row[] = [
      tenantRow(SHARE, ORG, {
        engagement_id: ENGAGEMENT,
        person_id: ME,
        consent_record_id: CONSENT,
        categories: ["Dietary Needs", "Contact", "Passport"],
        shared_at: "2026-10-01T12:00:00.000Z",
        revoked_at: null,
        roster_entry_id: ENTRY,
      }),
    ];
    const details = (rosterEntryId: unknown) => ({
      engagement_id: ENGAGEMENT,
      person_id: ME,
      org_id: ORG,
      roster_entry_id: rosterEntryId,
      reader: "org",
      work_detail_share_id: SHARE,
      shared_at: "2026-10-01T12:00:00.000Z",
      sharing_open: true,
      categories: ["Dietary Needs", "Contact", "Passport"],
      readable: ["Contact", "Dietary Needs", "Passport"],
      emergency_contacts: null,
      contact: { email: "ivy@freelance.test", phone: null },
      uniform: null,
      dietary: {
        dietary_needs: ["Vegan"],
        allergies: "Peanuts, severe",
        allergies_masked: false,
        allergies_on_file: true,
        dietary_notes: null,
      },
      medical: { allergies: "Peanuts, severe" },
      accessibility: null,
      travel: null,
      passport: {
        passport_number: null,
        passport_number_last4: "TEST",
        passport_number_masked: true,
        passport_issuing_country: "IT",
        passport_expires_on: "2031-04-30",
        passport_name: "IVY MARCHETTI",
      },
    });
    const db = memoryDb(
      {
        work_detail_shares: shares,
        work_detail_events: [
          {
            id: id(61),
            person_id: ME,
            actor_person_id: id(71),
            org_id: ORG,
            engagement_id: ENGAGEMENT,
            action: "work_details.viewed",
            categories: ["Contact", "Dietary Needs"],
            changed_columns: [],
            reason: null,
            // R5 (2654): the event names its roster entry and the project fact kinds; a work details read has none.
            roster_entry_id: null,
            fact_kinds: [],
            created_at: "2026-10-02T12:00:00.000Z",
          },
        ],
      },
      {
        share_work_details: (args) => {
          const live = shares.find(
            (s) => s["engagement_id"] === args["p_engagement_id"] && s["revoked_at"] === null,
          );
          const categories = args["p_categories"] as string[];
          // 2664: the retired category is refused.
          if (categories.includes("Uniform Sizes")) throw refusal("work_detail_category_retired");
          if (live) {
            live["categories"] = categories;
            return live["id"];
          }
          const row = tenantRow(id(32), ORG, {
            engagement_id: args["p_engagement_id"],
            person_id: ME,
            consent_record_id: CONSENT,
            categories: args["p_categories"],
            shared_at: "2026-10-03T12:00:00.000Z",
            revoked_at: null,
          });
          shares.push(row);
          return row["id"];
        },
        revoke_work_detail_share: (args) => {
          const row = shares.find((s) => s["id"] === args["p_work_detail_share_id"]) as Row;
          row["revoked_at"] = "2026-10-04T12:00:00.000Z";
          return null;
        },
        // A share made before roster entries reads by its engagement (shared_work_details).
        shared_work_details: () => details(null),
        roster_shared_work_details: (args) => details(args["p_roster_entry_id"]),
        reveal_roster_passport_number: (args) => {
          if (args["p_roster_entry_id"] !== ENTRY) throw refusal("work_detail_not_shared");
          if (String(args["p_reason"]).length < 10) throw refusal("passport_reveal_reason");
          return "YA0000TEST";
        },
        reveal_shared_passport_number: (args) => {
          if (String(args["p_reason"]).length < 10) throw refusal("passport_reveal_reason");
          return "YA0000TEST";
        },
      },
    );
    return { db, http: requests(contractApp({ handlers: [identity], db })) };
  }

  it("lists, creates and narrows shares through share_work_details", async () => {
    const { db, http } = world();
    await expectContract(await success(http.get("/work-detail-shares")), "workDetailShares.list");
    const read = (await expectContract(
      await success(http.get(`/work-detail-shares/${SHARE}`)),
      "workDetailShares.get",
    )) as { categories: string[]; contact_shared: boolean };
    // v1's category enum is frozen: Contact (R6a) is its own field.
    expect(read).toMatchObject({ categories: ["Dietary Needs", "Passport"], contact_shared: true });
    const response7 = await success(
      http.post("/work-detail-shares", {
        engagement_id: id(42),
        categories: ["Emergency Contacts"],
        share_contact: true,
      }),
    );
    const made = (await expectContract(response7, "workDetailShares.create")) as {
      id: string;
      categories: string[];
      contact_shared: boolean;
    };
    expect(made).toMatchObject({ categories: ["Emergency Contacts"], contact_shared: true });
    expect(db.calls.find((c) => c.name === "share_work_details")?.args["p_categories"]).toEqual([
      "Emergency Contacts",
      "Contact",
    ]);
    const response8 = await success(
      http.patch(`/work-detail-shares/${SHARE}`, { categories: ["Dietary Needs"] }),
    );
    const narrowed = (await expectContract(response8, "workDetailShares.update")) as {
      categories: string[];
      contact_shared: boolean;
    };
    // Omitted, share_contact keeps the contact the share already named.
    expect(narrowed).toMatchObject({ categories: ["Dietary Needs"], contact_shared: true });
    const response8b = await success(
      http.patch(`/work-detail-shares/${SHARE}`, { share_contact: false }),
    );
    expect(
      (await expectContract(response8b, "workDetailShares.update")) as { contact_shared: boolean },
    ).toMatchObject({ categories: ["Dietary Needs"], contact_shared: false });
    expect(db.calls.filter((c) => c.name === "share_work_details")).toHaveLength(3);
    const retired = await http.post("/work-detail-shares", {
      engagement_id: id(44),
      categories: ["Uniform Sizes", "Dietary Needs"],
    });
    expect(retired.status).toBe(422);
    expect(JSON.stringify(await retired.json())).toContain("work_detail_category_retired");
    expect(
      (await http.post("/work-detail-shares", { engagement_id: id(42), categories: [] })).status,
    ).toBe(422);
    db.fail("rpc:share_work_details", refusal("work_detail_share_closed"));
    expect(
      (await http.post("/work-detail-shares", { engagement_id: id(43), categories: ["Passport"] }))
        .status,
    ).toBe(422);
  });

  it("reads what was shared, reveals the passport number with a reason, and revokes", async () => {
    const { http } = world();
    const details = (await expectContract(
      await success(http.get(`/work-detail-shares/${SHARE}/details`)),
      "workDetailShares.details",
    )) as {
      passport: { passport_number: null; passport_number_masked: boolean };
      categories: string[];
      readable: string[];
      contact: { email: string };
      dietary: { allergies_masked: boolean };
      medical: { allergies: string };
    };
    expect(details.passport.passport_number).toBeNull();
    // R6a: the medical read, masked allergies and the contact, which leaves v1's category lists.
    expect(details.dietary.allergies_masked).toBe(false);
    expect(details.medical.allergies).toBe("Peanuts, severe");
    expect(details.contact.email).toBe("ivy@freelance.test");
    expect(details.categories).toEqual(["Dietary Needs", "Passport"]);
    expect(details.readable).toEqual(["Dietary Needs", "Passport"]);
    expect(details.passport.passport_number_masked).toBe(true);
    // The share keys on a roster entry (R4), so the read and the reveal go through it.
    expect((details as unknown as { roster_entry_id: string }).roster_entry_id).toBe(ENTRY);
    expect(
      (await http.post(`/work-detail-shares/${SHARE}/reveal-passport`, { reason: "Flights" }))
        .status,
    ).toBe(422);
    const response9 = await success(
      http.post(`/work-detail-shares/${SHARE}/reveal-passport`, {
        reason: "Booking the June flights.",
      }),
    );
    const shown = (await expectContract(response9, "workDetailShares.revealPassport")) as {
      passport_number: string;
    };
    expect(shown.passport_number).toBe("YA0000TEST");
    const revoked = (await expectContract(
      await success(http.post(`/work-detail-shares/${SHARE}/revoke`)),
      "workDetailShares.revoke",
    )) as { revoked_at: string | null };
    expect(revoked.revoked_at).not.toBeNull();
    expect((await http.post(`/work-detail-shares/${SHARE}/revoke`)).status).toBe(422);
    expect(
      (await http.patch(`/work-detail-shares/${SHARE}`, { categories: ["Passport"] })).status,
    ).toBe(422);
    expect((await http.get(`/work-detail-shares/${MISSING}/details`)).status).toBe(404);
  });

  it("lists the access log, newest first", async () => {
    const { http } = world();
    const page = (await expectContract(
      await success(http.get("/work-detail-events")),
      "workDetailEvents.list",
    )) as {
      data: { action: string; categories: string[]; includes_contact: boolean }[];
    };
    expect(page.data[0]).toMatchObject({
      action: "work_details.viewed",
      categories: ["Dietary Needs"],
      includes_contact: true,
    });
  });
});
