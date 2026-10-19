/**
 * Contract tests for A30's Settings and Identity handlers (Section 18, gate 5). Requests run through
 * `contractApp`, and every response is checked against openapi/v1.json with `expectContract`. The
 * database is a recording stand-in for supabase-js: each `from(table)` or `rpc(name)` call takes
 * the next queued response, and the recorded steps show what reached the database.
 */
import { describe, expect, it } from "vitest";
import { handlers as identity } from "../src/handlers/identity.ts";
import { handlers as settings } from "../src/handlers/settings.ts";
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
  const db = {
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
  return { db, calls };
}

const ctx = testContext();
const ORG = ctx.org?.id as string;
const ME = ctx.personId as string;
const OTHER = "0192f1e2-7c3a-7b4d-9e8f-00000000000b";
const T = "2026-10-01T12:00:00.000Z";
const id = (n: number) => `0192f1e2-7c3a-7b4d-9e8f-${String(n).padStart(12, "0")}`;
const ok = (data: unknown): Response => ({ data, error: null });
const refusal = (rule: string): Response => ({
  data: null,
  error: { code: "XR001", message: `${rule}: Refused.`, hint: rule },
});

const POST = {
  method: "POST",
  headers: { "Idempotency-Key": "a30-contract-key", "Content-Type": "application/json" },
};
const PATCH = { method: "PATCH", headers: { "If-Match": "*", "Content-Type": "application/json" } };
const post = (body: unknown, key = "a30-contract-key") => ({
  ...POST,
  headers: { ...POST.headers, "Idempotency-Key": key },
  body: JSON.stringify(body),
});
const patch = (body: unknown) => ({ ...PATCH, body: JSON.stringify(body) });

function app(queues: Record<string, Response[]>, context = {}) {
  const fake = fakeDb(queues);
  return {
    api: contractApp({ handlers: [settings, identity], db: fake.db, context }),
    calls: fake.calls,
  };
}

const valueRow = {
  id: id(1),
  org_id: ORG,
  created_at: T,
  created_by: ME,
  updated_at: T,
  updated_by: ME,
  setting_key: "locale.time_zone",
  scope_kind: "Organization",
  scope_id: ORG,
  value_text: "America/New_York",
  value_boolean: null,
  value_integer: null,
  locked: true,
};

describe("Settings contract", () => {
  it("lists setting definitions", async () => {
    const { api } = app({
      "from:setting_definitions": [
        ok([
          {
            setting_key: "locale.time_zone",
            value_type: "Text",
            capability_code: "org.localization.write",
            allows_organization: true,
            allows_workspace: true,
            allows_team: false,
            allows_project: true,
            allows_personal: true,
          },
          {
            setting_key: "me.theme",
            value_type: "Choice",
            capability_code: "me.preferences.write",
            allows_organization: false,
            allows_workspace: false,
            allows_team: false,
            allows_project: false,
            allows_personal: true,
          },
        ]),
      ],
    });
    const r1 = await api.request("/setting-definitions?limit=1");
    const page = (await expectContract(r1, "settingDefinitions.list")) as {
      data: { scope: string; overridable: boolean }[];
      next_cursor: string | null;
    };
    expect(page.data[0]).toMatchObject({ scope: "Organization", overridable: true });
    expect(page.next_cursor).not.toBeNull();
  });

  it("lists, reads, creates, updates and deletes setting values", async () => {
    const { api, calls } = app({
      "from:setting_values": [
        ok([valueRow]),
        ok(valueRow),
        ok(valueRow),
        ok(valueRow),
        ok(valueRow),
        ok(valueRow),
        ok(null),
      ],
      "rpc:set_setting": [ok(id(1)), ok(id(1))],
      "rpc:clear_setting": [ok(true)],
    });
    const r2 = await api.request("/setting-values");
    const page = (await expectContract(r2, "settingValues.list")) as {
      data: { scope_id: string | null }[];
    };
    expect(page.data[0]?.scope_id).toBeNull();
    const r3 = await api.request(`/setting-values/${id(1)}`);
    await expectContract(r3, "settingValues.get");
    const r4 = await api.request(
      "/setting-values",
      post({ scope_type: "Organization", setting_key: "locale.time_zone", value: "UTC" }),
    );
    await expectContract(r4, "settingValues.create");
    expect(calls.find((c) => c.target === "rpc:set_setting")?.steps[0]?.[1]).toEqual([
      expect.objectContaining({
        p_scope_kind: "Organization",
        p_scope_id: ORG,
        p_value_text: "UTC",
      }),
    ]);
    const r5 = await api.request(`/setting-values/${id(1)}`, patch({ value: "Europe/Madrid" }));
    await expectContract(r5, "settingValues.update");
    const r6 = await api.request(`/setting-values/${id(1)}`, { method: "DELETE" });
    await expectContract(r6, "settingValues.delete");
    const r7 = await api.request(`/setting-values/${id(9)}`);
    await expectContract(r7, "settingValues.get");
  });

  it("refuses personal scopes and database refusals as 422", async () => {
    const { api } = app({ "rpc:set_setting": [refusal("setting_locked")] });
    const r8 = await api.request(
      "/setting-values",
      post({ scope_type: "Personal", setting_key: "me.theme", value: "dark" }),
    );
    await expectContract(r8, "settingValues.create");
    const refused = await api.request(
      "/setting-values",
      post(
        { scope_type: "Organization", setting_key: "locale.time_zone", value: "UTC" },
        "a30-contract-key-2",
      ),
    );
    expect(refused.status).toBe(422);
    await expectContract(refused, "settingValues.create");
  });

  it("lists, reads, creates and removes setting locks", async () => {
    const unlocked = { ...valueRow, locked: false };
    const { api } = app({
      "from:setting_values": [
        ok([valueRow]),
        ok(valueRow),
        ok(unlocked),
        ok(valueRow),
        ok(valueRow),
        ok(null),
      ],
      "rpc:set_setting": [ok(id(1)), ok(id(1))],
    });
    const r9 = await api.request("/setting-locks");
    await expectContract(r9, "settingLocks.list");
    const r10 = await api.request(`/setting-locks/${id(1)}`);
    await expectContract(r10, "settingLocks.get");
    const r11 = await api.request("/setting-locks", post({ setting_key: "locale.time_zone" }));
    await expectContract(r11, "settingLocks.create");
    const r12 = await api.request(`/setting-locks/${id(1)}`, { method: "DELETE" });
    await expectContract(r12, "settingLocks.delete");
    const missing = await api.request(
      "/setting-locks",
      post({ setting_key: "locale.units" }, "a30-contract-key-3"),
    );
    expect(missing.status).toBe(422);
  });
});

const joinRow = {
  id: id(10),
  org_id: ORG,
  created_at: T,
  created_by: ME,
  updated_at: T,
  updated_by: ME,
  person_id: ME,
  message: "I run a staging crew.",
  join_request_state: "Pending",
  decided_by: null,
};
const linkRow = {
  id: id(20),
  org_id: ORG,
  created_at: T,
  created_by: ME,
  updated_at: T,
  updated_by: ME,
  expires_at: "2026-10-30T12:00:00.000Z",
  max_uses: 25,
  revoked_at: null,
  role: { code: "viewer", band: 7 },
};

describe("Identity contract: joining", () => {
  it("lists, reads, creates, approves and declines join requests", async () => {
    const { api, calls } = app({
      "from:join_requests": [
        ok([joinRow]),
        ok(joinRow),
        ok(joinRow),
        ok({ ...joinRow, join_request_state: "Approved", decided_by: OTHER }),
        ok({ ...joinRow, join_request_state: "Declined", decided_by: OTHER }),
      ],
      "rpc:request_to_join": [ok(id(10))],
      "from:roles": [ok({ id: id(30) })],
      "rpc:decide_join_request": [ok(id(31)), ok(null)],
    });
    const r13 = await api.request("/join-requests");
    await expectContract(r13, "joinRequests.list");
    const r14 = await api.request(`/join-requests/${id(10)}`);
    await expectContract(r14, "joinRequests.get");
    const r15 = await api.request(
      "/join-requests",
      post({ person_id: ME, message: "I run a staging crew." }),
    );
    await expectContract(r15, "joinRequests.create");
    const r16 = await api.request(`/join-requests/${id(10)}/approve`, post({}, "a30-approve-key"));
    const approved = (await expectContract(r16, "joinRequests.approve")) as {
      join_request_state: string;
    };
    expect(approved.join_request_state).toBe("Approved");
    expect(calls.find((c) => c.target === "rpc:decide_join_request")?.steps[0]?.[1]).toEqual([
      { p_join_request_id: id(10), p_approve: true, p_role_id: id(30) },
    ]);
    const r17 = await api.request(`/join-requests/${id(10)}/decline`, post({}, "a30-decline-key"));
    await expectContract(r17, "joinRequests.decline");
  });

  it("refuses a request made for someone else", async () => {
    const { api } = app({});
    const res = await api.request("/join-requests", post({ person_id: OTHER }));
    expect(res.status).toBe(422);
    await expectContract(res, "joinRequests.create");
  });

  it("lists, reads, creates and revokes invitation links, with the token once in a header", async () => {
    const { api } = app({
      "from:invite_links": [
        ok([linkRow]),
        ok(linkRow),
        ok(linkRow),
        ok({ ...linkRow, revoked_at: T }),
      ],
      "from:roles": [ok({ id: id(32) })],
      "rpc:create_invite_link": [ok({ invite_link_id: id(20), invite_token: "xlnk_secret" })],
      "rpc:revoke_invite_link": [ok(null)],
    });
    const r18 = await api.request("/invitation-links");
    const page = (await expectContract(r18, "invitationLinks.list")) as {
      data: { role: string }[];
    };
    expect(page.data[0]?.role).toBe("Viewer");
    const r19 = await api.request(`/invitation-links/${id(20)}`);
    await expectContract(r19, "invitationLinks.get");
    const made = await api.request(
      "/invitation-links",
      post({
        role: "Viewer",
        expires_at: new Date(Date.now() + 48 * 3_600_000).toISOString(),
        max_uses: 25,
      }),
    );
    expect(made.headers.get("X-Invitation-Token")).toBe("xlnk_secret");
    await expectContract(made, "invitationLinks.create");
    const r20 = await api.request(`/invitation-links/${id(20)}/revoke`, post({}, "a30-revoke-key"));
    await expectContract(r20, "invitationLinks.revoke");
  });
});

const personRow = {
  id: id(40),
  created_at: T,
  updated_at: T,
  person_id: ME,
  handle: "alex-rivera",
  handle_changed_at: null,
  headline: "Rigger, arena tours",
  bio: null,
  pronouns: null,
  city: "Miami",
  country_code: "US",
  visibility: "Network",
  search_indexing: false,
};
const orgProfileRow = {
  id: id(50),
  created_at: T,
  updated_at: T,
  org_id: ORG,
  handle: "northwind-live",
  handle_changed_at: null,
  about: null,
  visibility: "Public",
  search_indexing: false,
};
const offRow = {
  id: id(60),
  org_id: ORG,
  created_at: T,
  created_by: ME,
  updated_at: T,
  updated_by: ME,
  membership_id: id(61),
  completed_at: null,
};

describe("Identity contract: profiles and offboarding", () => {
  it("lists, reads, creates and updates person profiles", async () => {
    const { api } = app({
      "from:person_profiles": [
        ok([personRow]),
        ok(personRow),
        ok(null),
        ok(personRow),
        ok(personRow),
        ok(null),
        ok({ ...personRow, headline: "Head rigger", handle: "alex-rigs", handle_changed_at: T }),
      ],
      "rpc:ensure_my_profile": [ok(id(40))],
    });
    const r21 = await api.request("/person-profiles");
    const page = (await expectContract(r21, "personProfiles.list")) as {
      data: { locality: string }[];
    };
    expect(page.data[0]?.locality).toBe("Miami");
    const r22 = await api.request(`/person-profiles/${id(40)}`);
    await expectContract(r22, "personProfiles.get");
    const r23 = await api.request(
      "/person-profiles",
      post({
        person_id: ME,
        headline: "Rigger, arena tours",
        visibility: "Network",
        search_indexing: false,
      }),
    );
    await expectContract(r23, "personProfiles.create");
    const r24 = await api.request(
      `/person-profiles/${id(40)}`,
      patch({ handle: "alex-rigs", headline: "Head rigger", locality: "Miami", country: "US" }),
    );
    const changed = (await expectContract(r24, "personProfiles.update")) as {
      handle: string;
      handle_changed_at: string | null;
    };
    expect(changed).toMatchObject({ handle: "alex-rigs", handle_changed_at: T });
  });

  it("refuses a profile for someone else, and a stale If-Match", async () => {
    const { api } = app({ "from:person_profiles": [ok(personRow)] });
    const res = await api.request(
      "/person-profiles",
      post({ person_id: OTHER, visibility: "Private", search_indexing: false }),
    );
    expect(res.status).toBe(422);
    await expectContract(res, "personProfiles.create");
    const stale = await api.request(`/person-profiles/${id(40)}`, {
      ...patch({ headline: "x" }),
      headers: { ...PATCH.headers, "If-Match": 'W/"MjAyNS0wMS0wMQ"' },
    });
    expect(stale.status).toBe(412);
    await expectContract(stale, "personProfiles.update");
  });

  it("lists, reads, creates and updates organization profiles", async () => {
    const { api } = app({
      "from:organization_profiles": [
        ok([orgProfileRow]),
        ok(orgProfileRow),
        ok(null),
        ok(orgProfileRow),
        ok(orgProfileRow),
        ok([{ id: id(50) }]),
        ok({ ...orgProfileRow, about: "Touring production." }),
      ],
      "rpc:ensure_organization_profile": [ok(id(50))],
    });
    const r25 = await api.request("/organization-profiles");
    await expectContract(r25, "organizationProfiles.list");
    const r26 = await api.request(`/organization-profiles/${id(50)}`);
    await expectContract(r26, "organizationProfiles.get");
    const r27 = await api.request(
      "/organization-profiles",
      post({ organization_id: ORG, visibility: "Public", search_indexing: false }),
    );
    await expectContract(r27, "organizationProfiles.create");
    const r28 = await api.request(
      `/organization-profiles/${id(50)}`,
      patch({ about: "Touring production." }),
    );
    await expectContract(r28, "organizationProfiles.update");
  });

  it("lists, reads and updates offboarding checklists", async () => {
    const { api, calls } = app({
      "from:offboardings": [ok([offRow]), ok(offRow), ok(offRow), ok(offRow)],
      "from:offboarding_open_records": [
        ok([{ offboarding_id: id(60) }, { offboarding_id: id(60) }]),
        ok([{ offboarding_id: id(60) }]),
        ok([{ offboarding_id: id(60) }]),
        ok([]),
      ],
      "rpc:reassign_offboarding_records": [ok(1)],
    });
    const r29 = await api.request("/offboarding-checklists");
    const page = (await expectContract(r29, "offboardingChecklists.list")) as {
      data: { open_record_count: number }[];
    };
    expect(page.data[0]?.open_record_count).toBe(2);
    const r30 = await api.request(`/offboarding-checklists/${id(60)}`);
    await expectContract(r30, "offboardingChecklists.get");
    const r31 = await api.request(
      `/offboarding-checklists/${id(60)}`,
      patch({ reassign_to_person_id: OTHER }),
    );
    const updated = (await expectContract(r31, "offboardingChecklists.update")) as {
      open_record_count: number;
      reassign_to_person_id: string;
    };
    expect(updated).toMatchObject({ open_record_count: 0, reassign_to_person_id: OTHER });
    expect(calls.some((c) => c.target === "rpc:reassign_offboarding_records")).toBe(true);
  });
});
