import { describe, expect, it } from "vitest";
import {
  activationItems,
  approvalItems,
  briefingItems,
  deliverableItems,
  deliveryWindowItems,
  dockSlotItems,
  entitlementItems,
  hospitalityItems,
  siteAccessItems,
} from "../src/domain/todayBlocks";

const P = "prj-a";
const now = Date.parse("2026-11-10T12:00:00Z");
const at = (h: number) => new Date(now + h * 3_600_000).toISOString();

describe("Today blocks for outside parties", () => {
  it("dock slots: the project's, not ended, soonest first, with the zone and reference", () => {
    const items = dockSlotItems(
      [
        {
          id: "late",
          project_id: P,
          zone_name: "Dock B",
          starts_at: at(5),
          ends_at: at(6),
          reference_code: "R2",
        },
        { id: "past", project_id: P, zone_name: "Dock A", starts_at: at(-3), ends_at: at(-2) },
        {
          id: "soon",
          project_id: P,
          zone_code: "D1",
          starts_at: at(1),
          ends_at: at(2),
          reference_code: "R1",
        },
        {
          id: "other",
          project_id: "prj-b",
          zone_name: "Elsewhere",
          starts_at: at(1),
          ends_at: at(2),
        },
      ],
      P,
      now,
    );
    expect(items.map((i) => i.id)).toEqual(["soon", "late"]);
    expect(items[0]).toMatchObject({ title: "D1", detail: "R1" });
  });

  it("delivery windows carry the places left and flag a full one", () => {
    const items = deliveryWindowItems(
      [
        {
          id: "full",
          project_id: P,
          zone_name: "Gate 1",
          starts_at: at(1),
          ends_at: at(2),
          places_left: 0,
        },
        {
          id: "open",
          project_id: P,
          zone_name: "Gate 2",
          starts_at: at(3),
          ends_at: at(4),
          places_left: 3,
        },
      ],
      P,
      now,
    );
    expect(items).toMatchObject([
      { id: "full", placesLeft: 0, flagged: true },
      { id: "open", placesLeft: 3, flagged: false },
    ]);
  });

  it("deliverables: open or returned only, by due date; returned and overdue flagged", () => {
    const items = deliverableItems(
      [
        { id: "done", title: "Plot", deliverable_state: "Accepted", due_at: at(-5) },
        { id: "later", title: "Rider", deliverable_state: "Open", due_at: at(48) },
        { id: "overdue", title: "Insurance", deliverable_state: "Open", due_at: at(-1) },
        { id: "back", title: "Stage plan", deliverable_state: "Returned", due_at: at(24) },
        { id: "undated", title: "W-9", deliverable_state: "Open", due_at: null },
      ],
      now,
    );
    expect(items.map((i) => i.id)).toEqual(["overdue", "back", "later", "undated"]);
    expect(items.map((i) => i.flagged)).toEqual([true, true, false, false]);
    expect(items[1]).toMatchObject({ state: "Returned" });
  });

  it("site access: the person's own credentials, not revoked, not expired", () => {
    const items = siteAccessItems(
      [
        {
          id: "mine",
          project_id: P,
          holder_person_id: "me",
          category_name: "Crew",
          valid_from: at(-1),
          valid_to: at(10),
          credential_number: "C-1",
        },
        {
          id: "theirs",
          project_id: P,
          holder_person_id: "you",
          category_name: "Crew",
          valid_from: at(-1),
          valid_to: at(10),
        },
        {
          id: "revoked",
          project_id: P,
          holder_person_id: "me",
          category_name: "AAA",
          revoked_at: at(-1),
        },
        {
          id: "expired",
          project_id: P,
          holder_person_id: "me",
          category_name: "Day",
          valid_to: at(-1),
        },
      ],
      P,
      "me",
      now,
    );
    expect(items).toMatchObject([{ id: "mine", title: "Crew", detail: "C-1" }]);
  });

  it("briefings: a canceled one stays, flagged, with its reason", () => {
    const items = briefingItems(
      [
        {
          id: "b1",
          project_id: P,
          title: "Safety",
          location: "Stage left",
          starts_at: at(1),
          ends_at: at(2),
        },
        {
          id: "b2",
          project_id: P,
          title: "Weather",
          canceled_at: at(-1),
          cancel_reason: "Storm.",
          starts_at: at(3),
          ends_at: at(4),
        },
      ],
      P,
      now,
    );
    expect(items).toMatchObject([
      { id: "b1", detail: "Stage left", canceled: false },
      { id: "b2", detail: "Storm.", canceled: true, flagged: true },
    ]);
  });

  it("hospitality joins the title and description, with the supplier", () => {
    const items = hospitalityItems(
      [
        {
          id: "h",
          project_id: P,
          title: "Catering",
          description: "Dinner for 8",
          supplier_name: "Kitchen Co",
          starts_at: at(2),
        },
      ],
      P,
      now,
    );
    expect(items).toMatchObject([{ title: "Catering: Dinner for 8", detail: "Kitchen Co" }]);
  });

  it("approvals: undecided only, oldest first", () => {
    const items = approvalItems(
      [
        {
          id: "new",
          project_id: P,
          message: "Approve the stage plot",
          requested_at: at(-1),
          decision: null,
        },
        { id: "old", project_id: P, subject_kind: "Budget", requested_at: at(-24) },
        {
          id: "decided",
          project_id: P,
          message: "Done",
          requested_at: at(-30),
          decision: "Approved",
        },
      ],
      P,
    );
    expect(items.map((i) => i.id)).toEqual(["old", "new"]);
    expect(items[0]).toMatchObject({ title: "Budget" });
  });

  it("activation bookings show the space and purpose", () => {
    const items = activationItems(
      [
        {
          id: "s",
          project_id: P,
          space_name: "Brand Tent",
          purpose: "Sampling",
          starts_at: at(1),
          ends_at: at(8),
        },
      ],
      P,
      now,
    );
    expect(items).toMatchObject([{ title: "Brand Tent", detail: "Sampling" }]);
  });

  it("entitlements: open first by due date, with quantity over one, done and overdue", () => {
    const items = entitlementItems(
      [
        {
          id: "done",
          project_id: P,
          description: "Logo on screens",
          fulfilled_at: at(-2),
          due_on: "2026-11-01",
        },
        { id: "late", project_id: P, description: "Banner", due_on: "2026-11-20", quantity: 1 },
        {
          id: "soon",
          project_id: P,
          description: "Tickets",
          due_on: "2026-11-09",
          quantity: 20,
          is_overdue: true,
        },
      ],
      P,
    );
    expect(items.map((i) => i.id)).toEqual(["soon", "late", "done"]);
    expect(items[0]).toMatchObject({ quantity: 20, flagged: true, done: false });
    expect(items[1]).not.toHaveProperty("quantity");
    expect(items[2]).toMatchObject({ done: true });
  });
});
