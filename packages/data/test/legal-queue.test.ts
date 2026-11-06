import { describe, expect, it } from "vitest";
import {
  addLegalAlertContact,
  addLegalQueueItem,
  appointOutsideReviewer,
  endOutsideReviewer,
  extendLegalQueueItem,
  getLegalQueue,
  getLegalQueueItem,
  getLegalQueueOverdue,
  noteLegalQueueItem,
  recordLegalFirstResponse,
  removeLegalAlertContact,
  transitionLegalQueueItem,
} from "../src/console-legal-queue.ts";
import { moduleClient, stepsOf } from "./module-client.ts";

/** The legal queue (ADR 0167, migrations 6165 to 6168): the console's repository over its RPCs. */
const ok = (data: unknown) => ({ data, error: null });
const refused = (rule: string) => ({
  data: null,
  error: { code: "XR001", message: `${rule}: Refused.`, hint: rule },
});

const row = {
  id: "i1",
  reference: "LQ-2026-00001",
  matter: "DMCA Counter-Notice",
  rule_code: "dmca_counter_notice",
  basis: "Statute",
  customer_clock: false,
  title: "Says it is licensed",
  state: "Received",
  org_name: null,
  received_at: "2026-11-06T15:00:00Z",
  first_response_due_at: "2026-11-10T04:59:59Z",
  first_response_at: null,
  earliest_action_at: "2026-11-24T04:59:59Z",
  due_at: "2026-11-30T04:59:59Z",
  next_clock_at: "2026-11-10T04:59:59Z",
  extended_at: null,
  closed_at: null,
  fed: false,
  overdue: true,
};

describe("legal queue", () => {
  it("reads the queue with its counts, delivery health and what it promises to count", async () => {
    const { db, calls } = moduleClient({
      "rpc:console_legal_queue": [
        ok({
          time_zone: "America/New_York",
          items: [row],
          summary: { open: 1, overdue: 1, due_soon: 0 },
          delivery: {
            stuck: 2,
            failed: 0,
            last_sent_at: null,
            overdue_without_alert: 1,
            webhook_configured: false,
          },
          repeat_infringers: [
            {
              person_id: "p1",
              name: "Rene",
              counted: 3,
              window_start: "2026-01-01T00:00:00Z",
              threshold_met: true,
            },
          ],
          government_requests: [{ year: 2026, received: 1 }],
          contacts: [{ id: "c1", name: "Backup", email: "backup@example.test" }],
          outside_reviewer: null,
          rules: [{ code: "security_report", matter: "Security Report", due_from_document: false }],
        }),
        refused("step_up_required"),
      ],
    });
    const queue = await getLegalQueue(db);
    expect(stepsOf(calls[0], "args")[0]?.[0]).toEqual({ p_open: true });
    expect(queue.ok && queue.data.timeZone).toBe("America/New_York");
    expect(queue.ok && queue.data.items[0]).toMatchObject({
      reference: "LQ-2026-00001",
      nextClockAt: "2026-11-10T04:59:59Z",
      overdue: true,
    });
    expect(queue.ok && queue.data.delivery).toEqual({
      stuck: 2,
      failed: 0,
      lastSentAt: null,
      overdueWithoutAlert: 1,
      webhookConfigured: false,
    });
    expect(queue.ok && queue.data.repeatInfringers[0]?.thresholdMet).toBe(true);
    expect(queue.ok && queue.data.governmentRequests).toEqual([{ year: 2026, received: 1 }]);
    expect(queue.ok && queue.data.outsideReviewer).toBeNull();
    expect(queue.ok && queue.data.rules[0]?.dueFromDocument).toBe(false);
    expect((await getLegalQueue(db)).ok).toBe(false);
  });

  it("reads an outside reviewer when one is appointed", async () => {
    const { db } = moduleClient({
      "rpc:console_legal_queue": [
        ok({
          time_zone: "America/New_York",
          outside_reviewer: {
            id: "r1",
            name: "Noor Adeyemi",
            organization: null,
            email: "noor@adeyemi.test",
            appointed_at: "2026-11-06T15:00:00Z",
          },
        }),
      ],
    });
    const queue = await getLegalQueue(db, false);
    expect(queue.ok && queue.data.outsideReviewer?.name).toBe("Noor Adeyemi");
    expect(queue.ok && queue.data.items).toEqual([]);
  });

  it("reads one item with its log and the moves open to it", async () => {
    const { db } = moduleClient({
      "rpc:console_legal_queue_item": [
        ok({
          ...row,
          time_zone: "America/New_York",
          details: "Licensed from the studio.",
          requester_contact: "rene@uploader.test",
          court_action_filed: false,
          subject_name: null,
          related_id: "n1",
          related_reference: "LQ-2026-00000",
          extendable: false,
          opportunity_id: null,
          next_states: ["In Progress", "Completed"],
          events: [
            {
              id: "e1",
              kind: "Received",
              from_state: null,
              to_state: "Received",
              note: null,
              at: "2026-11-06T15:00:00Z",
              actor_name: null,
            },
          ],
        }),
      ],
    });
    const item = await getLegalQueueItem(db, "i1");
    expect(item.ok && item.data.nextStates).toEqual(["In Progress", "Completed"]);
    expect(item.ok && item.data.relatedReference).toBe("LQ-2026-00000");
    expect(item.ok && item.data.events[0]).toMatchObject({ kind: "Received", actorName: null });
  });

  it("reads the overdue count for the banner", async () => {
    const { db } = moduleClient({ "rpc:console_legal_queue_overdue": [ok(3)] });
    expect(await getLegalQueueOverdue(db)).toEqual({ ok: true, data: 3 });
  });

  it("passes each write to its RPC", async () => {
    const { db, calls } = moduleClient({
      "rpc:console_add_legal_queue_item": [ok("i1")],
      "rpc:console_note_legal_queue_item": [ok("e1")],
      "rpc:console_record_legal_first_response": [ok("e2")],
      "rpc:console_transition_legal_queue_item": [ok("e3"), refused("legal_queue_too_early")],
      "rpc:console_extend_legal_queue_item": [ok("2027-02-03T04:59:59Z")],
      "rpc:console_add_legal_alert_contact": [ok("c1")],
      "rpc:console_remove_legal_alert_contact": [ok(null)],
      "rpc:console_appoint_outside_reviewer": [ok("r1")],
      "rpc:console_end_outside_reviewer": [ok(null)],
    });
    expect(
      await addLegalQueueItem(db, {
        ruleCode: "government_request",
        title: "Subpoena",
        receivedLocal: "2026-11-06T10:00",
        dueLocal: "2026-12-01T17:00",
      }),
    ).toEqual({ ok: true, data: "i1" });
    expect(stepsOf(calls[0], "args")[0]?.[0]).toEqual({
      p_rule_code: "government_request",
      p_title: "Subpoena",
      p_received_local: "2026-11-06T10:00",
      p_details: null,
      p_requester_contact: null,
      p_subject_email: null,
      p_related_reference: null,
      p_due_local: "2026-12-01T17:00",
    });
    expect((await noteLegalQueueItem(db, "i1", "Called them.")).ok).toBe(true);
    expect((await recordLegalFirstResponse(db, "i1", "Acknowledged.")).ok).toBe(true);
    expect(
      (
        await transitionLegalQueueItem(db, {
          itemId: "i1",
          expected: "Received",
          next: "Completed",
          reason: "Done.",
        })
      ).ok,
    ).toBe(true);
    expect(stepsOf(calls[3], "args")[0]?.[0]).toMatchObject({
      p_court_action_filed: false,
      p_re_review_notes: null,
      p_told_how: null,
      p_same_person: false,
      p_outside_reviewer_decided: false,
    });
    const early = await transitionLegalQueueItem(db, {
      itemId: "i1",
      expected: "Received",
      next: "Completed",
      reason: "Restored.",
      courtActionFiled: true,
    });
    expect(!early.ok && early.error).toMatchObject({
      kind: "refusal",
      rule: "legal_queue_too_early",
    });
    expect(await extendLegalQueueItem(db, "i1", "Complex.")).toEqual({
      ok: true,
      data: "2027-02-03T04:59:59Z",
    });
    expect((await addLegalAlertContact(db, "Backup", "backup@example.test")).ok).toBe(true);
    expect(await removeLegalAlertContact(db, "c1")).toEqual({ ok: true, data: null });
    expect(
      await appointOutsideReviewer(db, {
        name: "Noor",
        organization: null,
        email: "noor@adeyemi.test",
        reason: "Appeals.",
      }),
    ).toEqual({ ok: true, data: "r1" });
    expect(await endOutsideReviewer(db, "r1", "Ended.")).toEqual({ ok: true, data: null });
  });
});
