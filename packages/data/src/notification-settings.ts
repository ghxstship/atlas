import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";
import * as enums from "./enums.generated.ts";

/**
 * Notification settings of a member and of an org (Section 4.5.6: personal settings item 8 and org setting
 * item 29; migration 1362). The member's matrix comes resolved from app.my_notification_matrix: what they
 * receive per category and channel, the org default, whether the org locked it (mandatory) and whether they
 * chose it. Writes go through the 1362 RPCs, so the database refuses turning a locked channel off and
 * checks org.notifications.write for org defaults.
 */

/** Channels in matrix order (app.notification_channel). */
export const NOTIFICATION_MATRIX_CHANNELS = enums.notificationChannel;
export type MatrixChannel = (typeof NOTIFICATION_MATRIX_CHANNELS)[number];

export const DIGEST_FREQUENCIES = enums.digestFrequency;
export type DigestFrequency = (typeof DIGEST_FREQUENCIES)[number];

export interface MatrixCell {
  readonly category: string;
  readonly urgent: boolean;
  readonly channel: MatrixChannel;
  /** What the member receives now. */
  readonly enabled: boolean;
  readonly orgDefault: boolean;
  /** The org made the category mandatory and its default has the channel on. */
  readonly locked: boolean;
  /** The member chose this cell themselves. */
  readonly chosen: boolean;
}

export interface NotificationChoice {
  readonly category: string;
  readonly channel: MatrixChannel;
  readonly enabled: boolean;
}

export interface MyNotificationSettings {
  readonly timeZone: string;
  readonly quietHoursStart: string | null;
  readonly quietHoursEnd: string | null;
  readonly digestFrequency: DigestFrequency;
  readonly digestHour: number;
}

export interface OrgNotificationDefaults {
  readonly defaults: readonly NotificationChoice[];
  readonly mandatory: readonly string[];
}

function isChannel(value: unknown): value is MatrixChannel {
  return (NOTIFICATION_MATRIX_CHANNELS as readonly unknown[]).includes(value);
}

/** The signed-in member's matrix in an org, categories in display order. */
export async function getMyNotificationMatrix(
  db: XosClient,
  orgId: string,
): Promise<Result<MatrixCell[]>> {
  const { data, error } = await db.rpc("my_notification_matrix", { p_org_id: orgId });
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).flatMap((row) =>
      isChannel(row.channel)
        ? [
            {
              category: row.category_code,
              urgent: row.urgent,
              channel: row.channel,
              enabled: row.enabled,
              orgDefault: row.org_default,
              locked: row.locked,
              chosen: row.chosen,
            },
          ]
        : [],
    ),
  );
}

/** Records the member's choices; a locked channel turned off comes back as a refusal. */
export async function saveMyNotificationPreferences(
  db: XosClient,
  orgId: string,
  choices: readonly NotificationChoice[],
): Promise<Result<number>> {
  const { data, error } = await db.rpc("set_my_notification_preferences", {
    p_org_id: orgId,
    p_preferences: choices.map((c) => ({ ...c })),
  });
  if (error) return fail(toDataError(error));
  return ok(data ?? 0);
}

/** The member's quiet hours and digest in an org (row level security shows only their own), or null. */
export async function getMyNotificationSettings(
  db: XosClient,
  orgId: string,
): Promise<Result<MyNotificationSettings | null>> {
  const { data, error } = await db
    .from("notification_settings")
    .select("time_zone, quiet_hours_start, quiet_hours_end, digest_frequency, digest_hour")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (data === null) return ok(null);
  return ok({
    timeZone: data.time_zone,
    quietHoursStart: data.quiet_hours_start?.slice(0, 5) ?? null,
    quietHoursEnd: data.quiet_hours_end?.slice(0, 5) ?? null,
    digestFrequency: data.digest_frequency,
    digestHour: data.digest_hour,
  });
}

/** Records the member's quiet hours (both times or neither), their time zone and their digest choice. */
export async function saveMyNotificationSettings(
  db: XosClient,
  orgId: string,
  settings: MyNotificationSettings,
): Promise<Result<null>> {
  const { error } = await db.rpc("set_my_notification_settings", {
    p_org_id: orgId,
    p_time_zone: settings.timeZone,
    // NULL clears quiet hours; the generated argument types are non-null.
    p_quiet_hours_start: settings.quietHoursStart as string,
    p_quiet_hours_end: settings.quietHoursEnd as string,
    p_digest_frequency: settings.digestFrequency,
    p_digest_hour: settings.digestHour,
  });
  if (error) return fail(toDataError(error));
  return ok(null);
}

/** The org's own defaults (cells without a row keep the platform default) and mandatory categories. */
export async function getOrgNotificationDefaults(
  db: XosClient,
  orgId: string,
): Promise<Result<OrgNotificationDefaults>> {
  const [defaults, mandatory] = await Promise.all([
    db
      .from("org_notification_defaults")
      .select("category_code, channel, enabled")
      .eq("org_id", orgId)
      .is("deleted_at", null),
    db
      .from("org_mandatory_notification_categories")
      .select("category_code")
      .eq("org_id", orgId)
      .is("deleted_at", null),
  ]);
  if (defaults.error) return fail(toDataError(defaults.error));
  if (mandatory.error) return fail(toDataError(mandatory.error));
  return ok({
    defaults: (defaults.data ?? []).flatMap((d) =>
      isChannel(d.channel)
        ? [{ category: d.category_code, channel: d.channel, enabled: d.enabled }]
        : [],
    ),
    mandatory: (mandatory.data ?? []).map((m) => m.category_code),
  });
}

/** Sets the org's defaults and replaces its mandatory categories (org.notifications.write). */
export async function saveOrgNotificationDefaults(
  db: XosClient,
  orgId: string,
  input: OrgNotificationDefaults,
): Promise<Result<null>> {
  const { error } = await db.rpc("set_org_notification_defaults", {
    p_org_id: orgId,
    p_defaults: input.defaults.map((d) => ({ ...d })),
    p_mandatory: [...input.mandatory],
  });
  if (error) return fail(toDataError(error));
  return ok(null);
}

/**
 * The time zone the member is reached in by the org (ADR 0033 decision 35): their notification settings
 * zone, their own locale.time_zone, their engagement's project, the org's zone, never UTC by default.
 * Null only for an org with no zone and no project.
 */
export async function getMyNotificationTimeZone(
  db: XosClient,
  orgId: string,
): Promise<Result<string | null>> {
  const { data, error } = await db.rpc("my_notification_time_zone", { p_org_id: orgId });
  if (error) return fail(toDataError(error));
  return ok(typeof data === "string" && data !== "" ? data : null);
}

export interface MySmsStatus {
  /** The verified sign-in phone in E.164, or null without one. */
  readonly phone: string | null;
  /** The org may text it: consent recorded and no STOP. */
  readonly mayText: boolean;
}

/** The member's verified phone and whether the org may text it (migration 1366). */
export async function getMySmsStatus(db: XosClient, orgId: string): Promise<Result<MySmsStatus>> {
  const { data, error } = await db.rpc("my_sms_status", { p_org_id: orgId });
  if (error) return fail(toDataError(error));
  const row = (data ?? [])[0];
  return ok({ phone: row?.phone_e164 ?? null, mayText: row?.may_text === true });
}

/** Records the member's express consent to texts in the org, or its withdrawal (TCPA, Section 14.5). */
export async function recordMySmsConsent(
  db: XosClient,
  orgId: string,
  consent: boolean,
): Promise<Result<null>> {
  const { error } = await db.rpc("record_my_sms_consent", { p_org_id: orgId, p_consent: consent });
  if (error) return fail(toDataError(error));
  return ok(null);
}
