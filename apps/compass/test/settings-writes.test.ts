import type { SupabaseClient } from "@supabase/supabase-js";
import { MemoryStore, Outbox, type Mutation, type Row } from "@xos/sync";
import { describe, expect, it } from "vitest";
import { SupabaseUploader } from "../src/data/uploader";
import {
  DEFAULT_ORG_ROW,
  defaultOrgWrite,
  isLive,
  listInsert,
  listRemove,
  MIRROR,
  mirrorRows,
  personUpdate,
  profileUpdate,
  refusalRule,
  sectionVisibilityWrite,
  writeStateOf,
} from "../src/settings/writes";

/**
 * The identity settings writes that queue offline (A110, ADR 0070): each an ordinary insert or update of the
 * person's own row, laid on the device copy at once, and sent by the uploader like any other queued write.
 */

const profile: Row = {
  id: "prof-1",
  person_id: "person-1",
  handle: "ana-ruiz",
  headline: "Lead rigger",
  updated_at: "2026-10-20T10:00:00Z",
};
const newId = () => "row-new";

describe("queued identity writes", () => {
  it("updates the profile with the changed columns, merged with edits made elsewhere", () => {
    expect(profileUpdate(profile, { headline: "Head rigger" })).toEqual({
      op: "update",
      target: "person_profiles",
      table: "_me_profile",
      rowId: "prof-1",
      payload: { headline: "Head rigger" },
      policy: "merge",
      optimistic: { ...profile, headline: "Head rigger" },
    });
  });

  it("updates the person's name on app.people", () => {
    const person: Row = { id: "person-1", full_name: "Ana Ruiz", updated_at: "t1" };
    const input = personUpdate(person, { given_name: "Ana", family_name: "Ruiz" });
    expect(input).toMatchObject({
      op: "update",
      target: "people",
      table: MIRROR.person,
      rowId: "person-1",
      payload: { given_name: "Ana", family_name: "Ruiz" },
      policy: "merge",
    });
  });

  it("adds a list row with its own id, so a retry is the same row, and removes one softly", () => {
    const added = listInsert(
      "links",
      "person-1",
      { label: "Site", url: "https://a.example" },
      1,
      newId,
    );
    expect(added).toEqual({
      op: "insert",
      target: "person_links",
      table: "_me_person_links",
      rowId: "row-new",
      payload: { id: "row-new", person_id: "person-1", label: "Site", url: "https://a.example" },
      policy: "append",
      optimistic: {
        id: "row-new",
        person_id: "person-1",
        label: "Site",
        url: "https://a.example",
        deleted_at: null,
      },
    });
    const removed = listRemove(
      "skills",
      { id: "s1", cat_urid: "0101.01.02" },
      "2026-10-24T00:00:00Z",
    );
    expect(removed).toMatchObject({
      op: "update",
      target: "person_skills",
      table: "_me_person_skills",
      rowId: "s1",
      payload: { deleted_at: "2026-10-24T00:00:00Z" },
    });
    expect(isLive(removed.optimistic as Row)).toBe(false);
    expect(isLive({ id: "x", deleted_at: null })).toBe(true);
    expect(isLive({ id: "x" })).toBe(true);
  });

  it("sets a section's visibility: insert, change, clear, or nothing when it already holds", () => {
    const at = Date.parse("2026-10-24T00:00:00Z");
    expect(
      sectionVisibilityWrite("person-1", "rates", "Private", undefined, at, newId),
    ).toMatchObject({
      op: "insert",
      target: "profile_section_visibility",
      table: "_me_profile_section_visibility",
      payload: { id: "row-new", person_id: "person-1", section: "rates", visibility: "Private" },
    });
    const existing: Row = { id: "v1", section: "rates", visibility: "Private", deleted_at: null };
    expect(sectionVisibilityWrite("person-1", "rates", "Network", existing, at)).toMatchObject({
      op: "update",
      rowId: "v1",
      payload: { visibility: "Network" },
      policy: "merge",
    });
    expect(sectionVisibilityWrite("person-1", "rates", "inherit", existing, at)).toMatchObject({
      op: "update",
      rowId: "v1",
      payload: { deleted_at: "2026-10-24T00:00:00.000Z" },
    });
    expect(sectionVisibilityWrite("person-1", "rates", "Private", existing, at)).toBeNull();
    expect(sectionVisibilityWrite("person-1", "rates", "inherit", undefined, at)).toBeNull();
    // A cleared entry is no entry: choosing again inserts a new one.
    const cleared = { ...existing, deleted_at: "2026-10-01T00:00:00Z" };
    expect(sectionVisibilityWrite("person-1", "rates", "Public", cleared, at, newId)?.op).toBe(
      "insert",
    );
  });

  it("records the default org with app.set_active_org, idempotent, so it queues as a plain RPC", () => {
    expect(defaultOrgWrite("org-2", "2026-10-24T00:00:00Z")).toEqual({
      op: "rpc",
      target: "set_active_org",
      table: "_me_default_org",
      rowId: DEFAULT_ORG_ROW,
      payload: { p_org_id: "org-2" },
      policy: "append",
      optimistic: { id: DEFAULT_ORG_ROW, org_id: "org-2", selected_at: "2026-10-24T00:00:00Z" },
    });
  });

  it("lays the change on the device copy in the same transaction as the outbox entry", async () => {
    const store = new MemoryStore();
    await store.transaction((tx) => tx.put(MIRROR.profile, profile));
    const outbox = new Outbox(store);
    const queued = await outbox.enqueue(profileUpdate(profile, { headline: "Head rigger" }));
    expect((await store.get(MIRROR.profile, "prof-1"))?.["headline"]).toBe("Head rigger");
    expect(queued.base).toEqual(profile);
    expect(queued.target).toBe("person_profiles");
  });
});

describe("the uploader sends them like any queued write", () => {
  function fakeClient(reply: { data: unknown; error: { code: string; message: string } | null }) {
    const calls: string[] = [];
    const chain = (table: string) => {
      const c = {
        insert: (row: unknown) => (calls.push(`insert ${table} ${JSON.stringify(row)}`), c),
        update: (row: unknown) => (calls.push(`update ${table} ${JSON.stringify(row)}`), c),
        select: () => c,
        eq: (col: string, value: unknown) => (calls.push(`eq ${col}=${String(value)}`), c),
        maybeSingle: () => Promise.resolve({ ...reply, status: reply.error ? 400 : 200 }),
      };
      return c;
    };
    const client = {
      from: chain,
      rpc: (name: string, args: unknown) => {
        calls.push(`rpc ${name} ${JSON.stringify(args)}`);
        return Promise.resolve({ ...reply, status: 200 });
      },
    } as unknown as SupabaseClient;
    return { client, calls };
  }
  const options = {
    functionsUrl: "https://x.example.test",
    accessToken: () => Promise.resolve("token"),
    orgId: () => "org-1",
    deviceId: "device-1",
    clock: { wallNow: () => 0, monotonicNow: () => 0, bootId: () => "boot-1" },
  };
  const asMutation = (input: ReturnType<typeof profileUpdate>, base: Row | null): Mutation => ({
    id: "m1",
    seq: 1,
    op: input.op,
    target: input.target ?? input.table,
    table: input.table,
    rowId: input.rowId,
    payload: { ...input.payload, device_org_id: "org-1" },
    base,
    policy: input.policy ?? "merge",
    dependsOn: [],
    queuedAt: "",
    attempts: 0,
    nextAttemptAt: 0,
    status: "pending",
    lastError: null,
    serverRow: null,
  });

  it("updates person_profiles by id, guarded on the row the person edited", async () => {
    const saved = { ...profile, headline: "Head rigger", updated_at: "2026-10-24T00:00:00Z" };
    const { client, calls } = fakeClient({ data: saved, error: null });
    const outcome = await new SupabaseUploader({ client, ...options }).upload(
      asMutation(profileUpdate(profile, { headline: "Head rigger" }), profile),
    );
    expect(outcome).toEqual({ kind: "applied", serverRow: saved });
    expect(calls).toEqual([
      'update person_profiles {"headline":"Head rigger"}',
      "eq id=prof-1",
      "eq updated_at=2026-10-20T10:00:00Z",
    ]);
  });

  it("calls set_active_org directly, never through the replay ledger", async () => {
    const { client, calls } = fakeClient({ data: null, error: null });
    await new SupabaseUploader({ client, ...options }).upload(
      asMutation(defaultOrgWrite("org-2", "t"), null),
    );
    expect(calls).toEqual(['rpc set_active_org {"p_org_id":"org-2"}']);
  });
});

describe("where a saved change stands", () => {
  const pending = { status: "pending", lastError: null } as unknown as Mutation;
  it("is saved once it leaves the outbox, and sending or queued while it waits", () => {
    expect(writeStateOf(undefined, true)).toEqual({ kind: "saved" });
    expect(writeStateOf(pending, true)).toEqual({ kind: "sending" });
    expect(writeStateOf(pending, false)).toEqual({ kind: "queued" });
  });

  it("names the rule of a refusal, and a unique value already in use as a conflict", () => {
    const refused = {
      status: "conflict",
      lastError: { code: "XR001", message: "handle_taken: ana is held by a recent handle change." },
    } as unknown as Mutation;
    expect(writeStateOf(refused, true)).toEqual({
      kind: "refused",
      rule: "handle_taken",
      code: "XR001",
      message: "handle_taken: ana is held by a recent handle change.",
    });
    expect(refusalRule({ code: "23505", message: "duplicate key value" })).toBe("conflict");
    expect(refusalRule({ code: "42501", message: "permission denied" })).toBeNull();
  });
});

describe("a fresh read of the device copy", () => {
  it("takes the server's rows and keeps the rows a queued write still owns", () => {
    const server: Row[] = [
      { id: "a", label: "server a" },
      { id: "b", label: "server b" },
    ];
    const device: Row[] = [
      { id: "b", label: "mine b" },
      { id: "c", label: "new c" },
      { id: "d", label: "gone d" },
    ];
    const queued = [
      { table: MIRROR.links, rowId: "b" },
      { table: MIRROR.links, rowId: "c" },
      { table: MIRROR.skills, rowId: "d" },
    ];
    expect(mirrorRows(MIRROR.links, server, device, queued)).toEqual([
      { id: "a", label: "server a" },
      { id: "b", label: "mine b" },
      { id: "c", label: "new c" },
    ]);
  });

  it("keeps every device copy local: scope changes never purge it and sign-out wipes it", () => {
    for (const table of Object.values(MIRROR)) expect(table.startsWith("_")).toBe(true);
  });
});
