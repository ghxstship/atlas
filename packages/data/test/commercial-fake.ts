import type { XosClient } from "../src/client";
import { fakeClient, type Response } from "./fake-client";

/**
 * The recording client of fake-client.ts with `schema(name)` for canon reads: `schema("xpms")`
 * routes `from(table)` to the queue key `xpms:<table>`. Also lets one key answer many calls with
 * the same response (`repeat`), for reads issued in parallel.
 */
export function commercialClient(queues: Record<string, Response[]>) {
  const { db, calls } = fakeClient(queues);
  const base = db as unknown as {
    from(table: string): unknown;
    rpc(name: string, args: unknown): unknown;
  };
  const client = {
    from: (table: string) => base.from(table),
    rpc: (name: string, args: unknown) => base.rpc(name, args),
    schema: (name: string) => ({ from: (table: string) => base.from(`${name}:${table}`) }),
  };
  return { db: client as unknown as XosClient, calls };
}

export { errorResponse, okResponse } from "./fake-client";
