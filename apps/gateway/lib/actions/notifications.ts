"use server";

import {
  PARTY_CATEGORIES,
  PARTY_CHANNELS,
  setMyNotificationPreference,
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
