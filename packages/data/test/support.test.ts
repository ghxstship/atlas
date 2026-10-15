import { describe, expect, it } from "vitest";
import {
  getSupportTicket,
  listSupportTickets,
  openSupportTicket,
  postSupportMessage,
  transitionSupportTicket,
} from "../src/support.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

const ticketRow = {
  id: "t1",
  ticket_number: "SUP-0001",
  queue: "Organization",
  category: "Access",
  severity: "Severity 3",
  subject: "Scanner",
  body: "Unknown zone.",
  ticket_state: "Open",
  channel: "In App",
  first_response_due_at: null,
  first_responded_at: null,
  created_at: "2026-10-15T10:00:00Z",
  membership_id: "m1",
  memberships: { people: { full_name: "Dana Field" } },
};

describe("support tickets", () => {
  it("lists tickets with filters", async () => {
    const { db, calls } = fakeClient({
      "from:support_tickets": [
        okResponse([ticketRow]),
        okResponse(null),
        errorResponse("500", "x"),
      ],
    });
    const result = await listSupportTickets(db, {
      orgId: "o",
      queue: "Organization",
      states: ["Open", "Waiting"],
      requesterMembershipId: "m1",
    });
    if (!result.ok) throw new Error("expected tickets");
    expect(result.data[0]).toMatchObject({
      number: "SUP-0001",
      requesterName: "Dana Field",
      state: "Open",
    });
    expect(calls[0]?.steps.some(([s, a]) => s === "in" && a[0] === "ticket_state")).toBe(true);
    expect(await listSupportTickets(db, { orgId: "o" })).toEqual({ ok: true, data: [] });
    expect((await listSupportTickets(db, { orgId: "o" })).ok).toBe(false);
  });

  it("reads a ticket with diagnostics, messages and next states", async () => {
    const { db } = fakeClient({
      "from:support_tickets": [okResponse({ ...ticketRow, memberships: null })],
      "from:support_ticket_diagnostics": [
        okResponse({
          consented_at: "2026-10-15T10:00:00Z",
          route: "/demo/credentials/scans",
          app_version: "4.0.0",
          device: "Safari",
          recent_errors: null,
          screenshot_path: null,
        }),
      ],
      "from:support_ticket_messages": [
        okResponse([
          {
            id: "x1",
            author_membership_id: null,
            body: "Hello",
            created_at: "2026-10-15T11:00:00Z",
            memberships: null,
          },
          {
            id: "x2",
            author_membership_id: "m2",
            body: "Hi",
            created_at: "2026-10-15T12:00:00Z",
            memberships: { people: { full_name: "Ari Admin" } },
          },
        ]),
      ],
      "from:lifecycle_transition_rules": [
        okResponse([{ to_state: "Waiting" }, { to_state: "Closed" }]),
      ],
    });
    const result = await getSupportTicket(db, "t1");
    if (!result.ok) throw new Error("expected a ticket");
    expect(result.data.requesterName).toBeNull();
    expect(result.data.diagnostics?.route).toBe("/demo/credentials/scans");
    expect(result.data.messages.map((m) => m.authorName)).toEqual([null, "Ari Admin"]);
    expect(result.data.nextStates).toEqual(["Waiting", "Closed"]);
  });

  it("returns ticket read failures", async () => {
    const missing = fakeClient({
      "from:support_tickets": [okResponse(null), errorResponse("500", "x")],
    });
    expect(await getSupportTicket(missing.db, "t1")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect((await getSupportTicket(missing.db, "t1")).ok).toBe(false);
    for (const failing of ["diagnostics", "messages", "rules"] as const) {
      const { db } = fakeClient({
        "from:support_tickets": [okResponse(ticketRow)],
        "from:support_ticket_diagnostics": [
          failing === "diagnostics" ? errorResponse("500", "x") : okResponse(null),
        ],
        "from:support_ticket_messages": [
          failing === "messages" ? errorResponse("500", "x") : okResponse(null),
        ],
        "from:lifecycle_transition_rules": [
          failing === "rules" ? errorResponse("500", "x") : okResponse(null),
        ],
      });
      expect((await getSupportTicket(db, "t1")).ok).toBe(false);
    }
    const empty = fakeClient({
      "from:support_tickets": [okResponse(ticketRow)],
      "from:support_ticket_diagnostics": [okResponse(null)],
      "from:support_ticket_messages": [okResponse(null)],
      "from:lifecycle_transition_rules": [okResponse(null)],
    });
    const result = await getSupportTicket(empty.db, "t1");
    expect(result.ok && result.data.diagnostics === null && result.data.messages.length === 0).toBe(
      true,
    );
  });

  it("opens tickets with consented diagnostics only when given", async () => {
    const { db, calls } = fakeClient({
      "rpc:open_support_ticket": [
        okResponse("t1"),
        okResponse("t2"),
        errorResponse("XR001", "support_plan_no_channel: Access", "support_plan_no_channel"),
      ],
    });
    const base = {
      orgId: "o",
      queue: "Organization" as const,
      category: "Problem" as const,
      subject: "S",
      body: "B",
    };
    expect(
      await openSupportTicket(db, {
        ...base,
        severity: "Severity 2",
        diagnostics: { route: "/demo/home", appVersion: "4.0.0" },
      }),
    ).toEqual({ ok: true, data: "t1" });
    expect(calls[0]?.steps[0]?.[1][0]).toMatchObject({
      p_severity: "Severity 2",
      p_diagnostics: { consent: true, route: "/demo/home", app_version: "4.0.0", device: null },
    });
    expect((await openSupportTicket(db, base)).ok).toBe(true);
    expect(calls[1]?.steps[0]?.[1][0]).not.toHaveProperty("p_diagnostics");
    const refused = await openSupportTicket(db, { ...base, queue: "Platform" });
    expect(refused.ok ? null : refused.error).toMatchObject({
      kind: "refusal",
      rule: "support_plan_no_channel",
    });
  });

  it("posts messages and moves states", async () => {
    const { db } = fakeClient({
      "rpc:post_support_message": [
        okResponse("x1"),
        errorResponse("XR001", "support_ticket_closed: closed", "support_ticket_closed"),
      ],
      "rpc:transition_support_ticket": [
        okResponse("l1"),
        errorResponse(
          "XR001",
          "support_ticket_transition_forbidden: no",
          "support_ticket_transition_forbidden",
        ),
      ],
    });
    expect(await postSupportMessage(db, "t1", "Hello")).toEqual({ ok: true, data: "x1" });
    expect((await postSupportMessage(db, "t1", "Hello")).ok).toBe(false);
    const move = {
      ticketId: "t1",
      expected: "Open" as const,
      next: "Closed" as const,
      reason: "Done.",
    };
    expect((await transitionSupportTicket(db, move)).ok).toBe(true);
    expect((await transitionSupportTicket(db, move)).ok).toBe(false);
  });
});
