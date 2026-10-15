import type { XosClient } from "../src/client.ts";

/**
 * A recording stand-in for the Supabase client. Each `from(table)` or `rpc(name)` call takes the next
 * queued response for that key; builder methods are recorded and return the builder, which resolves
 * to the response when awaited, like the real PostgREST builder.
 */
export interface Response {
  data: unknown;
  error: { code?: string; message: string; hint?: string | null } | null;
}

export interface Call {
  readonly target: string;
  readonly steps: [string, unknown[]][];
}

export function fakeClient(queues: Record<string, Response[]>) {
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
        get(_target, prop: string) {
          if (prop === "then") {
            return (resolve: (r: Response) => unknown) => resolve(response);
          }
          return (...args: unknown[]) => {
            steps.push([prop, args]);
            return proxy;
          };
        },
      },
    );
    return proxy;
  };
  const client = {
    from(table: string) {
      const call: Call = { target: `from:${table}`, steps: [] };
      calls.push(call);
      return builder(`from:${table}`, call.steps);
    },
    rpc(name: string, args: unknown) {
      const call: Call = { target: `rpc:${name}`, steps: [["args", [args]]] };
      calls.push(call);
      return builder(`rpc:${name}`, call.steps);
    },
  };
  return { db: client as unknown as XosClient, calls };
}

export const okResponse = (data: unknown): Response => ({ data, error: null });
export const errorResponse = (code: string, message: string, hint?: string): Response => ({
  data: null,
  error: { code, message, hint: hint ?? null },
});
