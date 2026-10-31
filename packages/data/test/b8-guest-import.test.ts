import { describe, expect, it } from "vitest";
import { importGuestEmail } from "../src/import-worker.ts";

/** B8 (2974): the guest list import fills the guest's email as the table stores it, or flags the cell. */
describe("guest email import", () => {
  it("trims and lowercases an address", () => {
    expect(importGuestEmail("  Sasha.Bell@Example.TEST ")).toBe("sasha.bell@example.test");
  });

  it("refuses what the guest_list_entries_guest_email check would", () => {
    expect(importGuestEmail("not an email")).toBeNull();
    expect(importGuestEmail("two@example.test three@example.test")).toBeNull();
    expect(importGuestEmail(`${"a".repeat(316)}@x.io`)).toBeNull();
  });
});
