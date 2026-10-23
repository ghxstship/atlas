import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import {
  createReplicaCallerClient,
  preferReplica,
  readReplicaUrl,
  READ_REPLICA_ENV,
} from "../src/read-replica.ts";
import { supabaseReportRunStore } from "../src/report-runs.ts";

describe("readReplicaUrl", () => {
  it("is null when the variable is unset or blank, so nothing changes", () => {
    expect(readReplicaUrl({})).toBeNull();
    expect(readReplicaUrl({ [READ_REPLICA_ENV]: "  " })).toBeNull();
  });

  it("answers the origin of an http(s) URL", () => {
    expect(
      readReplicaUrl({ [READ_REPLICA_ENV]: "https://abc-rr-us-east-1-x.supabase.co/rest/v1" }),
    ).toBe("https://abc-rr-us-east-1-x.supabase.co");
  });

  it("warns and stays on the primary for anything else", () => {
    const warn = vi.fn();
    expect(readReplicaUrl({ [READ_REPLICA_ENV]: "postgres://replica:5432/db" }, warn)).toBeNull();
    expect(readReplicaUrl({ [READ_REPLICA_ENV]: "not a url" }, warn)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("preferReplica", () => {
  it("reads the primary when there is no replica", async () => {
    const read = vi.fn(async (client: string, onReplica: boolean) => `${client}:${onReplica}`);
    expect(await preferReplica("primary", null, read, { label: "x" })).toBe("primary:false");
    expect(await preferReplica("primary", undefined, read, { label: "x" })).toBe("primary:false");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("reads the replica when it answers something usable", async () => {
    const onFallback = vi.fn();
    const result = await preferReplica(
      "primary",
      "replica",
      async (client, onReplica) => ({ client, onReplica }),
      { label: "x", usable: () => true, onFallback },
    );
    expect(result).toEqual({ client: "replica", onReplica: true });
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("falls back to the primary when the replica throws or its answer is unusable", async () => {
    const onFallback = vi.fn();
    const failing = await preferReplica(
      "primary",
      "replica",
      async (client) => {
        if (client === "replica") throw new Error("read-only transaction");
        return client;
      },
      { label: "report rows", onFallback },
    );
    expect(failing).toBe("primary");
    const lagging = await preferReplica(
      "primary",
      "replica",
      async (client) => (client === "replica" ? null : "row"),
      { label: "report definition", usable: (r) => r !== null, onFallback },
    );
    expect(lagging).toBe("row");
    expect(onFallback.mock.calls.map(([label, reason]) => [label, String(reason)])).toEqual([
      ["report rows", "Error: read-only transaction"],
      ["report definition", "unusable"],
    ]);
  });
});

describe("createReplicaCallerClient", () => {
  it("is null without a replica and a caller client on the replica's origin with one", () => {
    const options = { anonKey: "anon-key-for-tests-0123456789", accessToken: "token" };
    expect(createReplicaCallerClient({}, options)).toBeNull();
    const client = createReplicaCallerClient(
      { [READ_REPLICA_ENV]: "https://replica.example.test" },
      options,
    );
    expect(client).not.toBeNull();
    expect((client as unknown as { supabaseUrl: string }).supabaseUrl).toBe(
      "https://replica.example.test",
    );
  });
});

/** A service-role client whose report_run_rows answers `answer`, recording each call. */
function rpcClient(
  answer: { data: unknown; error: { message: string } | null },
  calls: unknown[][],
): SupabaseClient {
  return {
    schema: () => ({
      rpc: async (...args: unknown[]) => {
        calls.push(args);
        return answer;
      },
    }),
  } as unknown as SupabaseClient;
}

describe("supabaseReportRunStore with a replica", () => {
  const args = { p_run_id: "run-1", p_columns: ["name"], p_limit: 10 };

  it("reads report rows from the replica as GET", async () => {
    const primaryCalls: unknown[][] = [];
    const replicaCalls: unknown[][] = [];
    const store = supabaseReportRunStore(
      rpcClient({ data: [{ name: "primary" }], error: null }, primaryCalls),
      { replica: rpcClient({ data: [{ name: "replica" }], error: null }, replicaCalls) },
    );
    expect(await store.rows("run-1", ["name"], 10)).toEqual([{ name: "replica" }]);
    expect(replicaCalls).toEqual([["report_run_rows", args, { get: true }]]);
    expect(primaryCalls).toEqual([]);
  });

  it("falls back to the primary when the replica refuses a run it does not yet see running", async () => {
    const primaryCalls: unknown[][] = [];
    const onReplicaFallback = vi.fn();
    const store = supabaseReportRunStore(
      rpcClient({ data: [{ name: "primary" }], error: null }, primaryCalls),
      {
        replica: rpcClient({ data: null, error: { message: "report_run_not_running" } }, []),
        onReplicaFallback,
      },
    );
    expect(await store.rows("run-1", ["name"], 10)).toEqual([{ name: "primary" }]);
    expect(primaryCalls).toEqual([["report_run_rows", args]]);
    expect(onReplicaFallback).toHaveBeenCalledWith("report rows", expect.any(Error));
  });

  it("keeps reading the primary exactly as before without a replica", async () => {
    const primaryCalls: unknown[][] = [];
    const store = supabaseReportRunStore(rpcClient({ data: null, error: null }, primaryCalls));
    expect(await store.rows("run-1", ["name"], 10)).toEqual([]);
    expect(primaryCalls).toEqual([["report_run_rows", args]]);
  });

  it("asks the primary for a definition the replica cannot read", async () => {
    const replica = {
      schema: () => ({
        from: () => {
          throw new Error("replica unavailable");
        },
      }),
    } as unknown as SupabaseClient;
    const primary = {
      schema: () => ({
        from: () => {
          throw new Error("primary reached");
        },
      }),
    } as unknown as SupabaseClient;
    const store = supabaseReportRunStore(primary, { replica });
    await expect(store.definition("def-1", "m-1")).rejects.toThrow(/primary reached/);
  });
});
