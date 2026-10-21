import type { XosClient } from "@xos/data/client";
import { describe, expect, it } from "vitest";
import { NO_ORG } from "../lib/settings";
import type { GatewayContext } from "../lib/shell/context";
import { getPersonTimeZone } from "../lib/time-zone";

// Pages that list a person's items across orgs follow the person's own locale.time_zone, never the UTC
// clock, which is a day ahead every evening in the Americas (RRR-116).
function ctxWith(reply: { data?: unknown; error?: { code: string; message: string } }) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const db = {
    rpc: (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return Promise.resolve({ data: reply.data ?? null, error: reply.error ?? null });
    },
  } as unknown as XosClient;
  return { ctx: { db } as unknown as GatewayContext, calls };
}

const setting = (value: string | null) => ({
  setting_key: "locale.time_zone",
  value_text: value,
  value_boolean: null,
  value_integer: null,
  source: "Personal",
  locked: false,
});

describe("the person's own calendar", () => {
  it("reads the personal locale.time_zone, resolved without an org", async () => {
    const { ctx, calls } = ctxWith({ data: [setting("America/Los_Angeles")] });
    expect(await getPersonTimeZone(ctx)).toBe("America/Los_Angeles");
    expect(calls).toEqual([{ fn: "resolve_settings", args: { p_org_id: NO_ORG } }]);
  });

  it("falls back to UTC for an unset or unknown zone, and when settings fail to load", async () => {
    expect(await getPersonTimeZone(ctxWith({ data: [setting(null)] }).ctx)).toBe("UTC");
    expect(await getPersonTimeZone(ctxWith({ data: [setting("Mars/Olympus")] }).ctx)).toBe("UTC");
    expect(
      await getPersonTimeZone(ctxWith({ error: { code: "42501", message: "denied" } }).ctx),
    ).toBe("UTC");
  });
});
