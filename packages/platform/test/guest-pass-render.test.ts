import { describe, expect, it } from "vitest";
import { renderGuestPassPdf } from "../edge/guest-pass-render.ts";
import type { ClaimedGuestEmail, GuestPassFacts } from "../src/notifications/guest-emails.ts";

/**
 * The guest pass a Pass email attaches (B8): dated when the guest was approved, so a retried
 * send renders the same bytes and Resend's idempotency key never meets a different payload.
 */
const PASS: GuestPassFacts = {
  projectId: "prj-1",
  projectKey: "NWL",
  timeZone: "America/New_York",
  passCode: "GP-ABCDEFGHIJ",
  passCategoryCode: "VIP",
  passCategoryName: "VIP Guest",
  tableLabel: "Table 4",
  showName: null,
  showDay: "2027-06-04",
  decidedAt: "2027-05-20T18:00:00Z",
};

const CLAIM: ClaimedGuestEmail = {
  id: "ge-1",
  orgId: "org-a",
  orgName: "Northwind Live",
  projectName: "Northwind Summer Series",
  guestListEntryId: "g-1",
  kind: "Pass",
  subject: null,
  body: null,
  locale: "en-US",
  to: "sasha@example.test",
  guestName: "Sasha Bell",
  plusOnes: 1,
  unsubscribeToken: "xgue_abc",
  pass: PASS,
};

describe("the guest pass attachment", () => {
  it("renders the same bytes on every attempt, dated by the approval", async () => {
    const options = { gatewayUrl: "https://gateway.example.test" };
    const first = await renderGuestPassPdf(CLAIM, PASS, {
      ...options,
      now: new Date("2027-06-01T00:00:00Z"),
    });
    const retry = await renderGuestPassPdf(CLAIM, PASS, {
      ...options,
      now: new Date("2027-06-01T00:09:00Z"),
    });
    expect(Buffer.from(retry).equals(Buffer.from(first))).toBe(true);
    const later = await renderGuestPassPdf(
      CLAIM,
      { ...PASS, decidedAt: "2027-05-21T18:00:00Z" },
      options,
    );
    expect(Buffer.from(later).equals(Buffer.from(first))).toBe(false);
  }, 30_000);
});
