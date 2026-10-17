import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Notifications for external parties (migration 1131, finding A38-002): what Gateway shows the
 * signed-in person (their notifications, read through row level security) and their own Email
 * and Push choice per category (app.person_notification_preferences). Members keep their per-org
 * preferences in Atlas.
 */

/** Categories an external party is notified under, in display order. */
export const PARTY_CATEGORIES = ["finance"] as const;
export type PartyCategory = (typeof PARTY_CATEGORIES)[number];

/** Outside channels an external party chooses; In App always shows. */
export const PARTY_CHANNELS = ["Email", "Push"] as const;
export type PartyChannel = (typeof PARTY_CHANNELS)[number];

export interface PartyNotification {
  readonly id: string;
  readonly kind: string;
  readonly createdAt: string;
  readonly read: boolean;
  /** Display values for the kind's catalog message (title, orgName, projectName, gatewayPath). */
  readonly args: Readonly<Record<string, string>>;
}

function stringArgs(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof value !== "object" || value === null) return out;
  for (const [key, v] of Object.entries(value)) {
    if (typeof v === "string" || typeof v === "number") out[key] = String(v);
  }
  return out;
}

/** The signed-in person's latest notifications, newest first. */
export async function listMyNotifications(
  db: XosClient,
  limit = 5,
): Promise<Result<PartyNotification[]>> {
  const { data, error } = await db
    .from("notifications")
    .select("id, kind, created_at, read_at, message_args, archived_at")
    .is("archived_at", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((row) => ({
      id: row.id,
      kind: row.kind,
      createdAt: row.created_at,
      read: row.read_at !== null,
      args: stringArgs(row.message_args),
    })),
  );
}

export interface PartyPreference {
  readonly category: PartyCategory;
  readonly channel: PartyChannel;
  readonly enabled: boolean;
}

/** Channel defaults when a person states no preference (private.channel_defaults). */
const DEFAULT_ON: Readonly<Record<PartyChannel, boolean>> = { Email: true, Push: true };

/** Every party category and channel with the person's choice, or the default. */
export async function listMyNotificationPreferences(
  db: XosClient,
): Promise<Result<PartyPreference[]>> {
  const { data, error } = await db
    .from("person_notification_preferences")
    .select("category_code, channel, enabled")
    .is("deleted_at", null);
  if (error) return fail(toDataError(error));
  const rows = data ?? [];
  return ok(
    PARTY_CATEGORIES.flatMap((category) =>
      PARTY_CHANNELS.map((channel) => ({
        category,
        channel,
        enabled:
          rows.find((r) => r.category_code === category && r.channel === channel)?.enabled ??
          DEFAULT_ON[channel],
      })),
    ),
  );
}

/** Records one choice for the signed-in person: updates the live row, or adds one. */
export async function setMyNotificationPreference(
  db: XosClient,
  input: { personId: string; category: PartyCategory; channel: PartyChannel; enabled: boolean },
): Promise<Result<null>> {
  const updated = await db
    .from("person_notification_preferences")
    .update({ enabled: input.enabled })
    .eq("person_id", input.personId)
    .eq("category_code", input.category)
    .eq("channel", input.channel)
    .is("deleted_at", null)
    .select("id");
  if (updated.error) return fail(toDataError(updated.error));
  if ((updated.data ?? []).length > 0) return ok(null);
  const inserted = await db.from("person_notification_preferences").insert({
    person_id: input.personId,
    category_code: input.category,
    channel: input.channel,
    enabled: input.enabled,
  });
  return inserted.error ? fail(toDataError(inserted.error)) : ok(null);
}
