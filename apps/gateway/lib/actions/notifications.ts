"use server";

import {
  PARTY_CATEGORIES,
  PARTY_CHANNELS,
  setMyNotificationPreference,
  setMyQuietHours,
} from "@xos/data/party-notifications";
import { revalidatePath } from "next/cache";
import { requireNode } from "@/lib/shell/sitemap";

/** What the notification preferences form shows after a save. */
export interface PreferencesState {
  readonly saved?: number;
  /** A `gateway.settings.notifications.errors.*` key. */
  readonly error?: string;
}

/**
 * Saves the signed-in person's Email and Push choice for every party category (migration 1131).
 * A checkbox left unchecked turns the channel off. Each person writes only their own rows.
 */
export async function saveNotificationPreferencesAction(
  prev: PreferencesState,
  form: FormData,
): Promise<PreferencesState> {
  const ctx = await requireNode("settings.notifications");
  for (const category of PARTY_CATEGORIES) {
    for (const channel of PARTY_CHANNELS) {
      const result = await setMyNotificationPreference(ctx.db, {
        personId: ctx.personId,
        category,
        channel,
        enabled: form.get(`${category}.${channel}`) === "on",
      });
      if (!result.ok) {
        if (result.error.kind === "unexpected")
          console.error("notification preference", result.error);
        return { error: result.error.kind === "unexpected" ? "unexpected" : "denied" };
      }
    }
  }
  revalidatePath("/settings/notifications");
  return { saved: (prev.saved ?? 0) + 1 };
}

/** What the quiet hours form shows after a save. */
export interface QuietHoursState {
  readonly saved?: number;
  /** A `gateway.settings.quietHours.errors.*` key. */
  readonly error?: string;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Saves the signed-in person's own quiet hours (migration 1461): pushes from orgs they are not a
 * member of wait them out, except the few kinds that bypass quiet hours (ADR 0033 decision 35).
 * Leaving both times blank turns quiet hours off. The zone is required and never assumed to be UTC.
 */
export async function saveQuietHoursAction(
  prev: QuietHoursState,
  form: FormData,
): Promise<QuietHoursState> {
  const ctx = await requireNode("settings.notifications");
  const timeZone = String(form.get("timeZone") ?? "").trim();
  const start = String(form.get("start") ?? "").trim();
  const end = String(form.get("end") ?? "").trim();
  if (!timeZone) return { error: "zone" };
  if ((start === "") !== (end === "")) return { error: "pair" };
  if (start && (!TIME.test(start) || !TIME.test(end))) return { error: "time" };
  if (start && start === end) return { error: "same" };
  const result = await setMyQuietHours(ctx.db, {
    timeZone,
    start: start || null,
    end: end || null,
  });
  if (!result.ok) {
    if (result.error.kind === "refusal" && result.error.rule === "time_zone_unknown")
      return { error: "zone" };
    if (result.error.kind === "unexpected") console.error("quiet hours", result.error);
    return { error: result.error.kind === "unexpected" ? "unexpected" : "denied" };
  }
  revalidatePath("/settings/notifications");
  return { saved: (prev.saved ?? 0) + 1 };
}
