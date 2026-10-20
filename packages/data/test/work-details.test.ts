import { describe, expect, it } from "vitest";
import {
  WORK_DETAIL_CATEGORIES,
  addEmergencyContact,
  addLoyaltyProgram,
  getMyNameParts,
  getMyWorkDetails,
  getSharedWorkDetails,
  listMyEmergencyContacts,
  listMyLoyaltyPrograms,
  listMyWorkDetailEvents,
  listMyWorkDetailSharing,
  parseSharedWorkDetails,
  removeEmergencyContact,
  removeLoyaltyProgram,
  revealMyPassportNumber,
  revealSharedPassportNumber,
  revokeWorkDetailShare,
  saveMyNameParts,
  saveMyWorkDetails,
  setMyPassportNumber,
  shareWorkDetails,
  updateEmergencyContact,
  updateLoyaltyProgram,
  workDetailLabelKey,
  workDetailLogKey,
} from "../src/work-details.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

const REFUSED = (rule: string) => errorResponse("XR001", `${rule}: Refused.`, rule);

const DETAIL_ROW = {
  id: "wd1",
  person_id: "p1",
  shirt_size: "M",
  jacket_size: null,
  pants_size: "32x32",
  shoe_size: "US 9",
  glove_size: null,
  hat_size: null,
  uniform_notes: null,
  dietary_needs: ["Vegan"],
  allergies: "Peanuts, severe",
  dietary_notes: null,
  accessibility_needs: [],
  accessibility_notes: null,
  seat_preference: "Aisle",
  meal_preference: null,
  home_airport: "MIA",
  passport_number_last4: "TEST",
  passport_issuing_country: "IT",
  passport_expires_on: "2031-04-30",
  passport_name: "IVY MARCHETTI",
  updated_at: "2026-10-20T10:00:00Z",
};

describe("work details", () => {
  it("reads the owner's row with the passport number masked to its last four", async () => {
    const { db, calls } = fakeClient({
      "from:person_work_details": [okResponse(DETAIL_ROW), okResponse(null)],
    });
    const read = await getMyWorkDetails(db);
    expect(read.ok && read.data).toMatchObject({
      shirtSize: "M",
      dietaryNeeds: ["Vegan"],
      passportNumber: null,
      passportNumberLast4: "TEST",
      passportNumberMasked: true,
    });
    const select = calls[0]?.steps.find(([step]) => step === "select")?.[1][0] as string;
    expect(select).not.toMatch(/passport_number,/);
    const none = await getMyWorkDetails(db);
    expect(none.ok && none.data).toBeNull();
  });

  it("saves only the fields given, after ensuring the row", async () => {
    const { db, calls } = fakeClient({
      "rpc:ensure_my_work_details": [okResponse("wd1"), REFUSED("not_signed_in")],
      "from:person_work_details": [okResponse({ ...DETAIL_ROW, shirt_size: "L" })],
    });
    const saved = await saveMyWorkDetails(db, { shirtSize: "L", allergies: null });
    expect(saved.ok && saved.data.shirtSize).toBe("L");
    expect(calls[1]?.steps).toContainEqual(["update", [{ shirt_size: "L", allergies: null }]]);
    expect(calls[1]?.steps).toContainEqual(["eq", ["id", "wd1"]]);
    const refused = await saveMyWorkDetails(db, { shirtSize: "S" });
    expect(!refused.ok && refused.error.kind).toBe("refusal");
  });

  it("sets and reveals the passport number through the RPCs", async () => {
    const { db, calls } = fakeClient({
      "rpc:set_my_passport_number": [okResponse(null), REFUSED("passport_number_format")],
      "rpc:reveal_my_passport_number": [
        okResponse("YA0000TEST"),
        REFUSED("passport_number_missing"),
      ],
    });
    expect((await setMyPassportNumber(db, "YA0000TEST")).ok).toBe(true);
    expect(calls[0]?.steps).toContainEqual(["args", [{ p_passport_number: "YA0000TEST" }]]);
    const bad = await setMyPassportNumber(db, "AB");
    expect(!bad.ok && bad.error.kind === "refusal" && bad.error.rule).toBe(
      "passport_number_format",
    );
    const shown = await revealMyPassportNumber(db);
    expect(shown.ok && shown.data).toBe("YA0000TEST");
    const missing = await revealMyPassportNumber(db);
    expect(!missing.ok && missing.error.kind).toBe("refusal");
  });
});

describe("emergency contacts and loyalty programs", () => {
  it("lists, adds, updates and removes emergency contacts", async () => {
    const { db, calls } = fakeClient({
      "from:person_emergency_contacts": [
        okResponse([
          {
            id: "c1",
            full_name: "Marco Marchetti",
            relationship: "Brother",
            phone_e164: "+393471234567",
            alternate_phone_e164: null,
            email: null,
            sort_order: 0,
          },
        ]),
        okResponse({ id: "c2" }),
        okResponse([{ id: "c2" }]),
        okResponse([]),
        okResponse([{ id: "c2" }]),
        REFUSED("emergency_contact_limit"),
      ],
    });
    const listed = await listMyEmergencyContacts(db);
    expect(listed.ok && listed.data[0]).toMatchObject({
      fullName: "Marco Marchetti",
      phoneE164: "+393471234567",
    });
    const added = await addEmergencyContact(db, "p1", {
      fullName: "Ana Ruiz",
      relationship: null,
      phoneE164: "+13055550142",
      alternatePhoneE164: null,
      email: "ana@example.com",
    });
    expect(added.ok && added.data).toBe("c2");
    expect(calls[1]?.steps[0]?.[1][0]).toMatchObject({ person_id: "p1", sort_order: 0 });
    expect(
      (await updateEmergencyContact(db, "c2", { relationship: "Friend", sortOrder: 1 })).ok,
    ).toBe(true);
    const gone = await updateEmergencyContact(db, "c9", { fullName: "Nobody" });
    expect(!gone.ok && gone.error.kind).toBe("not-found");
    expect((await removeEmergencyContact(db, "c2")).ok).toBe(true);
    const limit = await addEmergencyContact(db, "p1", {
      fullName: "Sixth",
      relationship: null,
      phoneE164: "+13055550109",
      alternatePhoneE164: null,
      email: null,
    });
    expect(!limit.ok && limit.error.kind === "refusal" && limit.error.rule).toBe(
      "emergency_contact_limit",
    );
  });

  it("lists, adds, updates and removes loyalty programs", async () => {
    const { db } = fakeClient({
      "from:person_loyalty_programs": [
        okResponse([
          {
            id: "l1",
            program_kind: "Airline",
            program_name: "SkyMiles",
            member_number: "SM-0000-TEST",
            sort_order: 0,
          },
        ]),
        okResponse({ id: "l2" }),
        okResponse([{ id: "l2" }]),
        okResponse([]),
        errorResponse("23505", "duplicate key"),
      ],
    });
    const listed = await listMyLoyaltyPrograms(db);
    expect(listed.ok && listed.data[0]?.programName).toBe("SkyMiles");
    const added = await addLoyaltyProgram(db, "p1", {
      programKind: "Hotel",
      programName: "Bonvoy",
      memberNumber: "BV-0000-TEST",
    });
    expect(added.ok && added.data).toBe("l2");
    expect((await updateLoyaltyProgram(db, "l2", { memberNumber: "BV-0001-TEST" })).ok).toBe(true);
    const gone = await removeLoyaltyProgram(db, "l9");
    expect(!gone.ok && gone.error.kind).toBe("not-found");
    const dup = await addLoyaltyProgram(db, "p1", {
      programKind: "Hotel",
      programName: "Bonvoy",
      memberNumber: "x",
    });
    expect(!dup.ok && dup.error.kind).toBe("conflict");
  });
});

describe("sharing", () => {
  it("lists the person's engagements with their shares, shares and revokes", async () => {
    const { db, calls } = fakeClient({
      "rpc:my_work_detail_sharing": [
        okResponse([
          {
            engagement_id: "e1",
            org_id: "o1",
            org_name: "Northwind Live",
            project_name: "Harbor Fest",
            role_type: "Crew",
            engagement_state: "Onboarding",
            start_date: "2027-06-01",
            end_date: null,
            sharing_open: true,
            work_detail_share_id: "s1",
            categories: ["Dietary Needs"],
            shared_at: "2026-10-20T10:00:00Z",
          },
        ]),
      ],
      "rpc:share_work_details": [okResponse("s1"), REFUSED("work_detail_share_closed")],
      "rpc:revoke_work_detail_share": [okResponse(null), REFUSED("work_detail_share_not_yours")],
    });
    const listed = await listMyWorkDetailSharing(db);
    expect(listed.ok && listed.data[0]).toMatchObject({
      orgName: "Northwind Live",
      shareId: "s1",
      sharingOpen: true,
    });
    const shared = await shareWorkDetails(db, "e1", ["Dietary Needs", "Passport"]);
    expect(shared.ok && shared.data).toBe("s1");
    expect(calls[1]?.steps).toContainEqual([
      "args",
      [{ p_engagement_id: "e1", p_categories: ["Dietary Needs", "Passport"] }],
    ]);
    const closed = await shareWorkDetails(db, "e1", ["Passport"]);
    expect(!closed.ok && closed.error.kind === "refusal" && closed.error.rule).toBe(
      "work_detail_share_closed",
    );
    expect((await revokeWorkDetailShare(db, "s1")).ok).toBe(true);
    expect((await revokeWorkDetailShare(db, "s1")).ok).toBe(false);
    expect(WORK_DETAIL_CATEGORIES).toContain("Passport");
  });

  it("parses what an org reads, with unshared categories null and the passport masked", async () => {
    const raw = {
      engagement_id: "e1",
      person_id: "p1",
      org_id: "o1",
      work_detail_share_id: "s1",
      shared_at: "2026-10-20T10:00:00Z",
      sharing_open: true,
      categories: ["Emergency Contacts", "Travel Profile", "Passport"],
      readable: ["Emergency Contacts", "Travel Profile", "Passport"],
      emergency_contacts: [
        {
          full_name: "Marco Marchetti",
          relationship: "Brother",
          phone_e164: "+393471234567",
          alternate_phone_e164: null,
          email: null,
          sort_order: 0,
        },
      ],
      uniform: null,
      dietary: null,
      accessibility: { accessibility_needs: ["Seating"], accessibility_notes: null },
      travel: {
        seat_preference: "Aisle",
        meal_preference: null,
        home_airport: "MIA",
        loyalty_programs: [
          { program_kind: "Airline", program_name: "SkyMiles", member_number: "SM-0000-TEST" },
        ],
      },
      passport: {
        passport_number: null,
        passport_number_last4: "TEST",
        passport_number_masked: true,
        passport_issuing_country: "IT",
        passport_expires_on: "2031-04-30",
        passport_name: "IVY MARCHETTI",
      },
    };
    const parsed = parseSharedWorkDetails(raw);
    expect(parsed.emergencyContacts?.[0]?.phoneE164).toBe("+393471234567");
    expect(parsed.uniform).toBeNull();
    expect(parsed.dietary).toBeNull();
    expect(parsed.accessibility?.accessibilityNeeds).toEqual(["Seating"]);
    expect(parsed.travel?.loyaltyPrograms[0]?.programName).toBe("SkyMiles");
    expect(parsed.passport).toMatchObject({
      passportNumber: null,
      passportNumberMasked: true,
      passportNumberLast4: "TEST",
    });
    const empty = parseSharedWorkDetails({
      engagement_id: "e1",
      categories: [],
      readable: [],
      sharing_open: false,
    });
    expect(empty).toMatchObject({
      categories: [],
      emergencyContacts: null,
      passport: null,
      sharingOpen: false,
    });
    expect(parseSharedWorkDetails(null).engagementId).toBe("");

    const { db } = fakeClient({
      "rpc:shared_work_details": [okResponse(raw), errorResponse("42501", "denied")],
      "rpc:reveal_shared_passport_number": [okResponse("YA0000TEST"), REFUSED("step_up_required")],
    });
    const read = await getSharedWorkDetails(db, "e1");
    expect(read.ok && read.data.readable).toHaveLength(3);
    const denied = await getSharedWorkDetails(db, "e1");
    expect(!denied.ok && denied.error.kind).toBe("not-found");
    const shown = await revealSharedPassportNumber(db, "e1", "Booking the June flights.");
    expect(shown.ok && shown.data).toBe("YA0000TEST");
    const stepUp = await revealSharedPassportNumber(db, "e1", "Booking the June flights.");
    expect(!stepUp.ok && stepUp.error.kind === "refusal" && stepUp.error.rule).toBe(
      "step_up_required",
    );
  });

  it("lists the person's access log, newest first", async () => {
    const { db, calls } = fakeClient({
      "from:work_detail_events": [
        okResponse([
          {
            id: "ev1",
            action: "work_details.viewed",
            actor_person_id: "p2",
            org_id: "o1",
            engagement_id: "e1",
            categories: ["Dietary Needs"],
            changed_columns: [],
            reason: null,
            created_at: "2026-10-20T10:00:00Z",
          },
        ]),
        errorResponse("PGRST301", "boom"),
      ],
    });
    const listed = await listMyWorkDetailEvents(db, "p1", 10);
    expect(listed.ok && listed.data[0]?.action).toBe("work_details.viewed");
    expect(calls[0]?.steps).toContainEqual(["limit", [10]]);
    const failed = await listMyWorkDetailEvents(db, "p1");
    expect(!failed.ok && failed.error.kind).toBe("unexpected");
  });
});

describe("labels", () => {
  it("keys enum labels and log actions for the catalogs", () => {
    expect(workDetailLabelKey("Emergency Contacts")).toBe("emergencyContacts");
    expect(workDetailLabelKey("Step-Free Access")).toBe("stepFreeAccess");
    expect(workDetailLabelKey("Passport")).toBe("passport");
    expect(workDetailLogKey("work_details.viewed")).toBe("viewed");
    expect(workDetailLogKey("person_emergency_contacts.delete")).toBe("contactRemoved");
    expect(workDetailLogKey("something.else")).toBe("other");
  });
});

describe("name parts (Section 15)", () => {
  it("reads and saves the given and family names", async () => {
    const { db, calls } = fakeClient({
      "from:people": [
        okResponse({ full_name: "Ivy Marchetti", given_name: "Ivy", family_name: "Marchetti" }),
        okResponse(null),
        okResponse([{ id: "p1" }]),
        okResponse([]),
      ],
    });
    const read = await getMyNameParts(db, "p1");
    expect(read.ok && read.data).toEqual({
      fullName: "Ivy Marchetti",
      givenName: "Ivy",
      familyName: "Marchetti",
    });
    const missing = await getMyNameParts(db, "p9");
    expect(!missing.ok && missing.error.kind).toBe("not-found");
    expect((await saveMyNameParts(db, "p1", { givenName: "Ivy", familyName: null })).ok).toBe(true);
    expect(calls[2]?.steps).toContainEqual(["update", [{ given_name: "Ivy", family_name: null }]]);
    const gone = await saveMyNameParts(db, "p9", { givenName: null, familyName: null });
    expect(!gone.ok && gone.error.kind).toBe("not-found");
  });
});
