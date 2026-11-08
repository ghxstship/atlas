import { describe, expect, it } from "vitest";
import {
  decideEscalation,
  getContentEscalations,
  getEscalationDetail,
  parseEscalationDetail,
} from "../src/console.ts";
import { moduleClient, stepsOf } from "./module-client.ts";

const ok = (data: unknown) => ({ data, error: null });

describe("reported content an org left undecided, in the console (6891)", () => {
  it("lists the escalated items, reads one and decides it", async () => {
    const { db, calls } = moduleClient({
      "rpc:console_content_escalations": [
        ok([
          {
            org_id: "o1",
            org_name: "Northwind Live",
            subject_kind: "Chat Message",
            subject_id: "m1",
            removed: false,
            open_reports: 1,
            total_reports: 2,
            reasons: ["Violence", "Harassment"],
            first_reported_at: "t0",
            escalated_at: "t1",
            last_action: null,
            last_decided_at: null,
            decided_by_platform: false,
          },
        ]),
        ok(null),
      ],
      "rpc:console_content_escalation_detail": [
        ok({
          subject: {
            kind: "Chat Message",
            id: "m1",
            context: "Direct",
            org_id: "o1",
            org_name: "Northwind Live",
            author_name: "Frank",
            body: "Send me your address.",
            removed: false,
          },
          reports: [
            {
              id: "r1",
              reason: "Violence",
              details: null,
              content_excerpt: "Send me your address.",
              reported_at: "t0",
              escalated_at: "t1",
              open: true,
            },
          ],
          decisions: [
            {
              id: "d0",
              action: "No Action",
              ground: "No Violation",
              rule_reference: "AUP 1",
              facts: "Earlier.",
              statement: "Left.",
              decided_at: "t",
              by_platform: false,
            },
          ],
        }),
      ],
      "rpc:console_decide_content_escalation": [ok("d1")],
    });
    const open = await getContentEscalations(db);
    expect(open.ok && open.data[0]).toMatchObject({
      orgName: "Northwind Live",
      kind: "Chat Message",
      openReports: 1,
      reasons: ["Violence", "Harassment"],
      escalatedAt: "t1",
      lastAction: null,
      decidedByPlatform: false,
    });
    expect(stepsOf(calls[0], "args")[0]?.[0]).toEqual({ p_open: true });
    expect(await getContentEscalations(db, false)).toEqual({ ok: true, data: [] });
    expect(stepsOf(calls[1], "args")[0]?.[0]).toEqual({ p_open: false });

    const detail = await getEscalationDetail(db, "m1");
    expect(detail.ok && detail.data.subject.body).toBe("Send me your address.");
    expect(detail.ok && detail.data.reports[0]).toMatchObject({
      excerpt: "Send me your address.",
      open: true,
    });
    expect(detail.ok && detail.data.decisions[0]?.byPlatform).toBe(false);
    expect(stepsOf(calls[2], "args")[0]?.[0]).toEqual({ p_subject_id: "m1" });

    expect(
      await decideEscalation(db, "m1", {
        action: "Removed",
        ground: "Terms Violation",
        ruleReference: "Acceptable Use Policy 1",
        facts: "A threat.",
        statement: "We removed the message.",
      }),
    ).toEqual({ ok: true, data: "d1" });
    expect(stepsOf(calls[3], "args")[0]?.[0]).toMatchObject({
      p_subject_id: "m1",
      p_action: "Removed",
      p_rule_reference: "Acceptable Use Policy 1",
    });
  });

  it("reads a removed item with nothing missing as empty lists", () => {
    const detail = parseEscalationDetail({
      subject: { kind: "Feed Post", id: "p1", removed: true },
    });
    expect(detail.subject.body).toBeNull();
    expect(detail.subject.removed).toBe(true);
    expect(detail.reports).toEqual([]);
    expect(detail.decisions).toEqual([]);
  });
});
