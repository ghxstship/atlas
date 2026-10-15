import type { Mutation, Row, UploadOutcome, Uploader } from "../src";

/** Deterministic ids: 0001, 0002 ... in UUIDv7 shape order. */
export function sequentialIds(): (ms: number) => string {
  let n = 0;
  return () => {
    n += 1;
    return `01920000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
  };
}

export class Clock {
  constructor(public ms = Date.UTC(2026, 9, 14, 12, 0, 0)) {}
  now = (): number => this.ms;
  advance(ms: number): void {
    this.ms += ms;
  }
}

type Behavior =
  "apply" | "drop-response" | "network-down" | "refuse" | "stale" | "unauthorized" | "rate-limit";

/**
 * An in-process server: tables keyed by id, an RPC replay ledger keyed by mutation id, and scripted
 * behaviors per upload so tests can cut the network mid-flight.
 */
export class FakeServer implements Uploader {
  readonly tables = new Map<string, Map<string, Row>>();
  readonly ledger = new Map<string, Row | null>();
  readonly received: Mutation[] = [];
  readonly script: Behavior[] = [];
  refuseWhen: ((m: Mutation) => boolean) | null = null;

  row(table: string, id: string): Row | undefined {
    return this.tables.get(table)?.get(id);
  }

  seed(table: string, row: Row): void {
    let rows = this.tables.get(table);
    if (!rows) {
      rows = new Map();
      this.tables.set(table, rows);
    }
    rows.set(row.id, row);
  }

  upload(mutation: Mutation): Promise<UploadOutcome> {
    this.received.push(mutation);
    const behavior = this.script.shift() ?? "apply";
    if (behavior === "network-down") return Promise.reject(new TypeError("Network request failed"));
    if (behavior === "unauthorized") {
      return Promise.resolve({
        kind: "unauthorized",
        error: { code: "401", message: "JWT expired" },
      });
    }
    if (behavior === "rate-limit") {
      return Promise.resolve({
        kind: "transient",
        error: { code: "429", message: "Too many requests" },
        retryAfterMs: 30_000,
      });
    }
    if (behavior === "refuse" || this.refuseWhen?.(mutation)) {
      return Promise.resolve({
        kind: "refused",
        error: { code: "XR001", message: "punch_already_in" },
        serverRow: this.row(mutation.table, mutation.rowId) ?? null,
      });
    }
    const outcome = this.#apply(mutation, behavior === "stale");
    if (behavior === "drop-response")
      return Promise.reject(new TypeError("Network request failed"));
    return Promise.resolve(outcome);
  }

  #apply(mutation: Mutation, forceStale: boolean): UploadOutcome {
    if (this.ledger.has(mutation.id))
      return { kind: "duplicate", serverRow: this.ledger.get(mutation.id) ?? null };
    const current = this.row(mutation.table, mutation.rowId);
    if (mutation.op === "insert") {
      if (current) return { kind: "duplicate", serverRow: current };
      const row = { ...mutation.payload, id: mutation.rowId } as Row;
      this.seed(mutation.table, row);
      this.ledger.set(mutation.id, row);
      return { kind: "applied", serverRow: row };
    }
    if (mutation.op === "update") {
      const base = mutation.base;
      const changed =
        forceStale ||
        (current !== undefined && base !== null && current["version"] !== base["version"]);
      if (changed) return { kind: "stale", serverRow: current ?? null };
      const version = typeof current?.["version"] === "number" ? current["version"] + 1 : 1;
      const row = { ...(current ?? {}), ...mutation.payload, id: mutation.rowId, version } as Row;
      this.seed(mutation.table, row);
      this.ledger.set(mutation.id, row);
      return { kind: "applied", serverRow: row };
    }
    const expected = mutation.payload["expected"];
    if (forceStale || (current && expected !== undefined && current["state"] !== expected)) {
      return {
        kind: "stale",
        serverRow: current ?? null,
        error: { code: "XR001", message: "transition_stale" },
      };
    }
    const row = { ...(current ?? { id: mutation.rowId }), state: mutation.payload["next"] } as Row;
    this.seed(mutation.table, row);
    this.ledger.set(mutation.id, row);
    return { kind: "applied", serverRow: row };
  }
}
