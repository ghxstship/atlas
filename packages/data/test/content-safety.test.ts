import { describe, expect, it } from "vitest";
import {
  blockMember,
  CONTENT_REPORT_REASONS,
  contentGroundsFor,
  decideContentReport,
  getContentReportDetail,
  listContentModerationQueue,
  parseContentReportDetail,
  reportContent,
} from "../src/content-safety.ts";
import { moduleClient, stepsOf } from "./module-client.ts";

const ok = (data: unknown) => ({ data, error: null });
const refused = (rule: string, sentence = "Refused.") => ({
  data: null,
  error: { code: "XR001", message: `${rule}: ${sentence}`, hint: rule },
});

describe("reporting and blocking (ADR 0033 decision 57)", () => {
  it("reports an item with its reason and trimmed details, and drops empty details", async () => {
    const { db, calls } = moduleClient({
      "rpc:report_content": [ok("r1"), ok("r2")],
    });
    expect(
      await reportContent(db, { kind: "Feed Post", id: "p1" }, "Harassment", "  Aimed at me.  "),
    ).toEqual({ ok: true, data: "r1" });
    expect(stepsOf(calls[0], "args")[0]?.[0]).toEqual({
      p_subject_kind: "Feed Post",
      p_subject_id: "p1",
      p_reason: "Harassment",
      p_details: "Aimed at me.",
    });
    await reportContent(db, { kind: "Chat Message", id: "m1" }, "Spam", "   ");
    expect(stepsOf(calls[1], "args")[0]?.[0]).toMatchObject({ p_details: null });
  });

  it("returns the database's refusal of one's own content", async () => {
    const { db } = moduleClient({
      "rpc:report_content": [
        refused("content_report_own", "You cannot report your own post, comment or message."),
      ],
    });
    expect(await reportContent(db, { kind: "Comment", id: "c1" }, "Other")).toEqual({
      ok: false,
      error: {
        kind: "refusal",
        rule: "content_report_own",
        message: "You cannot report your own post, comment or message.",
      },
    });
  });

  it("offers every reason the database knows, harassment first", () => {
    expect(CONTENT_REPORT_REASONS).toEqual([
      "Harassment",
      "Hate",
      "Sexual Content",
      "Violence",
      "Spam",
      "Other",
    ]);
  });

  it("blocks the person behind a membership", async () => {
    const { db, calls } = moduleClient({ "rpc:block_member": [ok("b1")] });
    expect(await blockMember(db, "mem1")).toEqual({ ok: true, data: "b1" });
    expect(stepsOf(calls[0], "args")[0]?.[0]).toEqual({ p_membership_id: "mem1" });
  });
});

describe("the moderators' queue", () => {
  it("maps the queue rows", async () => {
    const { db, calls } = moduleClient({
      "rpc:content_moderation_queue": [
        ok([
          {
            subject_kind: "Chat Message",
            subject_id: "m1",
            author_person_id: "p9",
            author_name: "Frank Adeyemi",
            content_excerpt: "Send me your address.",
            removed: false,
            open_reports: 2,
            total_reports: 2,
            reasons: ["Harassment", "Violence"],
            first_reported_at: "2026-10-23T10:00:00Z",
            due_at: "2026-10-24T10:00:00Z",
            overdue: false,
            last_action: null,
            last_decided_at: null,
          },
        ]),
        ok(null),
      ],
    });
    const result = await listContentModerationQueue(db, "org1");
    expect(result).toEqual({
      ok: true,
      data: [
        {
          kind: "Chat Message",
          id: "m1",
          authorPersonId: "p9",
          authorName: "Frank Adeyemi",
          excerpt: "Send me your address.",
          removed: false,
          openReports: 2,
          totalReports: 2,
          reasons: ["Harassment", "Violence"],
          firstReportedAt: "2026-10-23T10:00:00Z",
          dueAt: "2026-10-24T10:00:00Z",
          overdue: false,
          lastAction: null,
          lastDecidedAt: null,
        },
      ],
    });
    expect(stepsOf(calls[0], "args")[0]?.[0]).toEqual({ p_org_id: "org1", p_open: true });
    expect(await listContentModerationQueue(db, "org1", false)).toEqual({ ok: true, data: [] });
    expect(stepsOf(calls[1], "args")[0]?.[0]).toEqual({ p_org_id: "org1", p_open: false });
  });

  it("parses the detail document, with defaults for anything missing", async () => {
    const { db } = moduleClient({
      "rpc:content_report_detail": [
        ok({
          subject: {
            kind: "Feed Post",
            id: "p1",
            context: "Load-in",
            author_person_id: "p2",
            author_name: "Carol Nguyen",
            body: "Anyone late is useless.",
            removed: false,
          },
          reports: [
            {
              id: "r1",
              reason: "Harassment",
              details: null,
              content_excerpt: "Anyone late is useless.",
              reported_at: "2026-10-23T10:00:00Z",
              due_at: "2026-10-24T10:00:00Z",
              reporter_name: "Dave Lindqvist",
              open: true,
            },
          ],
          decisions: [
            {
              id: "d1",
              action: "No Action",
              ground: "No Violation",
              rule_reference: "AUP 1",
              facts: "A schedule note.",
              statement: "No rule broken.",
              decided_at: "2026-10-22T10:00:00Z",
              decided_by_name: "Bob Okafor",
            },
          ],
        }),
      ],
    });
    const result = await getContentReportDetail(db, "org1", { kind: "Feed Post", id: "p1" });
    expect(result.ok && result.data.subject).toMatchObject({
      kind: "Feed Post",
      authorName: "Carol Nguyen",
      removed: false,
    });
    expect(result.ok && result.data.reports[0]).toMatchObject({
      reporterName: "Dave Lindqvist",
      excerpt: "Anyone late is useless.",
      open: true,
    });
    expect(result.ok && result.data.decisions[0]).toMatchObject({
      ruleReference: "AUP 1",
      decidedByName: "Bob Okafor",
    });
    expect(parseContentReportDetail(null)).toEqual({
      subject: {
        kind: "",
        id: "",
        context: null,
        authorPersonId: null,
        authorName: null,
        body: null,
        removed: false,
      },
      reports: [],
      decisions: [],
    });
  });

  it("decides with the statement of reasons in parts", async () => {
    const { db, calls } = moduleClient({ "rpc:decide_content_report": [ok("d1")] });
    expect(
      await decideContentReport(
        db,
        "org1",
        { kind: "Comment", id: "c1" },
        {
          action: "Removed",
          ground: "Terms Violation",
          ruleReference: "Acceptable Use Policy 1",
          facts: "An insult.",
          statement: "We removed the comment.",
        },
      ),
    ).toEqual({ ok: true, data: "d1" });
    expect(stepsOf(calls[0], "args")[0]?.[0]).toEqual({
      p_org_id: "org1",
      p_subject_kind: "Comment",
      p_subject_id: "c1",
      p_action: "Removed",
      p_ground: "Terms Violation",
      p_rule_reference: "Acceptable Use Policy 1",
      p_facts: "An insult.",
      p_statement: "We removed the comment.",
    });
  });

  it("offers the grounds each action fits", () => {
    expect(contentGroundsFor("Removed")).toEqual(["Terms Violation", "Illegal Content"]);
    expect(contentGroundsFor("No Action")).toEqual(["No Violation"]);
  });
});
