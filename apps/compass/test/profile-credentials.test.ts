import { getMessages, locales } from "@xos/i18n";
import { describe, expect, it } from "vitest";
import {
  byExpiry,
  EXPIRY_THRESHOLDS,
  expiryCallout,
  expiryStanding,
  expiryThreshold,
  fileVersion,
  todayFor,
  toCertification,
  toDocument,
} from "../src/domain/profileCredentials";

// 11:30 on June 10 in Pago Pago (UTC-11) is already June 11 in UTC and June 11 in Kiritimati (UTC+14): an org item and a
// personal item count from different days, as A89's reminder job counts them.
const NOW = new Date("2027-06-10T22:30:00Z");
const PERSON_ZONE = "Pacific/Pago_Pago";
const ORG_ZONE = "Pacific/Kiritimati";

describe("expiry thresholds", () => {
  it("are the reminder job's 30, 7 and 1 days", () => {
    expect(EXPIRY_THRESHOLDS).toEqual([30, 7, 1]);
  });

  it("reach the smallest threshold at or above the days left, as private.expiry_threshold does", () => {
    // The same cases the 1463 pgTAP suite checks against the SQL function.
    expect([31, 30, 5, 0, -1].map(expiryThreshold)).toEqual([null, 30, 7, 1, null]);
    expect([29, 8, 7, 6, 2, 1].map(expiryThreshold)).toEqual([30, 30, 7, 7, 7, 1]);
  });
});

describe("expiry standing", () => {
  it("says how an expiry date stands on a calendar", () => {
    expect(expiryStanding(null, "2027-06-10")).toEqual({ kind: "none" });
    expect(expiryStanding("2027-06-09", "2027-06-10")).toEqual({ kind: "expired" });
    expect(expiryStanding("2027-06-10", "2027-06-10")).toEqual({
      kind: "expiring",
      daysLeft: 0,
      threshold: 1,
    });
    expect(expiryStanding("2027-06-11", "2027-06-10")).toEqual({
      kind: "expiring",
      daysLeft: 1,
      threshold: 1,
    });
    expect(expiryStanding("2027-06-15", "2027-06-10")).toEqual({
      kind: "expiring",
      daysLeft: 5,
      threshold: 7,
    });
    expect(expiryStanding("2027-07-10", "2027-06-10")).toEqual({
      kind: "expiring",
      daysLeft: 30,
      threshold: 30,
    });
    expect(expiryStanding("2027-07-11", "2027-06-10")).toEqual({ kind: "current", daysLeft: 31 });
  });

  it("counts on the row's own calendar, or the person's when it names none", () => {
    expect(todayFor(ORG_ZONE, PERSON_ZONE, NOW)).toBe("2027-06-11");
    expect(todayFor(PERSON_ZONE, "UTC", NOW)).toBe("2027-06-10");
    expect(todayFor(null, PERSON_ZONE, NOW)).toBe("2027-06-10");
  });
});

describe("the expiring-soon callout", () => {
  it("is absent when nothing expires within 30 days", () => {
    expect(
      expiryCallout(
        [
          { id: "a", title: "Arena Rigging", expiresOn: "2028-03-01", timeZone: ORG_ZONE },
          { id: "b", title: "Scaffold", expiresOn: null, timeZone: null },
          { id: "c", title: "Old CPR", expiresOn: "2027-01-01", timeZone: PERSON_ZONE },
        ],
        PERSON_ZONE,
        NOW,
      ),
    ).toBeNull();
  });

  it("names the most urgent threshold reached and lists every item within 30 days, soonest first", () => {
    const callout = expiryCallout(
      [
        { id: "cpr", title: "CPR", expiresOn: "2027-06-30", timeZone: PERSON_ZONE },
        { id: "fork", title: "Forklift Operator", expiresOn: "2027-06-16", timeZone: ORG_ZONE },
        { id: "far", title: "Arena Rigging", expiresOn: "2028-03-01", timeZone: ORG_ZONE },
      ],
      PERSON_ZONE,
      NOW,
    );
    expect(callout).toEqual({
      threshold: 7,
      tone: "warning",
      items: [
        { id: "fork", title: "Forklift Operator", daysLeft: 5, threshold: 7 },
        { id: "cpr", title: "CPR", daysLeft: 20, threshold: 30 },
      ],
    });
  });

  it("matches the reminder on the org's calendar, not the person's", () => {
    // June 18 is 7 days out on Kiritimati's June 11 (the 7-day reminder), but 8 days out on Pago Pago's June 10.
    const org = expiryCallout(
      [{ id: "h", title: "Aerial Lift", expiresOn: "2027-06-18", timeZone: ORG_ZONE }],
      PERSON_ZONE,
      NOW,
    );
    expect(org?.items[0]).toMatchObject({ daysLeft: 7, threshold: 7 });
    const personal = expiryCallout(
      [{ id: "p", title: "Aerial Lift", expiresOn: "2027-06-18", timeZone: PERSON_ZONE }],
      PERSON_ZONE,
      NOW,
    );
    expect(personal?.items[0]).toMatchObject({ daysLeft: 8, threshold: 30 });
  });

  it("turns from info to warning to danger as the 30, 7 and 1-day thresholds pass", () => {
    const tone = (expiresOn: string) =>
      expiryCallout([{ id: "x", title: "X", expiresOn, timeZone: PERSON_ZONE }], PERSON_ZONE, NOW)
        ?.tone;
    expect(tone("2027-07-10")).toBe("info");
    expect(tone("2027-06-17")).toBe("warning");
    expect(tone("2027-06-11")).toBe("danger");
    expect(tone("2027-06-10")).toBe("danger");
    expect(tone("2027-06-09")).toBeUndefined();
  });

  it("has words for every stage and state in each locale", () => {
    type Profile = Record<string, string>;
    for (const locale of locales) {
      const profile = (getMessages(locale) as unknown as { compass: { profile: Profile } }).compass
        .profile;
      for (const key of [
        ...EXPIRY_THRESHOLDS.map((t) => `expiring${t}`),
        "expiringItem",
        "whenToday",
        "whenTomorrow",
        "whenInDays",
        "expiresToday",
        "expiresTomorrow",
        "expiresInDays",
        "expired",
      ]) {
        expect(typeof profile[key], `${locale} compass.profile.${key}`).toBe("string");
      }
    }
  });
});

describe("profile rows", () => {
  it("reads certification rows from the device, dropping one it cannot place", () => {
    expect(
      toCertification({
        id: "h1",
        person_id: "me",
        source: "Org Record",
        name: "Arena Rigging",
        issuing_body: "ETCP",
        issued_on: "2025-03-01",
        expires_on: "2028-03-01",
        is_verified: true,
        verified_by_org_name: "Demo Productions",
        time_zone: "America/New_York",
      }),
    ).toEqual({
      id: "h1",
      source: "Org Record",
      name: "Arena Rigging",
      issuingBody: "ETCP",
      expiresOn: "2028-03-01",
      verified: true,
      verifiedBy: "Demo Productions",
      timeZone: "America/New_York",
    });
    expect(toCertification({ id: "x", source: "Somewhere", name: "Y" })).toBeNull();
  });

  it("reads documents, naming a file only when it is Public or Internal", () => {
    const signed = toDocument({
      id: "d1",
      document_type: "Engagement Document",
      document_kind: "Agreement",
      title: "Crew Agreement 2027",
      org_name: "Demo Productions",
      document_state: "Signed",
      expires_on: "2027-12-31",
      time_zone: "America/New_York",
      file_version_id: "v1",
      file_version_number: 2,
      file_object_name: "org/agreement.pdf",
      file_name: "agreement.pdf",
      file_content_type: "application/pdf",
      file_size_bytes: "1200",
      file_classification: "Internal",
    });
    expect(signed?.file).toEqual({
      id: "v1",
      versionNumber: 2,
      objectName: "org/agreement.pdf",
      filename: "agreement.pdf",
      contentType: "application/pdf",
      sizeBytes: 1200,
      classification: "Internal",
    });
    expect(signed?.file && fileVersion(signed.file)).toMatchObject({
      scanStatus: "Clean",
      objectName: "org/agreement.pdf",
    });
    expect(
      toDocument({
        id: "d2",
        document_type: "Engagement Document",
        file_version_id: "v2",
        file_object_name: "o",
        file_classification: "Confidential",
      })?.file,
    ).toBeNull();
    const passport = toDocument({
      id: "w1",
      document_type: "Passport",
      issuer: "US",
      expires_on: "2031-04-30",
    });
    expect(passport).toMatchObject({
      type: "Passport",
      issuer: "US",
      expiresOn: "2031-04-30",
      file: null,
      title: null,
    });
    expect(toDocument({ id: "z", document_type: "Tax Form" })).toBeNull();
  });

  it("lists the soonest expiry first and what never expires last", () => {
    const items = [
      { name: "Scaffold", expiresOn: null },
      { name: "CPR", expiresOn: "2027-06-30" },
      { name: "Aerial Lift", expiresOn: "2027-06-30" },
      { name: "Forklift", expiresOn: "2027-06-16" },
    ];
    expect(
      byExpiry(
        items,
        (i) => i.expiresOn,
        (i) => i.name,
      ).map((i) => i.name),
    ).toEqual(["Forklift", "Aerial Lift", "CPR", "Scaffold"]);
  });
});
