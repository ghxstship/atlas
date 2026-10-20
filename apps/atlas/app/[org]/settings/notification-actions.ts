"use server";

import {
  DIGEST_FREQUENCIES,
  NOTIFICATION_MATRIX_CHANNELS,
  saveMyNotificationPreferences,
  saveMyNotificationSettings,
  recordMySmsConsent,
  saveOrgNotificationDefaults,
  type DigestFrequency,
  type MatrixChannel,
  type NotificationChoice,
} from "@xos/data/notification-settings";
import type { DataError } from "@xos/data/result";
import { NOTIFICATION_CATEGORIES } from "@xos/schemas/notifications";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { getOrgContext } from "@/lib/shell/context";

/**
 * Notification settings actions (A80, migration 1362): the member's matrix, quiet hours and digest on
 * Personal settings, Notifications, and the org's defaults and mandatory categories on Settings,
 * Notifications. The 1362 RPCs decide every write: a locked channel cannot be turned off and org
 * defaults need org.notifications.write. Refusals come back as `settings.notifications.errors.*` keys.
 */

export interface NotificationFormState {
  readonly error?: string;
  readonly fieldErrors?: Readonly<Record<string, string>>;
  readonly ok?: boolean;
}

const CATEGORY_CODES = new Set(NOTIFICATION_CATEGORIES.map((c) => c.code));
const KNOWN_RULES = new Set([
  "notification_category_mandatory",
  "time_zone_unknown",
  "sms_phone_unverified",
]);

function errorKey(error: DataError): string {
  if (error.kind === "refusal") return KNOWN_RULES.has(error.rule) ? error.rule : "unexpected";
  if (error.kind === "not-found") return "denied";
  if (error.kind === "invalid") return "invalid";
  return "unexpected";
}

async function contextFor(form: FormData) {
  const slug = form.get("org");
  const ctx = typeof slug === "string" ? await getOrgContext(slug) : null;
  if (!ctx) notFound();
  return ctx;
}

/** The form field of one matrix cell. */
function cellName(prefix: string, category: string, channel: MatrixChannel): string {
  return `${prefix}.${category}.${channel}`;
}

function every<T>(fn: (category: string, channel: MatrixChannel) => T | null): T[] {
  return NOTIFICATION_CATEGORIES.flatMap((c) =>
    NOTIFICATION_MATRIX_CHANNELS.flatMap((ch) => {
      const value = fn(c.code, ch);
      return value === null ? [] : [value];
    }),
  );
}

const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

function time(form: FormData, name: string): string | null | undefined {
  const value = form.get(name);
  if (typeof value !== "string" || value.trim() === "") return null;
  return TIME.test(value.trim()) ? value.trim() : undefined;
}

/**
 * Saves Personal settings, Notifications: the cells the member changed (unchanged cells keep following
 * the org default), then quiet hours, the time zone they are read in, the digest, and consent to texts.
 */
export async function saveMyNotificationsAction(
  _: NotificationFormState,
  form: FormData,
): Promise<NotificationFormState> {
  const ctx = await contextFor(form);
  const changed: NotificationChoice[] = every((category, channel) => {
    const was = form.get(cellName("was", category, channel));
    if (was !== "on" && was !== "off") return null;
    const now = form.get(cellName("cell", category, channel)) === "on";
    return now === (was === "on") ? null : { category, channel, enabled: now };
  });

  const timeZone = String(form.get("timeZone") ?? "");
  const start = time(form, "quietStart");
  const end = time(form, "quietEnd");
  const digest = String(form.get("digestFrequency") ?? "") as DigestFrequency;
  const hour = Number(form.get("digestHour"));
  const fieldErrors: Record<string, string> = {};
  if (!Intl.supportedValuesOf("timeZone").includes(timeZone) && timeZone !== "UTC")
    fieldErrors["timeZone"] = "invalid";
  if (start === undefined) fieldErrors["quietStart"] = "invalid";
  if (end === undefined) fieldErrors["quietEnd"] = "invalid";
  if (start !== undefined && end !== undefined && (start === null) !== (end === null))
    fieldErrors[start === null ? "quietStart" : "quietEnd"] = "quietPair";
  if (start && end && start === end) fieldErrors["quietEnd"] = "quietSame";
  if (!DIGEST_FREQUENCIES.includes(digest)) fieldErrors["digestFrequency"] = "invalid";
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) fieldErrors["digestHour"] = "invalid";
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };

  if (changed.length > 0) {
    const saved = await saveMyNotificationPreferences(ctx.viewer.db, ctx.org.id, changed);
    if (!saved.ok) return { error: errorKey(saved.error) };
  }
  const settings = await saveMyNotificationSettings(ctx.viewer.db, ctx.org.id, {
    timeZone,
    quietHoursStart: start ?? null,
    quietHoursEnd: end ?? null,
    digestFrequency: digest,
    digestHour: hour,
  });
  if (!settings.ok) return { error: errorKey(settings.error) };
  // Express consent to texts (TCPA): recorded only when the person changed the box.
  const consentWas = form.get("smsConsentWas");
  const consent = form.get("smsConsent") === "on";
  if ((consentWas === "on" || consentWas === "off") && consent !== (consentWas === "on")) {
    const recorded = await recordMySmsConsent(ctx.viewer.db, ctx.org.id, consent);
    if (!recorded.ok) return { error: errorKey(recorded.error) };
  }
  revalidatePath(`/${ctx.org.slug}/me/notifications`);
  return { ok: true };
}

/** Saves Settings, Notifications: every cell of the org's default matrix and its mandatory categories. */
export async function saveOrgNotificationDefaultsAction(
  _: NotificationFormState,
  form: FormData,
): Promise<NotificationFormState> {
  const ctx = await contextFor(form);
  const defaults: NotificationChoice[] = every((category, channel) => ({
    category,
    channel,
    enabled: form.get(cellName("default", category, channel)) === "on",
  }));
  const mandatory = form
    .getAll("mandatory")
    .filter((v): v is string => typeof v === "string" && CATEGORY_CODES.has(v));
  const saved = await saveOrgNotificationDefaults(ctx.viewer.db, ctx.org.id, {
    defaults,
    mandatory,
  });
  if (!saved.ok) return { error: errorKey(saved.error) };
  revalidatePath(`/${ctx.org.slug}/settings/notifications`);
  return { ok: true };
}
