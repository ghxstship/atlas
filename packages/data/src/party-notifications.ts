import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Notifications for external parties (migration 1131, finding A38-002): what Gateway shows the
 * signed-in person (their notifications, read through row level security) and their own Email
 * and Push choice per category (app.person_notification_preferences). Members keep their per-org
 * preferences in Atlas.
 */

/** Categories an external party is notified under, in display order. */
export const PARTY_CATEGORIES = ["finance", "opportunities", "expiry_reminders"] as const;
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

/** A person's own quiet hours (migration 1461), for notifications from orgs they are not a member of. */
export interface MyQuietHours {
  readonly timeZone: string;
  /** Local `HH:MM` quiet hours begin, or null for none. */
  readonly start: string | null;
  readonly end: string | null;
}

/** The signed-in person's own quiet hours, or null when they never set any. */
export async function getMyQuietHours(db: XosClient): Promise<Result<MyQuietHours | null>> {
  const { data, error } = await db
    .from("person_notification_settings")
    .select("time_zone, quiet_hours_start, quiet_hours_end")
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return ok(null);
  return ok({
    timeZone: data.time_zone,
    start: data.quiet_hours_start?.slice(0, 5) ?? null,
    end: data.quiet_hours_end?.slice(0, 5) ?? null,
  });
}

/**
 * Records the signed-in person's quiet hours and the time zone they are read in (app.set_my_quiet_hours).
 * Pushes from orgs they are not a member of wait them out, unless the kind bypasses quiet hours
 * (ADR 0033 decision 35). Both times null turns quiet hours off.
 */
export async function setMyQuietHours(db: XosClient, input: MyQuietHours): Promise<Result<null>> {
  const { error } = await db.rpc("set_my_quiet_hours", {
    p_time_zone: input.timeZone,
    ...(input.start && input.end
      ? { p_quiet_hours_start: input.start, p_quiet_hours_end: input.end }
      : {}),
  });
  return error ? fail(toDataError(error)) : ok(null);
}
