/**
 * Notifications in Compass (Section 4.5.6 personal settings item 8, Section 4.3 item 15 part 3, ADR 0071): the same
 * choices Atlas and Gateway save, through the same calls.
 *
 *   For a member, per org   the category-by-channel matrix of Atlas Me (app.my_notification_matrix and
 *                           set_my_notification_preferences, 1362), quiet hours read in a time zone and the email
 *                           digest (set_my_notification_settings), and consent to texts (record_my_sms_consent, 1366).
 *   For everyone            the party categories by Email and Push (app.person_notification_preferences, 1131) and
 *                           the person's own quiet hours (set_my_quiet_hours, 1461), as Gateway shows them.
 *
 * A category offers a switch only for the channels its kinds reach in the notification registry: a channel no kind
 * of the category is delivered on could never send anything (A104 draws Atlas and Gateway the same way).
 *
 * Compass keeps what it read in device-local tables, so the section opens offline, and every change except consent
 * to texts queues in the outbox with its optimistic row. Consent to texts is recorded online only: it is express
 * consent, given when the person reads the wording (TCPA, Section 14.5).
 */
import { isTimeZone } from "@xos/data/calendar";
import {
  DIGEST_FREQUENCIES,
  NOTIFICATION_MATRIX_CHANNELS,
  type DigestFrequency,
  type MatrixCell,
  type MatrixChannel,
  type MyNotificationSettings,
} from "@xos/data/notification-settings";
import {
  PARTY_CATEGORIES,
  PARTY_CHANNELS,
  type MyQuietHours,
  type PartyCategory,
  type PartyChannel,
  type PartyPreference,
} from "@xos/data/party-notifications";
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_KINDS,
  type CategoryDefinition,
  type KindDefinition,
} from "@xos/schemas/notifications";
import type { MutationInput, Row } from "@xos/sync";

/** The device-local copies of what the section read. */
export const NOTIFICATION_MIRROR = {
  /** One row per member org, category and channel the category reaches. */
  matrix: "_me_notification_matrix",
  /** One row per member org: quiet hours, their zone, the digest and texts. */
  orgSettings: "_me_notification_settings",
  /** One row per party category and channel. */
  party: "_me_party_preferences",
  /** The person's own quiet hours, one row. */
  quietHours: "_me_quiet_hours",
} as const;

/**
 * The outbox target of a party preference. Gateway writes it to app.person_notification_preferences directly
 * (setMyNotificationPreference); the uploader routes it to the same function (src/data/settingsRoutes.ts).
 */
export const PARTY_PREFERENCE_TARGET = "person_notification_preference";

/** The row id of the person's own quiet hours. */
export const QUIET_HOURS_ROW = "person";

/** The catalog key of a channel label (`settings.notifications.channels.*`), as Atlas labels its columns. */
export const CHANNEL_KEYS: Readonly<Record<MatrixChannel, string>> = {
  "In App": "inApp",
  Email: "email",
  SMS: "sms",
  Push: "push",
};

type KindChannels = Pick<KindDefinition, "category" | "channels">;

/**
 * The channels the kinds of a category reach in the registry, in matrix order; empty for a category without kinds.
 * The same rule as A104's categoryChannels, derived here from the generated registry.
 */
export function reachedChannels(
  category: string,
  kinds: readonly KindChannels[] = NOTIFICATION_KINDS,
): MatrixChannel[] {
  const reached = new Set(kinds.filter((k) => k.category === category).flatMap((k) => k.channels));
  return NOTIFICATION_MATRIX_CHANNELS.filter((c) => reached.has(c));
}

// The member's matrix in one org -------------------------------------------------------------------------------------

/** The row id of one cell of an org's matrix. */
export function cellId(orgId: string, category: string, channel: MatrixChannel): string {
  return `${orgId}:${category}:${channel}`;
}

/**
 * The device rows of a member's matrix in an org, read from app.my_notification_matrix: every category in display
 * order, on the channels its kinds reach. A cell the server did not send reads off and unlocked, as Atlas shows it.
 */
export function matrixRows(
  orgId: string,
  cells: readonly Pick<MatrixCell, "category" | "channel" | "enabled" | "locked">[],
  categories: readonly CategoryDefinition[] = NOTIFICATION_CATEGORIES,
  kinds: readonly KindChannels[] = NOTIFICATION_KINDS,
): Row[] {
  return [...categories]
    .sort((a, b) => a.order - b.order)
    .flatMap((c) =>
      reachedChannels(c.code, kinds).map((channel) => {
        const cell = cells.find((m) => m.category === c.code && m.channel === channel);
        return {
          id: cellId(orgId, c.code, channel),
          org_id: orgId,
          category: c.code,
          channel,
          enabled: cell?.enabled ?? false,
          locked: cell?.locked ?? false,
          urgent: c.urgent,
          position: c.order * 10 + NOTIFICATION_MATRIX_CHANNELS.indexOf(channel),
        };
      }),
    );
}

export interface CellView {
  readonly rowId: string;
  readonly channel: MatrixChannel;
  readonly enabled: boolean;
  /** The org made the category mandatory with this channel on: it stays on. */
  readonly locked: boolean;
}

export interface CategoryView {
  readonly category: string;
  readonly urgent: boolean;
  readonly cells: readonly CellView[];
}

/** An org's matrix as the screen draws it: one card per category, its channels in matrix order. */
export function matrixView(rows: readonly Row[], orgId: string): CategoryView[] {
  const mine = rows
    .filter((r) => r["org_id"] === orgId)
    .sort((a, b) => Number(a["position"]) - Number(b["position"]));
  const views: CategoryView[] = [];
  for (const row of mine) {
    const category = String(row["category"]);
    const cell: CellView = {
      rowId: row.id,
      channel: row["channel"] as MatrixChannel,
      enabled: row["enabled"] === true,
      locked: row["locked"] === true,
    };
    const last = views.at(-1);
    if (last && last.category === category)
      views[views.length - 1] = { ...last, cells: [...last.cells, cell] };
    else views.push({ category, urgent: row["urgent"] === true, cells: [cell] });
  }
  return views;
}

/**
 * Turns one channel of a category on or off for the member (set_my_notification_preferences with one choice). Null
 * when nothing changes, or for a locked channel turned off, which the database refuses
 * (notification_category_mandatory).
 */
export function channelWrite(row: Row, enabled: boolean): MutationInput | null {
  if (row["enabled"] === enabled) return null;
  if (row["locked"] === true && !enabled) return null;
  return {
    op: "rpc",
    target: "set_my_notification_preferences",
    table: NOTIFICATION_MIRROR.matrix,
    rowId: row.id,
    payload: {
      p_org_id: row["org_id"],
      p_preferences: [{ category: row["category"], channel: row["channel"], enabled }],
    },
    policy: "append",
    optimistic: { ...row, enabled },
  };
}

// The member's quiet hours, digest and texts in one org ---------------------------------------------------------------

export interface OrgNotificationSettings {
  readonly timeZone: string;
  readonly quietStart: string | null;
  readonly quietEnd: string | null;
  readonly digestFrequency: DigestFrequency;
  readonly digestHour: number;
  /** The last four digits of the verified sign-in phone, or null without one. */
  readonly phoneLast4: string | null;
  /** The org may text it: consent recorded and no STOP. */
  readonly mayText: boolean;
}

/**
 * The device row of a member's settings in an org. Without saved settings the zone is the one texts are already
 * timed by (app.my_notification_time_zone, ADR 0033 decision 35), else `fallbackZone`, so saving never moves it to
 * UTC; the digest is off at 08:00, as Atlas starts it. Only the phone's last four digits stay on the device.
 */
export function orgSettingsRow(
  orgId: string,
  saved: MyNotificationSettings | null,
  zone: string | null,
  fallbackZone: string,
  sms: { readonly phone: string | null; readonly mayText: boolean },
): Row {
  return {
    id: orgId,
    org_id: orgId,
    time_zone: saved?.timeZone ?? zone ?? fallbackZone,
    quiet_hours_start: saved?.quietHoursStart ?? null,
    quiet_hours_end: saved?.quietHoursEnd ?? null,
    digest_frequency: saved?.digestFrequency ?? "Off",
    digest_hour: saved?.digestHour ?? 8,
    phone_last4: sms.phone === null ? null : sms.phone.slice(-4),
    may_text: sms.mayText,
  };
}

const text = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

/** A device row of a member's settings, read back. */
export function orgSettingsOf(row: Row | undefined): OrgNotificationSettings | null {
  if (!row) return null;
  const frequency = DIGEST_FREQUENCIES.find((f) => f === row["digest_frequency"]) ?? "Off";
  const hour = Number(row["digest_hour"]);
  return {
    timeZone: text(row["time_zone"]) ?? "UTC",
    quietStart: text(row["quiet_hours_start"]),
    quietEnd: text(row["quiet_hours_end"]),
    digestFrequency: frequency,
    digestHour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 8,
    phoneLast4: text(row["phone_last4"]),
    mayText: row["may_text"] === true,
  };
}

/** Records a member's quiet hours, their zone and the digest in an org, as Atlas saves them. */
export function orgSettingsWrite(
  row: Row,
  quiet: QuietHours,
  digest: { readonly frequency: DigestFrequency; readonly hour: number },
): MutationInput {
  return {
    op: "rpc",
    target: "set_my_notification_settings",
    table: NOTIFICATION_MIRROR.orgSettings,
    rowId: row.id,
    payload: {
      p_org_id: row["org_id"],
      p_time_zone: quiet.timeZone,
      p_quiet_hours_start: quiet.start,
      p_quiet_hours_end: quiet.end,
      p_digest_frequency: digest.frequency,
      p_digest_hour: digest.hour,
    },
    policy: "append",
    optimistic: {
      ...row,
      time_zone: quiet.timeZone,
      quiet_hours_start: quiet.start,
      quiet_hours_end: quiet.end,
      digest_frequency: digest.frequency,
      digest_hour: digest.hour,
    },
  };
}

/** The device row after the server recorded consent to texts, or its withdrawal. */
export function withSmsConsent(row: Row, consent: boolean): Row {
  return { ...row, may_text: consent };
}

// Quiet hours and the digest: the checks before a save ----------------------------------------------------------------

/** What is wrong with a quiet hours field: not a time, one time without the other, both the same, or no zone. */
export type QuietHoursProblem = "time" | "pair" | "same" | "zone";

export interface QuietHoursInput {
  readonly start: string;
  readonly end: string;
  readonly timeZone: string;
}

export interface QuietHours {
  /** Local `HH:MM` quiet hours begin, or null for none. */
  readonly start: string | null;
  readonly end: string | null;
  readonly timeZone: string;
}

export type QuietHoursCheck =
  | { readonly ok: true; readonly value: QuietHours }
  | {
      readonly ok: false;
      readonly errors: Readonly<Partial<Record<keyof QuietHoursInput, QuietHoursProblem>>>;
    };

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** A typed time as `HH:MM` (9:30 is 09:30), or null when it is not a time of day. */
export function normalizeTime(value: string): string | null {
  const match = TIME.exec(value.trim());
  return match ? `${(match[1] ?? "").padStart(2, "0")}:${match[2] ?? ""}` : null;
}

/**
 * The checks Atlas and Gateway run before saving quiet hours, which the database repeats (the quiet pair and
 * distinct constraints, private.assert_time_zone): both times or neither, each a time of day, the end not the
 * start, and a zone the device knows, never assumed to be UTC. Both blank turns quiet hours off; quiet hours may
 * span midnight (22:00 to 07:00).
 */
export function checkQuietHours(input: QuietHoursInput): QuietHoursCheck {
  const errors: Partial<Record<keyof QuietHoursInput, QuietHoursProblem>> = {};
  const zone = input.timeZone.trim();
  if (!isTimeZone(zone)) errors.timeZone = "zone";
  const rawStart = input.start.trim();
  const rawEnd = input.end.trim();
  const start = rawStart === "" ? null : normalizeTime(rawStart);
  const end = rawEnd === "" ? null : normalizeTime(rawEnd);
  if (rawStart !== "" && start === null) errors.start = "time";
  if (rawEnd !== "" && end === null) errors.end = "time";
  if (errors.start === undefined && errors.end === undefined) {
    if ((rawStart === "") !== (rawEnd === "")) errors[rawStart === "" ? "start" : "end"] = "pair";
    else if (start !== null && start === end) errors.end = "same";
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { start, end, timeZone: zone } };
}

/** True for a digest frequency and an hour of the day Atlas offers. */
export function isDigest(frequency: string, hour: number): frequency is DigestFrequency {
  return (
    (DIGEST_FREQUENCIES as readonly string[]).includes(frequency) &&
    Number.isInteger(hour) &&
    hour >= 0 &&
    hour <= 23
  );
}

// Everyone: party categories and the person's own quiet hours ---------------------------------------------------------

/** The party channels a category's kinds reach: the only ones the person is offered a switch for. */
export function partyChannels(
  category: PartyCategory,
  kinds: readonly KindChannels[] = NOTIFICATION_KINDS,
): PartyChannel[] {
  const reached = reachedChannels(category, kinds);
  return PARTY_CHANNELS.filter((channel) => reached.includes(channel));
}

/**
 * The device rows of the person's party preferences: each party category on the channels it reaches, with what
 * listMyNotificationPreferences resolved (their choice, else their company accounts' default, else the channel's).
 */
export function partyRows(
  prefs: readonly PartyPreference[],
  kinds: readonly KindChannels[] = NOTIFICATION_KINDS,
): Row[] {
  return PARTY_CATEGORIES.flatMap((category, i) =>
    partyChannels(category, kinds).map((channel) => ({
      id: `${category}:${channel}`,
      category,
      channel,
      enabled: prefs.find((p) => p.category === category && p.channel === channel)?.enabled ?? true,
      position: i * 10 + PARTY_CHANNELS.indexOf(channel),
    })),
  );
}

export interface PartyView {
  readonly category: PartyCategory;
  readonly cells: readonly {
    readonly rowId: string;
    readonly channel: PartyChannel;
    readonly enabled: boolean;
  }[];
}

/** The party preferences as the screen draws them: one card per category. */
export function partyView(rows: readonly Row[]): PartyView[] {
  return PARTY_CATEGORIES.flatMap((category) => {
    const cells = rows
      .filter((r) => r["category"] === category)
      .sort((a, b) => Number(a["position"]) - Number(b["position"]))
      .map((r) => ({
        rowId: r.id,
        channel: r["channel"] as PartyChannel,
        enabled: r["enabled"] === true,
      }));
    return cells.length > 0 ? [{ category, cells }] : [];
  });
}

/** Turns one party channel on or off for the person, or null when nothing changes. */
export function partyWrite(row: Row, personId: string, enabled: boolean): MutationInput | null {
  if (row["enabled"] === enabled) return null;
  return {
    op: "rpc",
    target: PARTY_PREFERENCE_TARGET,
    table: NOTIFICATION_MIRROR.party,
    rowId: row.id,
    payload: { person_id: personId, category: row["category"], channel: row["channel"], enabled },
    policy: "append",
    optimistic: { ...row, enabled },
  };
}

/** The device row of the person's own quiet hours; without any saved, the zone is `fallbackZone`. */
export function quietHoursRow(saved: MyQuietHours | null, fallbackZone: string): Row {
  return {
    id: QUIET_HOURS_ROW,
    time_zone: saved?.timeZone ?? fallbackZone,
    quiet_hours_start: saved?.start ?? null,
    quiet_hours_end: saved?.end ?? null,
  };
}

/** The person's own quiet hours, read back from the device row. */
export function quietHoursOf(row: Row | undefined, fallbackZone: string): QuietHours {
  return {
    timeZone: text(row?.["time_zone"]) ?? fallbackZone,
    start: text(row?.["quiet_hours_start"]),
    end: text(row?.["quiet_hours_end"]),
  };
}

/**
 * Records the person's own quiet hours (app.set_my_quiet_hours), as Gateway saves them: without times, quiet hours
 * are off.
 */
export function quietHoursWrite(row: Row, value: QuietHours): MutationInput {
  return {
    op: "rpc",
    target: "set_my_quiet_hours",
    table: NOTIFICATION_MIRROR.quietHours,
    rowId: row.id,
    payload: {
      p_time_zone: value.timeZone,
      ...(value.start && value.end
        ? { p_quiet_hours_start: value.start, p_quiet_hours_end: value.end }
        : {}),
    },
    policy: "append",
    optimistic: {
      ...row,
      time_zone: value.timeZone,
      quiet_hours_start: value.start,
      quiet_hours_end: value.end,
    },
  };
}
