import type { TodayChange } from "@xos/data/change-tracking";
import { isActionableApproval, type InboxItem } from "@xos/data/inbox";
import { describe, expect, it } from "vitest";
import { changeFieldKeys, doorsText, waitingApprovals } from "@/lib/home/today";

/**
 * Home > Today's tiles (B6, G-249): the doors countdown before and after doors open, nothing when no
 * doors are near, the approvals the Inbox counts, and the labels of the changes since the last visit.
 */
const NOW = new Date("2027-06-05T20:00:00Z");

describe("the doors tile", () => {
  it("counts down to doors in hours and minutes", () => {
    expect(doorsText("2027-06-05T22:14:30Z", NOW)).toEqual({
      key: "home.today.tiles.doors.in",
      hours: 2,
      minutes: 14,
    });
  });
  it("counts up for six hours after doors opened", () => {
    expect(doorsText("2027-06-05T19:20:00Z", NOW)).toEqual({
      key: "home.today.tiles.doors.opened",
      hours: 0,
      minutes: 40,
    });
    expect(doorsText("2027-06-05T13:00:00Z", NOW)).toEqual({ key: "home.today.tiles.doors.none" });
  });
  it("says so when there are no doors", () => {
    expect(doorsText(null, NOW)).toEqual({ key: "home.today.tiles.doors.none" });
  });
});

describe("the approvals tile", () => {
  const item = (over: Partial<InboxItem>): InboxItem =>
    ({
      id: "n1",
      createdAt: "2027-06-05T12:00:00Z",
      kind: "approval.requested",
      section: "Needs You",
      read: false,
      actorPersonId: null,
      subjectTable: "app.approval_instances",
      subjectId: "i1",
      projectId: null,
      args: {},
      approval: {
        instanceId: "i1",
        documentType: "Purchase Order",
        reference: "PO-12",
        amountMinor: 250000,
        currency: "USD",
        state: "Pending",
        currentStep: 1,
      },
      ...over,
    }) as InboxItem;

  it("counts exactly the approvals the Inbox can decide", () => {
    const items = [
      item({}),
      item({ id: "n2", approval: null, kind: "record.assigned" }),
      item({ id: "n3", section: "For Your Information" }),
      item({ id: "n4" }),
    ];
    expect(waitingApprovals(items).length).toBe(items.filter(isActionableApproval).length);
    expect(waitingApprovals(items).every(isActionableApproval)).toBe(true);
  });
});

describe("the changes tile", () => {
  const change = (over: Partial<TodayChange>): TodayChange => ({
    table: "app.records",
    subjectId: "r1",
    key: "NWS-42",
    title: "Hang the banners",
    projectKey: "NWS",
    kind: "changed",
    fields: ["title", "attributes.progress_pct", "record_number"],
    changedAt: "2027-06-05T19:00:00Z",
    actorId: "p1",
    actorName: "Dave Lindqvist",
    ...over,
  });
  it("labels a record's fields by its form and its attributes by theirs, and drops unlabeled ones", () => {
    const has = (key: string) => key !== "work.extension.missing";
    expect(changeFieldKeys(change({}), has)).toEqual([
      "work.fields.title",
      "work.extension.progress_pct",
    ]);
    expect(changeFieldKeys(change({ fields: ["attributes.missing"] }), has)).toEqual([]);
  });
  it("labels a shift's fields from the shared column dictionary", () => {
    expect(
      changeFieldKeys(
        change({ table: "app.shifts", key: null, fields: ["role_code", "starts_at"] }),
        () => true,
      ),
    ).toEqual(["views.export.columns.role_code", "views.export.columns.starts_at"]);
  });
});
