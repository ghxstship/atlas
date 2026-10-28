import { databaseEnums } from "@xos/config/database-enums";
import { describe, expect, it } from "vitest";
import type { BillingInterval } from "../src/billing/plans.ts";
import type { SmsKeywordAction } from "../src/notifications/sms.ts";
import type { WebPushDevice } from "../src/notifications/web-push.ts";
import { PUNCH_KINDS } from "../src/stores.ts";

/**
 * This package sits below @xos/data, so its lists of database enum values cannot read Constants
 * (ADR 0120). Each is held here to the same values as its enum, in any order. A Record over a union
 * type must name each member once, so its keys are the union's members.
 */
const intervals: Record<BillingInterval, true> = { Monthly: true, Annual: true };
const keywordActions: Record<SmsKeywordAction, true> = {
  "Opt Out": true,
  "Opt In": true,
  Help: true,
};
const pushApps: Record<WebPushDevice["app"], true> = { Atlas: true, Gateway: true };

const lists: readonly (readonly [string, readonly string[]])[] = [
  ["app.billing_interval", Object.keys(intervals)],
  ["app.sms_consent_action", Object.keys(keywordActions)],
  ["app.shortcut_shell", Object.keys(pushApps)],
  ["app.punch_kind", PUNCH_KINDS],
];

describe("lists that mirror a database enum", () => {
  const enums = databaseEnums();
  it.each(lists)("%s", (name, values) => {
    expect([...values].sort()).toEqual([...(enums[name] ?? [])].sort());
  });
});
