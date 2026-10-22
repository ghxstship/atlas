import { describe, expect, it } from "vitest";
import type { XosClient } from "../src/client.ts";
import {
  confirmSubprocessorNotices,
  getMemberNoticeSubscription,
  setMemberNoticeSubscription,
  subscribeSubprocessorNotices,
  unsubscribeSubprocessorNotices,
} from "../src/subprocessor-notices.ts";
import { fakeClient, okResponse } from "./fake-client.ts";

/** Subprocessor List change notices (A82, migration 1382). */
function publicDb(answer: unknown, error: { code: string; message: string } | null = null) {
  const calls: { schema: string; fn: string; args: unknown }[] = [];
  const db = {
    schema: (schema: string) => ({
      rpc: async (fn: string, args: unknown) => {
        calls.push({ schema, fn, args });
        return { data: answer, error };
      },
    }),
  } as unknown as XosClient;
  return { db, calls };
}

const CONFIRM = `xspn_${"a".repeat(64)}`;
const UNSUBSCRIBE = `xspu_${"b".repeat(64)}`;

describe("the public subscription", () => {
  it("subscribes through api_public with the trimmed address and language", async () => {
    const { db, calls } = publicDb(true);
    expect(await subscribeSubprocessorNotices(db, "  dana@example.test ", "es-US")).toEqual({
      ok: true,
      data: true,
    });
    expect(calls).toEqual([
      {
        schema: "api_public",
        fn: "subscribe_subprocessor_notices",
        args: { p_email: "dana@example.test", p_locale: "es-US" },
      },
    ]);
  });

  it("confirms and unsubscribes with well-formed tokens only", async () => {
    const { db, calls } = publicDb(true);
    expect(await confirmSubprocessorNotices(db, "xspn_short")).toEqual({ ok: true, data: false });
    expect(await unsubscribeSubprocessorNotices(db, CONFIRM)).toEqual({ ok: true, data: false });
    expect(calls).toEqual([]);
    expect(await confirmSubprocessorNotices(db, CONFIRM)).toEqual({ ok: true, data: true });
    expect(await unsubscribeSubprocessorNotices(db, UNSUBSCRIBE)).toEqual({ ok: true, data: true });
    expect(calls.map((c) => [c.fn, c.args])).toEqual([
      ["confirm_subprocessor_notices", { p_token: CONFIRM }],
      ["unsubscribe_subprocessor_notices", { p_token: UNSUBSCRIBE }],
    ]);
  });

  it("reports a refused call", async () => {
    const { db } = publicDb(null, { code: "25006", message: "read-only transaction" });
    expect((await confirmSubprocessorNotices(db, CONFIRM)).ok).toBe(false);
  });
});

describe("Owners and Admins", () => {
  it("reads and changes the default subscription", async () => {
    const { db, calls } = fakeClient({
      "rpc:subprocessor_notice_subscription": [okResponse([{ eligible: true, subscribed: false }])],
      "rpc:set_subprocessor_notice_subscription": [okResponse(true)],
    });
    expect(await getMemberNoticeSubscription(db)).toEqual({
      ok: true,
      data: { eligible: true, subscribed: false },
    });
    expect(await setMemberNoticeSubscription(db, true)).toEqual({ ok: true, data: true });
    expect(calls[1]?.steps[0]?.[1][0]).toEqual({ p_subscribed: true });
  });
});
