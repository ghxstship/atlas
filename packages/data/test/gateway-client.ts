import { fakeClient, type Response } from "./fake-client.ts";

/** The shared recording client, with `schema(name)` routing view reads to `from:<schema>.<view>`. */
export function gatewayClient(queues: Record<string, Response[]>) {
  const fake = fakeClient(queues);
  const from = (fake.db as unknown as { from(t: string): unknown }).from;
  (fake.db as unknown as Record<string, unknown>)["schema"] = (name: string) => ({
    from: (view: string) => from(`${name}.${view}`),
  });
  return fake;
}
