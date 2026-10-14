import type { SupabaseClient } from "@supabase/supabase-js";
import type { Mutation } from "@xos/sync";
import { describe, expect, it } from "vitest";
import { outcomeFromResult, SupabaseUploader } from "../src/data/uploader";

type Reply = {
  data: unknown;
  error: { code?: string; message: string; details?: string } | null;
  status: number;
};

/** A recording stand-in for the Supabase query builder: each terminal call takes the next scripted reply. */
function fakeClient(replies: Reply[]) {
  const calls: string[] = [];
  const next = () => Promise.resolve(replies.shift() ?? { data: null, error: null, status: 200 });
  const builder = (table: string) => {
    const chain = {
      insert: (row: unknown) => (calls.push(`insert ${table} ${JSON.stringify(row)}`), chain),
      update: (row: unknown) => (calls.push(`update ${table} ${JSON.stringify(row)}`), chain),
      select: () => chain,
      eq: (col: string, value: unknown) => (calls.push(`eq ${col}=${String(value)}`), chain),
      maybeSingle: next,
    };
    return chain;
  };
  const client = {
    from: builder,
    rpc: (name: string, args: unknown) => (
      calls.push(`rpc ${name} ${JSON.stringify(args)}`),
      next()
    ),
  } as unknown as SupabaseClient;
  return { client, calls };
}

function mutation(over: Partial<Mutation>): Mutation {
  return {
    id: "mut-1",
    seq: 1,
    op: "insert",
    target: "incidents",
    table: "incidents",
    rowId: "row-1",
    payload: { id: "row-1", title: "Fall" },
    base: null,
    policy: "append",
    dependsOn: [],
    queuedAt: "",
    attempts: 0,
    nextAttemptAt: 0,
    status: "pending",
    lastError: null,
    serverRow: null,
    ...over,
  };
}

const base = { functionsUrl: "https://x.example.com", accessToken: () => Promise.resolve("token") };

describe("uploader", () => {
  it("inserts and returns the server row", async () => {
    const { client, calls } = fakeClient([
      { data: { id: "row-1", incident_number: 7 }, error: null, status: 201 },
    ]);
    const outcome = await new SupabaseUploader({ client, ...base }).upload(mutation({}));
    expect(outcome).toEqual({ kind: "applied", serverRow: { id: "row-1", incident_number: 7 } });
    expect(calls[0]).toBe('insert incidents {"id":"row-1","title":"Fall"}');
  });

  it("treats a replayed insert as a duplicate", async () => {
    const { client } = fakeClient([
      {
        data: null,
        error: {
          code: "23505",
          message: 'duplicate key value violates unique constraint "incidents_pkey"',
        },
        status: 409,
      },
    ]);
    expect(await new SupabaseUploader({ client, ...base }).upload(mutation({}))).toEqual({
      kind: "duplicate",
    });
  });

  it("guards an update on the base's updated_at and reports stale with the server row", async () => {
    const { client, calls } = fakeClient([
      { data: null, error: null, status: 200 },
      { data: { id: "row-1", note: "theirs", updated_at: "t2" }, error: null, status: 200 },
    ]);
    const m = mutation({
      op: "update",
      payload: { note: "mine" },
      policy: "merge",
      base: { id: "row-1", note: "", updated_at: "t1" },
    });
    expect(await new SupabaseUploader({ client, ...base }).upload(m)).toEqual({
      kind: "stale",
      serverRow: { id: "row-1", note: "theirs", updated_at: "t2" },
    });
    expect(calls).toContain("eq updated_at=t1");
  });

  it("refuses an update whose row is gone and applies a successful one", async () => {
    const gone = fakeClient([
      { data: null, error: null, status: 200 },
      { data: null, error: null, status: 200 },
    ]);
    const m = mutation({ op: "update", payload: { note: "x" }, policy: "guarded" });
    expect((await new SupabaseUploader({ client: gone.client, ...base }).upload(m)).kind).toBe(
      "refused",
    );
    const okay = fakeClient([
      { data: { id: "row-1", called_at: "now" }, error: null, status: 200 },
    ]);
    const call = mutation({
      op: "update",
      target: "cues",
      table: "cues",
      payload: { called_at: "now" },
      base: { id: "row-1", updated_at: "t1" },
    });
    expect(await new SupabaseUploader({ client: okay.client, ...base }).upload(call)).toEqual({
      kind: "applied",
      serverRow: { id: "row-1", called_at: "now" },
    });
    expect(okay.calls).not.toContain("eq updated_at=t1");
  });

  it("sends record_punch with the mutation id for the replay ledger", async () => {
    const { client, calls } = fakeClient([{ data: { id: "p1" }, error: null, status: 200 }]);
    const m = mutation({
      op: "rpc",
      target: "record_punch",
      table: "clock_punches",
      payload: { id: "p1", punch_kind: "In", device_needs_review: false },
    });
    expect(await new SupabaseUploader({ client, ...base }).upload(m)).toEqual({
      kind: "applied",
      serverRow: { id: "p1" },
    });
    expect(calls[0]).toBe(
      'rpc record_punch {"p_punch":{"id":"p1","punch_kind":"In"},"p_mutation_id":"mut-1"}',
    );
  });

  it("turns a compare-and-set refusal into a stale outcome with the current row", async () => {
    const { client } = fakeClient([
      {
        data: null,
        error: { code: "XR001", message: "transition_stale: the incident moved" },
        status: 400,
      },
      { data: { id: "row-1", incident_state: "Dispatched" }, error: null, status: 200 },
    ]);
    const m = mutation({
      op: "rpc",
      target: "transition_incident",
      policy: "cas",
      payload: { p_incident_id: "row-1" },
    });
    expect(await new SupabaseUploader({ client, ...base }).upload(m)).toMatchObject({
      kind: "stale",
      serverRow: { incident_state: "Dispatched" },
    });
  });

  it("passes other RPC refusals through and ignores non-row results", async () => {
    const refused = fakeClient([
      { data: null, error: { code: "42501", message: "denied" }, status: 403 },
    ]);
    expect(
      (
        await new SupabaseUploader({ client: refused.client, ...base }).upload(
          mutation({ op: "rpc", target: "close_incident" }),
        )
      ).kind,
    ).toBe("refused");
    const scalar = fakeClient([{ data: "uuid-value", error: null, status: 200 }]);
    expect(
      await new SupabaseUploader({ client: scalar.client, ...base }).upload(
        mutation({ op: "rpc", target: "transition_incident" }),
      ),
    ).toEqual({ kind: "applied", serverRow: null });
  });

  it("uses a module route when one is registered", async () => {
    const { client } = fakeClient([]);
    const uploader = new SupabaseUploader({
      client,
      ...base,
      routes: { apply_asset_scan_event: () => Promise.resolve({ kind: "duplicate" }) },
    });
    expect(
      await uploader.upload(mutation({ op: "rpc", target: "apply_asset_scan_event" })),
    ).toEqual({ kind: "duplicate" });
  });

  it("posts kiosk punches to the Edge Function and maps its answers", async () => {
    const { client } = fakeClient([]);
    const seen: string[] = [];
    const reply =
      (status: number, body: unknown, headers: Record<string, string> = {}) =>
      (url: string | URL | Request, init?: RequestInit) => {
        seen.push(
          `${String(url)} ${String((init?.headers as Record<string, string>)["authorization"])}`,
        );
        return Promise.resolve(new Response(JSON.stringify(body), { status, headers }));
      };
    const m = mutation({
      op: "rpc",
      target: "kiosk-punch",
      table: "kiosk_punches",
      payload: { pin: "1234" },
    });
    const ok = new SupabaseUploader({
      client,
      ...base,
      fetchImpl: reply(200, { time_entry_id: "t" }),
    });
    expect(await ok.upload(m)).toEqual({ kind: "applied", serverRow: null });
    expect(seen[0]).toBe("https://x.example.com/functions/v1/kiosk-punch Bearer token");
    const refused = new SupabaseUploader({
      client,
      ...base,
      fetchImpl: reply(422, { refusal: "REFUSE", reason: "kiosk_pin_invalid" }),
    });
    expect(await refused.upload(m)).toEqual({
      kind: "refused",
      error: { code: "kiosk_pin_invalid", message: "kiosk_pin_invalid" },
    });
    const limited = new SupabaseUploader({
      client,
      ...base,
      fetchImpl: reply(429, { title: "Slow down" }, { "retry-after": "20" }),
    });
    expect(await limited.upload(m)).toEqual({
      kind: "transient",
      error: { code: "429", message: "Slow down" },
      retryAfterMs: 20_000,
    });
    const offline = new SupabaseUploader({
      client,
      ...base,
      fetchImpl: () => Promise.reject(new TypeError("Network request failed")),
    });
    expect((await offline.upload(m)).kind).toBe("transient");
  });
});

describe("module results", () => {
  it("maps the @xos/data Result contract to upload outcomes", () => {
    expect(outcomeFromResult({ ok: true, data: { id: "s1" } }, (d) => d)).toEqual({
      kind: "applied",
      serverRow: { id: "s1" },
    });
    expect(outcomeFromResult({ ok: true, data: 1 })).toEqual({ kind: "applied", serverRow: null });
    expect(
      outcomeFromResult({
        ok: false,
        error: {
          kind: "refusal",
          rule: "asset_scan_unavailable",
          message: "Damaged units cannot go out.",
        },
      }),
    ).toEqual({
      kind: "refused",
      error: { code: "asset_scan_unavailable", message: "Damaged units cannot go out." },
    });
    expect(outcomeFromResult({ ok: false, error: { kind: "not-found" } }).kind).toBe("refused");
    expect(outcomeFromResult({ ok: false, error: { kind: "invalid", message: "bad" } })).toEqual({
      kind: "refused",
      error: { code: "invalid", message: "bad" },
    });
    expect(
      outcomeFromResult({ ok: false, error: { kind: "unexpected", message: "fetch failed" } }).kind,
    ).toBe("transient");
    expect(
      outcomeFromResult({
        ok: false,
        error: { kind: "unexpected", message: "jwt", code: "PGRST301" },
      }).kind,
    ).toBe("unauthorized");
  });
});
