import type { XosClient } from "../src/client";
import type { Call, Response } from "./fake-client";

/**
 * The recording stand-in of fake-client.ts with `schema(name)` as well, for the module
 * repositories that read canon from xpms. Keys are `from:<table>`, `rpc:<name>` and
 * `<schema>:from:<table>` for another schema.
 */
export function moduleClient(queues: Record<string, Response[]>) {
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
  const scoped = (prefix: string) => ({
    from(table: string) {
      const call: Call = { target: `${prefix}from:${table}`, steps: [] };
      calls.push(call);
      return builder(call.target, call.steps);
    },
  });
  const client = {
    ...scoped(""),
    schema(name: string) {
      return scoped(`${name}:`);
    },
    rpc(name: string, args: unknown) {
      const call: Call = { target: `rpc:${name}`, steps: [["args", [args]]] };
      calls.push(call);
      return builder(`rpc:${name}`, call.steps);
    },
  };
  return { db: client as unknown as XosClient, calls };
}

/** The steps a call recorded for one builder method. */
export function stepsOf(call: Call | undefined, method: string): unknown[][] {
  return (call?.steps ?? []).filter(([m]) => m === method).map(([, args]) => args);
}
