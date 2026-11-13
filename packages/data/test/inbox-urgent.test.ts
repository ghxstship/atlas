import { describe, expect, it } from "vitest";
import { isUrgentInboxItem, sortInbox, type InboxItem } from "../src/inbox.ts";

const item = (over: Partial<InboxItem>): InboxItem => ({
  id: "01a1-a",
  createdAt: "2026-11-10T17:00:00Z",
  kind: "mention.created",
  section: "Needs You",
  read: false,
  actorPersonId: null,
  subjectTable: null,
  subjectId: null,
  projectId: null,
  args: {},
  approval: null,
  ...over,
});

describe("crisis alerts in the Inbox (crawl 4.9)", () => {
  it("are urgent while app.inbox_items holds them in Needs You, and not once the all-clear moves them", () => {
    expect(isUrgentInboxItem(item({ kind: "crisis_alert.issued" }))).toBe(true);
    expect(
      isUrgentInboxItem(item({ kind: "crisis_alert.issued", section: "For Your Information" })),
    ).toBe(false);
    expect(
      isUrgentInboxItem(item({ kind: "crisis_alert.ended", section: "For Your Information" })),
    ).toBe(false);
    expect(isUrgentInboxItem(item({}))).toBe(false);
  });

  it("sort first in Needs You, ahead of newer requests", () => {
    const items = [
      item({ id: "01a1-c", createdAt: "2026-11-10T18:00:00Z" }),
      item({ id: "01a1-b", kind: "crisis_alert.issued", subjectTable: "app.crisis_alerts" }),
      item({ id: "01a1-d", section: "For Your Information", createdAt: "2026-11-10T19:00:00Z" }),
    ];
    expect(sortInbox(items).map((i) => i.id)).toEqual(["01a1-b", "01a1-c", "01a1-d"]);
  });
});
