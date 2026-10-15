/**
 * A30's Settings and Identity handlers against a recording stand-in for supabase-js: each
 * `from(table)` or `rpc(name)` call takes the next queued response, and the recorded steps show
 * what reached the database.
 */
import { describe, expect, it } from "vitest";
import type { XosClient } from "@xos/data";
import { handlers as identity } from "../src/handlers/identity.ts";
import { handlers as settings } from "../src/handlers/settings.ts";
import { ApiProblem } from "../src/problem.ts";
import type { RequestContext } from "../src/runtime/context.ts";

type Response = { data: unknown; error: { code: string; message: string } | null };
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
  return { db: db as unknown as XosClient, calls };
}

const ORG = "0192f1e2-7c3a-7b4d-9e8f-000000000001";
const ME = "0192f1e2-7c3a-7b4d-9e8f-0000000000aa";

function context(db: XosClient, org: boolean = true): RequestContext {
  return {
    user: { id: "u1", email: null },
    personId: ME,
    org: org ? { id: ORG, slug: "demo" } : null,
    locale: "en-US",
    db,
    credential: "session",
    requestId: "req-1",
  };
}

// The handler table is typed per operation; tests call through an erased signature.
type Erased = (
  request: unknown,
  context: RequestContext,
) => Promise<{ status: number; body: unknown; headers?: Record<string, string> }>;
const call = (set: { handlers: Record<string, unknown> }, op: string) => set.handlers[op] as Erased;
const req = (r: Record<string, unknown> = {}) => ({ params: {}, query: {}, body: undefined, ...r });
const ok = (data: unknown): Response => ({ data, error: null });
const fail = (code = "XR001"): Response => ({ data: null, error: { code, message: "refused" } });

const valueRow = {
  id: "v1",
  org_id: ORG,
  created_at: "2026-10-01",
  created_by: null,
  updated_at: "2026-10-01",
  updated_by: ME,
  setting_key: "locale.time_zone",
  scope_kind: "Organization",
  scope_id: ORG,
  value_text: "America/New_York",
  value_boolean: null,
  value_integer: null,
  locked: true,
};

describe("settings handlers", () => {
  it("lists definitions with their scope and overridability", async () => {
    const { db } = fakeDb({
      "from:setting_definitions": [
        ok([
          {
            setting_key: "a.b",
            value_type: "Choice",
            capability_code: "org.general.write",
            allows_organization: true,
            allows_workspace: true,
            allows_team: false,
            allows_project: false,
            allows_personal: false,
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
        fail("08000"),
      ],
    });
    const result = await call(settings, "settingDefinitions.list")(
      req({ query: { limit: 1 } }),
      context(db),
    );
    const page = result.body as {
      data: { scope: string; overridable: boolean; value_type: string }[];
      next_cursor: string | null;
    };
    expect(page.data[0]).toMatchObject({
      scope: "Organization",
      overridable: true,
      value_type: "choice",
    });
    expect(page.next_cursor).not.toBeNull();
    await expect(
      call(settings, "settingDefinitions.list")(
        req({ query: { cursor: page.next_cursor } }),
        context(db),
      ),
    ).rejects.toMatchObject({ code: "08000" });
  });

  it("lists, reads, creates, updates and deletes values", async () => {
    const { db, calls } = fakeDb({
      "from:setting_values": [
        ok([valueRow]),
        ok(valueRow),
        ok(valueRow),
        ok(valueRow),
        ok(valueRow),
        ok(valueRow),
        ok(null),
      ],
      "rpc:set_setting": [ok("v1"), ok("v1")],
      "rpc:clear_setting": [ok(true)],
    });
    const list = await call(settings, "settingValues.list")(req({ query: {} }), context(db));
    expect((list.body as { data: unknown[] }).data[0]).toMatchObject({
      scope_type: "Organization",
      scope_id: null,
      value: "America/New_York",
      created_by: "",
    });
    expect(
      (await call(settings, "settingValues.get")(req({ params: { id: "v1" } }), context(db)))
        .status,
    ).toBe(200);
    const made = await call(settings, "settingValues.create")(
      req({ body: { scope_type: "Organization", setting_key: "locale.time_zone", value: "UTC" } }),
      context(db),
    );
    expect(made.status).toBe(201);
    expect(calls.find((c) => c.target === "rpc:set_setting")?.steps[0]?.[1]).toEqual([
      expect.objectContaining({
        p_scope_kind: "Organization",
        p_scope_id: ORG,
        p_value_text: "UTC",
      }),
    ]);
    const updated = await call(settings, "settingValues.update")(
      req({ params: { id: "v1" }, body: { value: true } }),
      context(db),
    );
    expect(updated.status).toBe(200);
    expect(
      (await call(settings, "settingValues.delete")(req({ params: { id: "v1" } }), context(db)))
        .status,
    ).toBe(204);
    await expect(
      call(settings, "settingValues.get")(req({ params: { id: "v9" } }), context(db)),
    ).rejects.toBeInstanceOf(ApiProblem);
  });

  it("refuses personal scopes, missing scope ids, fractions and a missing org", async () => {
    const { db } = fakeDb({ "from:setting_values": [ok(valueRow)] });
    await expect(
      call(settings, "settingValues.create")(
        req({ body: { scope_type: "Personal", setting_key: "me.theme", value: "dark" } }),
        context(db),
      ),
    ).rejects.toMatchObject({ body: { status: 422 } });
    await expect(
      call(settings, "settingValues.create")(
        req({ body: { scope_type: "Workspace", setting_key: "a", value: 1 } }),
        context(db),
      ),
    ).rejects.toMatchObject({ body: { status: 400 } });
    await expect(
      call(settings, "settingValues.update")(
        req({ params: { id: "v1" }, body: { value: 1.5 } }),
        context(db),
      ),
    ).rejects.toMatchObject({ body: { status: 400 } });
    await expect(
      call(settings, "settingValues.list")(req({ query: {} }), context(db, false)),
    ).rejects.toMatchObject({ body: { status: 422 } });
  });

  it("leaves a value unchanged when the update names no value", async () => {
    const { db } = fakeDb({
      "from:setting_values": [ok({ ...valueRow, value_text: null, value_integer: 4 })],
    });
    const result = await call(settings, "settingValues.update")(
      req({ params: { id: "v1" }, body: {} }),
      context(db),
    );
    expect((result.body as { value: number }).value).toBe(4);
  });

  it("lists, reads, creates and removes locks", async () => {
    const unlocked = { ...valueRow, locked: false };
    const { db } = fakeDb({
      "from:setting_values": [
        ok([valueRow]),
        ok(valueRow),
        ok(unlocked),
        ok(unlocked),
        ok(valueRow),
        ok(null),
        ok(valueRow),
        ok(unlocked),
      ],
      "rpc:set_setting": [ok("v1"), ok("v1")],
    });
    expect(
      (
        (
          await call(settings, "settingLocks.list")(
            req({ query: { cursor: undefined } }),
            context(db),
          )
        ).body as { data: unknown[] }
      ).data,
    ).toHaveLength(1);
    expect(
      (await call(settings, "settingLocks.get")(req({ params: { id: "v1" } }), context(db))).status,
    ).toBe(200);
    await expect(
      call(settings, "settingLocks.get")(req({ params: { id: "v1" } }), context(db)),
    ).rejects.toMatchObject({ body: { status: 404 } });
    expect(
      (
        await call(settings, "settingLocks.create")(
          req({ body: { setting_key: "locale.time_zone" } }),
          context(db),
        )
      ).status,
    ).toBe(201);
    await expect(
      call(settings, "settingLocks.create")(
        req({ body: { setting_key: "locale.units" } }),
        context(db),
      ),
    ).rejects.toMatchObject({ body: { status: 422 } });
    expect(
      (await call(settings, "settingLocks.delete")(req({ params: { id: "v1" } }), context(db)))
        .status,
    ).toBe(204);
    await expect(
      call(settings, "settingLocks.delete")(req({ params: { id: "v1" } }), context(db)),
    ).rejects.toMatchObject({ body: { status: 404 } });
  });
});

const joinRow = {
  id: "j1",
  org_id: ORG,
  created_at: "2026-10-01",
  created_by: ME,
  updated_at: "2026-10-01",
  updated_by: null,
  person_id: ME,
  message: "Hello",
  join_request_state: "Pending",
  decided_by: null,
};
const linkRow = {
  id: "l1",
  org_id: ORG,
  created_at: "2026-10-01",
  created_by: ME,
  updated_at: "2026-10-01",
  updated_by: ME,
  expires_at: "2026-10-30",
  max_uses: 25,
  revoked_at: null,
  role: { code: "viewer", band: 7 },
};

describe("identity handlers: joining", () => {
  it("handles join requests", async () => {
    const { db, calls } = fakeDb({
      "from:join_requests": [
        ok([joinRow]),
        ok(joinRow),
        ok(joinRow),
        ok({ ...joinRow, join_request_state: "Approved" }),
        ok({ ...joinRow, join_request_state: "Declined" }),
        ok(null),
      ],
      "rpc:request_to_join": [ok("j1")],
      "from:roles": [ok({ id: "r-member" })],
      "rpc:decide_join_request": [ok("m1"), ok(null)],
    });
    expect(
      (
        (
          await call(identity, "joinRequests.list")(
            req({ query: { cursor: undefined } }),
            context(db),
          )
        ).body as { data: unknown[] }
      ).data,
    ).toHaveLength(1);
    expect(
      (await call(identity, "joinRequests.get")(req({ params: { id: "j1" } }), context(db))).status,
    ).toBe(200);
    expect(
      (
        await call(identity, "joinRequests.create")(
          req({ body: { person_id: ME, message: "Hello" } }),
          context(db),
        )
      ).status,
    ).toBe(201);
    await expect(
      call(identity, "joinRequests.create")(
        req({ body: { person_id: "someone-else" } }),
        context(db),
      ),
    ).rejects.toMatchObject({ body: { status: 422 } });
    const approved = await call(identity, "joinRequests.approve")(
      req({ params: { id: "j1" } }),
      context(db),
    );
    expect((approved.body as { join_request_state: string }).join_request_state).toBe("Approved");
    expect(calls.find((c) => c.target === "rpc:decide_join_request")?.steps[0]?.[1]).toEqual([
      { p_join_request_id: "j1", p_approve: true, p_role_id: "r-member" },
    ]);
    expect(
      (await call(identity, "joinRequests.decline")(req({ params: { id: "j1" } }), context(db)))
        .status,
    ).toBe(200);
    await expect(
      call(identity, "joinRequests.get")(req({ params: { id: "j9" } }), context(db)),
    ).rejects.toMatchObject({ body: { status: 404 } });
  });

  it("handles invitation links and returns the token once in a header", async () => {
    const { db } = fakeDb({
      "from:invite_links": [
        ok([linkRow, { ...linkRow, id: "l2", role: null }]),
        ok(linkRow),
        ok(linkRow),
        ok({ ...linkRow, revoked_at: "2026-10-02" }),
        ok(null),
      ],
      "from:roles": [ok({ id: "r-viewer" }), ok(null)],
      "rpc:create_invite_link": [ok({ invite_link_id: "l1", invite_token: "xlnk_secret" })],
      "rpc:revoke_invite_link": [ok(null)],
    });
    const list = await call(identity, "invitationLinks.list")(req({ query: {} }), context(db));
    expect((list.body as { data: { role: string | null }[] }).data.map((l) => l.role)).toEqual([
      "Viewer",
      null,
    ]);
    expect(
      (await call(identity, "invitationLinks.get")(req({ params: { id: "l1" } }), context(db)))
        .status,
    ).toBe(200);
    const made = await call(identity, "invitationLinks.create")(
      req({
        body: { role: "Viewer", expires_at: new Date(Date.now() + 48 * 3_600_000).toISOString() },
      }),
      context(db),
    );
    expect(made.headers?.["X-Invitation-Token"]).toBe("xlnk_secret");
    await expect(
      call(identity, "invitationLinks.create")(
        req({ body: { role: null, expires_at: "2026-10-30" } }),
        context(db),
      ),
    ).rejects.toMatchObject({ body: { status: 400 } });
    await expect(
      call(identity, "invitationLinks.create")(
        req({ body: { role: "Viewer", expires_at: "soon" } }),
        context(db),
      ),
    ).rejects.toMatchObject({ body: { status: 400 } });
    expect(
      (
        (await call(identity, "invitationLinks.revoke")(req({ params: { id: "l1" } }), context(db)))
          .body as { revoked_at: string }
      ).revoked_at,
    ).toBe("2026-10-02");
    await expect(
      call(identity, "invitationLinks.get")(req({ params: { id: "l9" } }), context(db)),
    ).rejects.toMatchObject({ body: { status: 404 } });
  });

  it("refuses an unknown role", async () => {
    const { db } = fakeDb({ "from:roles": [ok(null)] });
    await expect(
      call(identity, "invitationLinks.create")(
        req({
          body: {
            role: "Viewer",
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            max_uses: 3,
          },
        }),
        context(db),
      ),
    ).rejects.toMatchObject({ body: { status: 400 } });
  });
});

const personRow = {
  id: "pp1",
  created_at: "2026-10-01",
  updated_at: "2026-10-01",
  person_id: ME,
  headline: "Rigger",
  bio: null,
  pronouns: null,
  city: "Miami",
  country_code: "US",
  visibility: "Network",
  search_indexing: false,
};
const orgProfileRow = {
  id: "op1",
  created_at: "2026-10-01",
  updated_at: "2026-10-01",
  org_id: ORG,
  about: null,
  visibility: "Public",
  search_indexing: false,
};
const offRow = {
  id: "f1",
  org_id: ORG,
  created_at: "2026-10-01",
  created_by: null,
  updated_at: "2026-10-01",
  updated_by: null,
  membership_id: "m1",
  completed_at: null,
};

describe("identity handlers: profiles and offboarding", () => {
  it("handles person profiles", async () => {
    const { db } = fakeDb({
      "from:person_profiles": [
        ok([personRow]),
        ok(personRow),
        ok(personRow),
        ok(personRow),
        ok(null),
        ok({ ...personRow, headline: "Lead" }),
        ok(null),
      ],
      "rpc:ensure_my_profile": [ok("pp1")],
    });
    const list = await call(identity, "personProfiles.list")(req({ query: {} }), context(db));
    expect((list.body as { data: { locality: string }[] }).data[0]?.locality).toBe("Miami");
    expect(
      (await call(identity, "personProfiles.get")(req({ params: { id: "pp1" } }), context(db)))
        .status,
    ).toBe(200);
    expect(
      (await call(identity, "personProfiles.create")(req({ body: {} }), context(db))).status,
    ).toBe(201);
    const updated = await call(identity, "personProfiles.update")(
      req({
        params: { id: "pp1" },
        body: {
          headline: "Lead",
          bio: null,
          pronouns: "she/her",
          locality: "Miami",
          country: "US",
          visibility: "Public",
          search_indexing: true,
        },
      }),
      context(db),
    );
    expect((updated.body as { headline: string }).headline).toBe("Lead");
    await expect(
      call(identity, "personProfiles.get")(req({ params: { id: "pp9" } }), context(db)),
    ).rejects.toMatchObject({ body: { status: 404 } });
  });

  it("handles organization profiles", async () => {
    const { db } = fakeDb({
      "from:organization_profiles": [
        ok([orgProfileRow]),
        ok(orgProfileRow),
        ok(orgProfileRow),
        ok(orgProfileRow),
        ok([{ id: "op1" }]),
        ok(orgProfileRow),
        ok(orgProfileRow),
        ok([]),
        ok(null),
      ],
      "rpc:ensure_organization_profile": [ok("op1")],
    });
    expect(
      (
        (await call(identity, "organizationProfiles.list")(req({ query: {} }), context(db)))
          .body as { data: { organization_id: string }[] }
      ).data[0]?.organization_id,
    ).toBe(ORG);
    expect(
      (
        await call(identity, "organizationProfiles.get")(
          req({ params: { id: "op1" } }),
          context(db),
        )
      ).status,
    ).toBe(200);
    expect(
      (await call(identity, "organizationProfiles.create")(req({ body: {} }), context(db))).status,
    ).toBe(201);
    expect(
      (
        await call(identity, "organizationProfiles.update")(
          req({
            params: { id: "op1" },
            body: { about: "About", visibility: "Network", search_indexing: false },
          }),
          context(db),
        )
      ).status,
    ).toBe(200);
    await expect(
      call(identity, "organizationProfiles.update")(
        req({ params: { id: "op1" }, body: {} }),
        context(db),
      ),
    ).rejects.toMatchObject({ body: { status: 404 } });
    await expect(
      call(identity, "organizationProfiles.get")(req({ params: { id: "op9" } }), context(db)),
    ).rejects.toMatchObject({ body: { status: 404 } });
  });

  it("handles offboarding checklists", async () => {
    const { db, calls } = fakeDb({
      "from:offboardings": [
        ok([offRow]),
        ok([]),
        ok(offRow),
        ok(offRow),
        ok(offRow),
        ok(offRow),
        ok(offRow),
        ok(null),
      ],
      "from:offboarding_open_records": [
        ok([{ offboarding_id: "f1" }, { offboarding_id: "f1" }, { offboarding_id: null }]),
        ok([]),
        ok([]),
        ok([]),
      ],
      "rpc:reassign_offboarding_records": [ok(2)],
    });
    const list = await call(identity, "offboardingChecklists.list")(
      req({ query: {} }),
      context(db),
    );
    expect(
      (list.body as { data: { open_record_count: number }[] }).data[0]?.open_record_count,
    ).toBe(2);
    expect(
      (
        (await call(identity, "offboardingChecklists.list")(req({ query: {} }), context(db)))
          .body as { data: unknown[] }
      ).data,
    ).toEqual([]);
    expect(
      (
        await call(identity, "offboardingChecklists.get")(
          req({ params: { id: "f1" } }),
          context(db),
        )
      ).status,
    ).toBe(200);
    const updated = await call(identity, "offboardingChecklists.update")(
      req({ params: { id: "f1" }, body: { reassign_to_person_id: "p2" } }),
      context(db),
    );
    expect((updated.body as { reassign_to_person_id: string }).reassign_to_person_id).toBe("p2");
    expect(calls.some((c) => c.target === "rpc:reassign_offboarding_records")).toBe(true);
    expect(
      (
        await call(identity, "offboardingChecklists.update")(
          req({ params: { id: "f1" }, body: {} }),
          context(db),
        )
      ).status,
    ).toBe(200);
    await expect(
      call(identity, "offboardingChecklists.get")(req({ params: { id: "f9" } }), context(db)),
    ).rejects.toMatchObject({ body: { status: 404 } });
  });
});
