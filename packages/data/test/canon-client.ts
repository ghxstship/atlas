import { fakeClient, type Response } from "./fake-client";

/** The shared fake with `schema()` for canon reads, which resolve under the same queue keys. */
export function canonClient(queues: Record<string, Response[]>) {
  const fake = fakeClient(queues);
  const db = fake.db as unknown as Record<string, unknown>;
  db["schema"] = () => fake.db;
  return fake;
}
