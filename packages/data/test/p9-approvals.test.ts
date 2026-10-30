import { describe, expect, it } from "vitest";
import { isActionableApproval, type InboxItem } from "../src/inbox.ts";
import {
  decideThroughSignedOutLink,
  previewSignedOutApprovalLink,
  readSignedOutApprovalLink,
  toSignedOutCheck,
  toSignedOutLink,
} from "../src/notification-actions.ts";
import {
  approvalBySubject,
  toReminderStatus,
  toSubjectApproval,
  type SubjectApproval,
} from "../src/workflow.ts";
import type { XosClient } from "../src/client.ts";

/**
 * P9 (RRR-223, ADR 0138): the data layer of approval rules, signed-out approval links and reminders maps the database's
 * rows into typed results. The database masks the email and decides every refusal; this side never trusts a value it
 * does not recognize.
 */

const TOKEN = `xact_${"a".repeat(48)}.${"b".repeat(32)}`;

/** A client whose api_public RPCs answer with the given rows and record what they were asked. */
function publicClient(answer: unknown) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const db = {
    schema(name: string) {
      expect(name).toBe("api_public");
      return {
        rpc(fn: string, args: Record<string, unknown>) {
          calls.push({ fn, args });
          return Promise.resolve({ data: answer, error: null });
        },
      };
    },
  } as unknown as XosClient;
  return { db, calls };
}

describe("signed-out approval links", () => {
  it("reads the five fields of the token-only read, and nothing unknown", () => {
    expect(
      toSignedOutLink({
        link_state: "ready",
        action: "approve",
        org_name: "Northwind Live",
        masked_email: "i***@freelance.test",
        expires_at: "2027-06-08T12:00:00Z",
      }),
    ).toEqual({
      state: "ready",
      action: "approve",
      orgName: "Northwind Live",
      maskedEmail: "i***@freelance.test",
      expiresAt: "2027-06-08T12:00:00Z",
    });
    expect(toSignedOutLink({ link_state: "sign_in" }).state).toBe("sign_in");
    expect(toSignedOutLink({ link_state: "hacked", action: "approve" })).toMatchObject({
      state: "invalid",
      action: null,
    });
    expect(toSignedOutLink({ link_state: "ready", action: "accept" }).action).toBeNull();
    expect(toSignedOutLink(undefined).state).toBe("invalid");
  });

  it("never asks the database about a malformed token", async () => {
    const { db, calls } = publicClient([]);
    const read = await readSignedOutApprovalLink(db, "not-a-token");
    expect(read.ok && read.data.state).toBe("invalid");
    const decided = await decideThroughSignedOutLink(db, { token: "xact_x", code: "123456" });
    expect(decided.ok && decided.data.outcome).toBe("notification_action_invalid");
    expect(calls).toEqual([]);
  });

  it("maps refusal rows with the attempts left, and sends only a 6-digit code", async () => {
    expect(toSignedOutCheck({ outcome: "approval_link_code_wrong", attempts_left: 3 })).toEqual({
      outcome: "approval_link_code_wrong",
      attemptsLeft: 3,
    });
    expect(toSignedOutCheck({ outcome: "approval_link_locked", attempts_left: "0" })).toEqual({
      outcome: "approval_link_locked",
      attemptsLeft: 0,
    });
    expect(toSignedOutCheck({ outcome: "something_else" }).outcome).toBe(
      "notification_action_invalid",
    );
    const { db, calls } = publicClient([
      { outcome: "ok", attempts_left: 5, title: "Pass CR-000123 for Jane Doe", current_step_name: "Crew chief" },
    ]);
    const preview = await previewSignedOutApprovalLink(db, { token: TOKEN, code: " 123456 " });
    expect(preview.ok && preview.data).toEqual({
      outcome: "ok",
      attemptsLeft: 5,
      title: "Pass CR-000123 for Jane Doe",
      stepName: "Crew chief",
    });
    await previewSignedOutApprovalLink(db, { token: TOKEN, code: "12ab56" });
    expect(calls.map((c) => [c.fn, c.args["p_access_code"]])).toEqual([
      ["preview_approval_link", "123456"],
      ["preview_approval_link", ""],
    ]);
  });

  it("passes a rejection's reason trimmed, and none when blank", async () => {
    const { db, calls } = publicClient([{ outcome: "decided", attempts_left: 4, notification_id: "n1" }]);
    const decided = await decideThroughSignedOutLink(db, { token: TOKEN, code: "654321", comment: "  " });
    expect(decided.ok && decided.data).toEqual({ outcome: "decided", attemptsLeft: 4 });
    expect(calls[0]).toEqual({
      fn: "use_approval_link",
      args: { p_token: TOKEN, p_access_code: "654321", p_comment: null },
    });
  });
});

const baseItem: InboxItem = {
  id: "n1",
  createdAt: "2027-06-01T10:00:00Z",
  kind: "approval.requested",
  section: "Needs You",
  read: false,
  actorPersonId: null,
  subjectTable: "subject_approvals",
  subjectId: "a1",
  projectId: "p1",
  args: {},
  approval: null,
  subjectApproval: { state: "In Review", subject: "Pass", currentStep: 1 },
};

describe("the Inbox acts on approval reminders and subject approvals", () => {
  it("offers A and R on a request or reminder about a subject approval in review", () => {
    expect(isActionableApproval(baseItem)).toBe(true);
    expect(isActionableApproval({ ...baseItem, kind: "approval.reminder" })).toBe(true);
    expect(
      isActionableApproval({ ...baseItem, subjectApproval: { state: "Approved", subject: "Pass", currentStep: null } }),
    ).toBe(false);
    expect(isActionableApproval({ ...baseItem, kind: "approval.decided" })).toBe(false);
    expect(isActionableApproval({ ...baseItem, kind: "approval.link_code" })).toBe(false);
  });

  it("offers them on a reminder about a spend approval in review, as on its request", () => {
    const spend: InboxItem = {
      ...baseItem,
      kind: "approval.reminder",
      subjectTable: "approval_instances",
      subjectApproval: null,
      approval: {
        instanceId: "i1",
        documentType: "Purchase Order",
        reference: "PO-1",
        amountMinor: 1000,
        currency: "USD",
        state: "In Review",
        currentStep: 1,
      },
    };
    expect(isActionableApproval(spend)).toBe(true);
  });
});

describe("subject approvals and reminder status", () => {
  const row = (id: string, credential: string, state: string): SubjectApproval =>
    toSubjectApproval({
      id,
      project_id: "p1",
      approval_rule_id: "r1",
      rule_name: "All Access passes",
      subject: "Pass",
      credential_id: credential,
      dock_slot_id: null,
      requested_by: null,
      created_at: "2027-06-01T10:00:00Z",
      approval_state: state,
      current_step: state === "In Review" ? 1 : null,
      current_step_name: state === "In Review" ? "Crew chief" : null,
      current_step_has_approver: state === "In Review" ? false : null,
      step_count: 2,
      waiting_since: "2027-06-01T10:00:00Z",
      cancel_reason: null,
      viewer_may_decide: null,
      current_step_approver_names: null,
    });

  it("maps a status row, keeping a step nobody may decide visible", () => {
    const a = row("a1", "c1", "In Review");
    expect(a).toMatchObject({
      requestedBy: null,
      currentStep: 1,
      currentStepHasApprover: false,
      viewerMayDecide: false,
      approverNames: [],
    });
  });

  it("keys the latest live approval by its pass, over a canceled one", () => {
    const map = approvalBySubject([row("a2", "c1", "Canceled"), row("a3", "c1", "In Review"), row("a4", "c2", "Approved")]);
    expect(map.get("c1")?.id).toBe("a3");
    expect(map.get("c2")?.state).toBe("Approved");
  });

  it("reads the reminder status of a pending approval", () => {
    expect(
      toReminderStatus({
        subject_table: "subject_approvals",
        subject_id: "a1",
        step_order: 1,
        waiting_since: "2027-06-01T10:00:00Z",
        last_notified_at: "2027-06-02T10:00:00Z",
        reminders_sent: 1,
        reminder_limit: 3,
        reminders_enabled: true,
        next_reminder_at: "2027-06-03T10:00:00Z",
        next_manual_at: "2027-06-02T14:00:00Z",
      }),
    ).toEqual({
      subjectTable: "subject_approvals",
      subjectId: "a1",
      step: 1,
      waitingSince: "2027-06-01T10:00:00Z",
      lastNotifiedAt: "2027-06-02T10:00:00Z",
      remindersSent: 1,
      reminderLimit: 3,
      remindersEnabled: true,
      nextReminderAt: "2027-06-03T10:00:00Z",
      nextManualAt: "2027-06-02T14:00:00Z",
    });
  });
});
