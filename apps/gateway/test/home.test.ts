import { describe, expect, it } from "vitest";
import { BRING_LIMIT, upNextDetails } from "../lib/home";

/**
 * What the Up Next card adds for an engagement (R2): the next call, where, whom to ask and what to
 * bring, each row left out when it has no value.
 */
const row = {
  venue_name: "Northwind Pier Pavilion",
  venue_street_address: "1 Pier Way",
  venue_locality: "Miami",
  venue_postal_code: "33132",
  contact_name: "Carol Nguyen",
  next_call_at: "2027-06-01T12:00:00Z",
  next_call_time_zone: "America/New_York",
  next_call_kind: "Shift",
};

describe("upNextDetails", () => {
  it("gives the call, the venue and the contact", () => {
    const details = upNextDetails({ row, orgName: "Northwind Live", badges: [], gear: [] });
    expect(details.call).toEqual({
      at: "2027-06-01T12:00:00Z",
      timeZone: "America/New_York",
      kind: "shift",
    });
    expect(details.where).toBe("Northwind Pier Pavilion, 1 Pier Way, Miami, 33132");
    expect(details.contact).toBe("Carol Nguyen");
    expect(details.bring).toEqual([]);
    expect(details.bringMore).toBe(0);
  });

  it("names dock slots and sets, and drops a call it cannot place", () => {
    const kind = (next_call_kind: string | null) =>
      upNextDetails({ row: { ...row, next_call_kind }, orgName: "O", badges: [], gear: [] }).call
        ?.kind ?? null;
    expect(kind("Dock Slot")).toBe("dockSlot");
    expect(kind("Set")).toBe("set");
    expect(kind("Rehearsal")).toBeNull();
    expect(kind(null)).toBeNull();
    expect(
      upNextDetails({ row: { ...row, next_call_at: null }, orgName: "O", badges: [], gear: [] })
        .call,
    ).toBeNull();
  });

  it("falls back to the org for the contact and leaves out an empty venue", () => {
    const details = upNextDetails({
      row: {
        ...row,
        contact_name: null,
        venue_name: null,
        venue_street_address: " ",
        venue_locality: null,
        venue_postal_code: null,
      },
      orgName: "Northwind Live",
      badges: [],
      gear: [],
    });
    expect(details.contact).toBe("Northwind Live");
    expect(details.where).toBeNull();
    const none = upNextDetails({ row: null, orgName: "Northwind Live", badges: [], gear: [] });
    expect(none).toEqual({
      call: null,
      where: null,
      contact: "Northwind Live",
      parking: [],
      bring: [],
      bringMore: 0,
    });
  });

  it("lists live badge categories, then gear with asset tags, at most five", () => {
    const details = upNextDetails({
      row,
      orgName: "O",
      badges: [
        { category_name: "All Access", revoked_at: null },
        { category_name: "All Access", revoked_at: null },
        { category_name: "Production", revoked_at: "2027-05-01T00:00:00Z" },
      ],
      gear: [
        { class_name: "Radio", asset_tag: "RAD-001" },
        { class_name: "Radio", asset_tag: "RAD-002" },
        { class_name: "Headset", asset_tag: null },
        { class_name: "Flashlight", asset_tag: "FL-9" },
        { class_name: "Harness", asset_tag: "HN-4" },
        { class_name: null, asset_tag: "X-1" },
      ],
    });
    expect(details.bring).toHaveLength(BRING_LIMIT);
    expect(details.bring).toEqual([
      "All Access",
      "Radio (RAD-001)",
      "Radio (RAD-002)",
      "Headset",
      "Flashlight (FL-9)",
    ]);
    expect(details.bringMore).toBe(1);
  });
});
