/**
 * Contract tests for A84's handlers (Section 18, gate 5; RRR-129, ADR 0038): calendar feed rotation,
 * a person's own calendar feeds, the project inbox address and filing or discarding inbound mail.
 * Requests run through `contractApp`, every response is checked against openapi/v1.json with
 * `expectContract`, and the database is a recording stand-in for supabase-js. Refusals (422) and
 * hidden rows (404) are checked. Feed tokens are built at run time, never written as literals.
 */
import { describe, expect, it } from "vitest";
import { handlers as platformHandlers } from "../src/handlers/platform.ts";
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
const T = "2026-10-20T12:00:00.000Z";
const id = (n: number) => `0192f1e2-7c3a-7b4d-9e8f-${String(n).padStart(12, "0")}`;
const feedToken = (digit: string) => `xcal_${digit.repeat(64)}`;
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
  headers: { "Idempotency-Key": `a84-contract-${(keys += 1)}`, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

function app(queues: Record<string, Response[]>) {
  const fake = fakeDb(queues);
  return {
    api: contractApp({ handlers: [platformHandlers], db: fake.db as never }),
    calls: fake.calls,
  };
}

const personFeed = {
  id: id(1),
  created_at: T,
  updated_at: T,
  person_id: id(700),
  token_hint: "aaaa",
  last_accessed_at: null,
  rotated_at: null,
};
const inbox = {
  ...audit(2),
  project_id: id(800),
  local_part: "nwl-0a1b2c3d4e",
  disabled_at: null,
};
const message = {
  ...audit(3),
  purpose: "Project Inbox",
  inbound_address_id: inbox.id,
  from_address: "rigging@bayside-audio.test",
  subject_line: "Rigging plot v4",
  body_text: "Updated plot attached.",
  dkim_verified: true,
  inbound_status: "Verified",
  rejection_reason: null,
  received_at: T,
  filed_document_id: null,
  filed_record_id: null,
  filed_by: null,
  filed_at: null,
  discarded_at: null,
  discarded_by: null,
  discard_reason: null,
};

describe("Calendar feeds", () => {
  it("rotates a member feed and returns the new token once", async () => {
    const { api, calls } = app({
      "from:calendar_feeds": [ok({ id: id(4) }), hidden],
      "rpc:rotate_calendar_feed": [ok([{ calendar_feed_id: id(4), feed_token: feedToken("b") }])],
    });
    const rotated = await api.request(`/calendar-feeds/${id(4)}/rotate`, post({}));
    expect(await expectContract(rotated, "calendarFeeds.rotate")).toEqual({
      calendar_feed_id: id(4),
      feed_token: feedToken("b"),
    });
    expect(calls.find((c) => c.target === "rpc:rotate_calendar_feed")?.steps[0]?.[1][0]).toEqual({
      p_calendar_feed_id: id(4),
    });
    expect((await api.request(`/calendar-feeds/${id(5)}/rotate`, post({}))).status).toBe(404);
  });

  it("lists, creates, rotates and revokes personal feeds", async () => {
    const { api, calls } = app({
      "from:person_calendar_feeds": [
        ok([personFeed]),
        ok(personFeed),
        ok({ id: personFeed.id }),
        ok({ id: personFeed.id }),
        ok(null),
      ],
      "rpc:create_person_calendar_feed": [
        ok([{ calendar_feed_id: id(6), feed_token: feedToken("c") }]),
        refusal("calendar_feed_limit"),
      ],
      "rpc:rotate_person_calendar_feed": [
        ok([{ calendar_feed_id: personFeed.id, feed_token: feedToken("d") }]),
      ],
    });
    await expectContract(await api.request("/person-calendar-feeds"), "personCalendarFeeds.list");
    await expectContract(
      await api.request(`/person-calendar-feeds/${personFeed.id}`),
      "personCalendarFeeds.get",
    );
    const made = await api.request("/person-calendar-feeds", post({}));
    expect(made.status).toBe(201);
    await expectContract(made, "personCalendarFeeds.create");
    const limited = await api.request("/person-calendar-feeds", post({}));
    expect(limited.status).toBe(422);
    await expectContract(limited, "personCalendarFeeds.create");
    const relinked = await api.request(`/person-calendar-feeds/${personFeed.id}/rotate`, post({}));
    await expectContract(relinked, "personCalendarFeeds.rotate");
    const removed = await api.request(`/person-calendar-feeds/${personFeed.id}`, {
      method: "DELETE",
      headers: { "Idempotency-Key": `a84-contract-${(keys += 1)}` },
    });
    expect(removed.status).toBe(204);
    await expectContract(removed, "personCalendarFeeds.delete");
    const revoke = calls.filter((c) => c.target === "from:person_calendar_feeds").at(-1);
    expect(revoke?.steps.map(([step]) => step)).toContain("update");
  });
});

describe("Project inboxes", () => {
  it("lists, creates, replaces and disables an inbox address", async () => {
    const { api, calls } = app({
      "from:inbound_addresses": [
        ok([inbox]),
        ok(inbox),
        ok({ id: inbox.id }),
        ok(inbox),
        ok({ project_id: inbox.project_id }),
        ok({ id: id(9) }),
        ok({ ...inbox, id: id(9), local_part: "nwl-ffeeddccbb" }),
        ok({ project_id: inbox.project_id }),
        ok({ ...inbox, disabled_at: T }),
      ],
      "rpc:create_project_inbox": [ok(inbox.local_part), refusal("project_not_found")],
      "rpc:replace_project_inbox": [ok("nwl-ffeeddccbb")],
      "rpc:disable_project_inbox": [ok(null)],
    });
    await expectContract(await api.request("/project-inboxes"), "projectInboxes.list");
    await expectContract(await api.request(`/project-inboxes/${inbox.id}`), "projectInboxes.get");
    const made = await api.request("/project-inboxes", post({ project_id: inbox.project_id }));
    expect(made.status).toBe(201);
    await expectContract(made, "projectInboxes.create");
    expect(calls.find((c) => c.target === "rpc:create_project_inbox")?.steps[0]?.[1][0]).toEqual({
      p_project_id: inbox.project_id,
    });
    const refused = await api.request("/project-inboxes", post({ project_id: inbox.project_id }));
    expect(refused.status).toBe(422);
    const replaced = await api.request(`/project-inboxes/${inbox.id}/replace`, post({}));
    expect(await expectContract(replaced, "projectInboxes.replace")).toMatchObject({
      local_part: "nwl-ffeeddccbb",
    });
    const disabled = await api.request(`/project-inboxes/${inbox.id}/disable`, post({}));
    await expectContract(disabled, "projectInboxes.disable");
  });
});

describe("Inbound messages", () => {
  it("lists mail, files it as a document and discards it", async () => {
    const filed = { ...message, inbound_status: "Filed", filed_document_id: id(10), filed_at: T };
    const { api, calls } = app({
      "from:inbound_messages": [
        ok([message]),
        ok(message),
        hidden,
        ok({ id: message.id }),
        ok(filed),
        ok({ id: message.id }),
        ok({ id: id(11) }),
        ok({
          ...message,
          id: id(11),
          discarded_at: T,
          discarded_by: id(700),
          discard_reason: "Spam.",
        }),
      ],
      "rpc:file_inbound_message": [ok(id(10)), refusal("inbound_message_triaged")],
      "rpc:discard_inbound_message": [ok(null)],
    });
    await expectContract(await api.request("/inbound-messages"), "inboundMessages.list");
    await expectContract(
      await api.request(`/inbound-messages/${message.id}`),
      "inboundMessages.get",
    );
    expect((await api.request(`/inbound-messages/${id(999)}`)).status).toBe(404);
    const done = await api.request(
      `/inbound-messages/${message.id}/file`,
      post({ title: "Rigging plot v4", record_id: id(12) }),
    );
    await expectContract(done, "inboundMessages.file");
    expect(calls.find((c) => c.target === "rpc:file_inbound_message")?.steps[0]?.[1][0]).toEqual({
      p_inbound_message_id: message.id,
      p_title: "Rigging plot v4",
      p_record_id: id(12),
    });
    const twice = await api.request(`/inbound-messages/${message.id}/file`, post({}));
    expect(twice.status).toBe(422);
    await expectContract(twice, "inboundMessages.file");
    const discarded = await api.request(
      `/inbound-messages/${id(11)}/discard`,
      post({ reason: "Spam." }),
    );
    await expectContract(discarded, "inboundMessages.discard");
  });
});
