/**
 * Contract tests for A31's Platform handlers (Section 18, gate 5): saved view team shares and per-page
 * defaults, tour progress, tip dismissals, and support requests with their messages and diagnostics.
 * Requests run through `contractApp`, every response is checked against openapi/v1.json with
 * `expectContract`, and the database is a recording stand-in for supabase-js: each `from(table)` or
 * `rpc(name)` call takes the next queued response. Refusals (422) and hidden rows (404) are checked.
 */
import { describe, expect, it } from "vitest";
import { handlers } from "../src/handlers/platform.ts";
import { contractApp, expectContract, testContext } from "./support/contract.ts";

type Response = { data: unknown; error: { code: string; message: string; hint?: string } | null };
type Call = { target: string; steps: [string, unknown[]][] };

function fakeDb(queues: Record<string, Response[]>) {
  const calls: Call[] = [];
  const take = (key: string): Response => {
    const next = queues[key]?.shift();
    if (!next) throw new Error(`no queued response for ${key}`);
    return next;
  };
  const builder = (key: string, steps: [string, unknown[]][]) => {
    const response = take(key);
    const proxy: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") return (resolve: (r: Response) => unknown) => resolve(response);
          return (...args: unknown[]) => {
            steps.push([prop, args]);
            return proxy;
          };
        },
      },
    );
    return proxy;
  };
  const db: Record<string, unknown> = {
    from(table: string) {
      const call: Call = { target: `from:${table}`, steps: [] };
      calls.push(call);
      return builder(call.target, call.steps);
    },
    rpc(name: string, args: unknown) {
      const call: Call = { target: `rpc:${name}`, steps: [["args", [args]]] };
      calls.push(call);
      return builder(call.target, call.steps);
    },
  };
  db["schema"] = () => db;
  return { db, calls };
}

const ctx = testContext();
const ORG = ctx.org?.id as string;
const T = "2026-10-15T12:00:00.000Z";
const id = (n: number) => `0192f1e2-7c3a-7b4d-9e8f-${String(n).padStart(12, "0")}`;
const ok = (data: unknown): Response => ({ data, error: null });
const refusal = (rule: string): Response => ({
  data: null,
  error: { code: "XR001", message: `${rule}: Refused.`, hint: rule },
});
const hidden: Response = { data: null, error: null };
const audit = (n: number) => ({
  id: id(n),
  org_id: ORG,
  created_at: T,
  created_by: null,
  updated_at: T,
  updated_by: null,
});

let keys = 0;
const post = (body: unknown) => ({
  method: "POST",
  headers: { "Idempotency-Key": `a31-contract-${(keys += 1)}`, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const patch = (body: unknown) => ({
  method: "PATCH",
  headers: { "If-Match": "*", "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const del = { method: "DELETE" };

function app(queues: Record<string, Response[]>) {
  const fake = fakeDb(queues);
  return { api: contractApp({ handlers: [handlers], db: fake.db as never }), calls: fake.calls };
}

const share = { ...audit(1), saved_view_id: id(100), team_id: id(200) };
const preference = {
  ...audit(2),
  membership_id: id(300),
  collection_key: "logistics/shipments",
  saved_view_id: id(100),
};
const tour = {
  ...audit(3),
  membership_id: id(300),
  tour_key: "atlas.getting-started",
  tour_state: "Started",
  step: 1,
};
const tip = { ...audit(4), membership_id: id(300), tip_key: "gates" };
const ticket = {
  ...audit(5),
  membership_id: id(300),
  ticket_number: "SUP-0001",
  queue: "Organization",
  category: "Access",
  severity: "Severity 3",
  subject: "Scanner shows an unknown zone",
  body: "Zone B denies every Crew wristband.",
  ticket_state: "Open",
  channel: "In App",
  first_response_due_at: null,
  first_responded_at: null,
};
const message = {
  ...audit(6),
  support_ticket_id: id(5),
  author_membership_id: id(300),
  body: "Which zone did you pick?",
};
const diagnostics = {
  ...audit(7),
  support_ticket_id: id(5),
  consented_at: T,
  route: "/demo/credentials/scans",
  app_version: "4.0.0 (812)",
  device: "Safari 19 on iOS 26",
  recent_errors: null,
  screenshot_path: null,
};

describe("Saved view shares and defaults", () => {
  it("shares a view with a team and unshares it", async () => {
    const { api } = app({
      "from:saved_view_shares": [
        ok([share]),
        ok(share),
        ok({ id: share.id }),
        ok(share),
        ok({ id: share.id }),
        ok(null),
        hidden,
      ],
    });
    await expectContract(await api.request("/saved-view-shares"), "savedViewShares.list");
    await expectContract(
      await api.request(`/saved-view-shares/${share.id}`),
      "savedViewShares.get",
    );
    const made = await api.request(
      "/saved-view-shares",
      post({ saved_view_id: id(100), team_id: id(200) }),
    );
    expect(made.status).toBe(201);
    await expectContract(made, "savedViewShares.create");
    const removed = await api.request(`/saved-view-shares/${share.id}`, del);
    expect(removed.status).toBe(204);
    await expectContract(removed, "savedViewShares.delete");
    expect((await api.request(`/saved-view-shares/${id(999)}`)).status).toBe(404);
  });

  it("sets a default through the RPC and refuses a view of another page", async () => {
    const { api, calls } = app({
      "rpc:set_saved_view_default": [ok(preference.id), refusal("saved_view_default_collection")],
      "from:saved_view_defaults": [
        ok(preference),
        ok([preference]),
        ok(preference),
        ok({ id: preference.id }),
        ok(null),
      ],
    });
    const made = await api.request("/saved-view-defaults", post({ saved_view_id: id(100) }));
    expect(made.status).toBe(201);
    await expectContract(made, "savedViewDefaults.create");
    expect(calls[0]?.steps[0]?.[1][0]).toEqual({ p_saved_view_id: id(100) });
    await expectContract(await api.request("/saved-view-defaults"), "savedViewDefaults.list");
    await expectContract(
      await api.request(`/saved-view-defaults/${preference.id}`),
      "savedViewDefaults.get",
    );
    const removed = await api.request(`/saved-view-defaults/${preference.id}`, del);
    await expectContract(removed, "savedViewDefaults.delete");
    const refused = await api.request("/saved-view-defaults", post({ saved_view_id: id(101) }));
    expect(refused.status).toBe(422);
    await expectContract(refused, "savedViewDefaults.create");
  });
});

describe("Tours and tips", () => {
  it("records tour progress for the caller's membership", async () => {
    const { api, calls } = app({
      "from:memberships": [ok([{ id: id(300) }]), ok([{ id: id(300) }])],
      "from:tour_progress": [
        ok([tour]),
        ok(tour),
        ok({ id: tour.id }),
        ok(tour),
        ok(tour),
        ok([{ id: tour.id }]),
        ok({ ...tour, tour_state: "Completed", step: 4 }),
        refusal("tour_offered_once"),
      ],
    });
    await expectContract(await api.request("/tour-progress"), "tourProgress.list");
    await expectContract(await api.request(`/tour-progress/${tour.id}`), "tourProgress.get");
    const made = await api.request(
      "/tour-progress",
      post({ tour_key: "atlas.getting-started", tour_state: "Offered", step: 0 }),
    );
    await expectContract(made, "tourProgress.create");
    const insert = calls.find(
      (c) => c.target === "from:tour_progress" && c.steps[0]?.[0] === "insert",
    );
    expect(insert?.steps[0]?.[1][0]).toMatchObject({ membership_id: id(300) });
    const done = await api.request(
      `/tour-progress/${tour.id}`,
      patch({ tour_state: "Completed", step: 4 }),
    );
    await expectContract(done, "tourProgress.update");
    const again = await api.request(
      "/tour-progress",
      post({ tour_key: "atlas.getting-started", tour_state: "Offered", step: 0 }),
    );
    expect(again.status).toBe(422);
    await expectContract(again, "tourProgress.create");
  });

  it("refuses a caller who is not a member", async () => {
    const { api } = app({ "from:memberships": [ok([])] });
    const made = await api.request("/tip-dismissals", post({ tip_key: "gates" }));
    expect(made.status).toBe(422);
    await expectContract(made, "tipDismissals.create");
  });

  it("dismisses and resets a tip", async () => {
    const { api } = app({
      "from:memberships": [ok([{ id: id(300) }])],
      "from:tip_dismissals": [
        ok([tip]),
        ok(tip),
        ok({ id: tip.id }),
        ok(tip),
        ok({ id: tip.id }),
        ok(null),
      ],
    });
    await expectContract(await api.request("/tip-dismissals"), "tipDismissals.list");
    await expectContract(await api.request(`/tip-dismissals/${tip.id}`), "tipDismissals.get");
    await expectContract(
      await api.request("/tip-dismissals", post({ tip_key: "gates" })),
      "tipDismissals.create",
    );
    const removed = await api.request(`/tip-dismissals/${tip.id}`, del);
    await expectContract(removed, "tipDismissals.delete");
  });
});

describe("Support requests", () => {
  it("opens a request with consented diagnostics and refuses the Access plan", async () => {
    const { api, calls } = app({
      "rpc:open_support_ticket": [ok(ticket.id), refusal("support_plan_no_channel")],
      "from:support_tickets": [ok(ticket), ok([ticket]), ok(ticket)],
    });
    const made = await api.request(
      "/support-tickets",
      post({
        queue: "Organization",
        category: "Access",
        subject: ticket.subject,
        body: ticket.body,
        diagnostics: { consent: true, route: "/demo/credentials/scans" },
      }),
    );
    expect(made.status).toBe(201);
    await expectContract(made, "supportTickets.open");
    expect(calls[0]?.steps[0]?.[1][0]).toMatchObject({
      p_org_id: ORG,
      p_queue: "Organization",
      p_diagnostics: { consent: true, route: "/demo/credentials/scans" },
    });
    await expectContract(await api.request("/support-tickets"), "supportTickets.list");
    await expectContract(await api.request(`/support-tickets/${ticket.id}`), "supportTickets.get");
    const refused = await api.request(
      "/support-tickets",
      post({ queue: "Platform", category: "Question", subject: "Plans", body: "Which plan?" }),
    );
    expect(refused.status).toBe(422);
    await expectContract(refused, "supportTickets.open");
  });

  it("moves a request and refuses a requester resolving it", async () => {
    const { api } = app({
      "from:support_tickets": [
        ok({ id: ticket.id }),
        ok({ ...ticket, ticket_state: "Waiting" }),
        ok({ id: ticket.id }),
      ],
      "rpc:transition_support_ticket": [
        ok(id(900)),
        refusal("support_ticket_transition_forbidden"),
      ],
    });
    const moved = await api.request(
      `/support-tickets/${ticket.id}/transition`,
      post({ expected_state: "Open", to_state: "Waiting", reason: "Asked for the zone." }),
    );
    await expectContract(moved, "supportTickets.transition");
    const refused = await api.request(
      `/support-tickets/${ticket.id}/transition`,
      post({ expected_state: "Waiting", to_state: "Resolved", reason: "Fixed." }),
    );
    expect(refused.status).toBe(422);
    await expectContract(refused, "supportTickets.transition");
  });

  it("replies, refuses a closed request and hides another's", async () => {
    const { api } = app({
      "from:support_tickets": [ok({ id: ticket.id }), ok({ id: ticket.id }), hidden],
      "rpc:post_support_message": [ok(message.id), refusal("support_ticket_closed")],
      "from:support_ticket_messages": [ok(message), ok([message]), ok(message)],
      "from:support_ticket_diagnostics": [ok([diagnostics]), ok(diagnostics)],
    });
    const replied = await api.request(
      `/support-tickets/${ticket.id}/reply`,
      post({ body: "Which zone did you pick?" }),
    );
    expect(replied.status).toBe(201);
    await expectContract(replied, "supportTickets.reply");
    const closed = await api.request(
      `/support-tickets/${ticket.id}/reply`,
      post({ body: "More." }),
    );
    expect(closed.status).toBe(422);
    const other = await api.request(`/support-tickets/${id(998)}/reply`, post({ body: "Hi." }));
    expect(other.status).toBe(404);
    await expectContract(
      await api.request("/support-ticket-messages"),
      "supportTicketMessages.list",
    );
    await expectContract(
      await api.request(`/support-ticket-messages/${message.id}`),
      "supportTicketMessages.get",
    );
    await expectContract(
      await api.request("/support-ticket-diagnostics"),
      "supportTicketDiagnostics.list",
    );
    await expectContract(
      await api.request(`/support-ticket-diagnostics/${diagnostics.id}`),
      "supportTicketDiagnostics.get",
    );
  });
});
