import { formatMessage, type MessageArgs } from "@xos/email";
import { isLocale, type Locale } from "@xos/i18n";
import { copyKeys } from "@xos/schemas/notifications";

/** An ISO 8601 instant, which message arguments carry for `{x, date}` and `{x, time}` formats. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * The ICU arguments of a notification: display strings and numbers from `message_args`, with ISO
 * instants as dates so a date or time format renders them in the recipient's time zone. Nested values
 * are never relational data and are dropped.
 */
export function notificationArgs(raw: Readonly<Record<string, unknown>>): MessageArgs {
  const args: Record<string, string | number | Date> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "number") args[key] = value;
    else if (typeof value === "string")
      args[key] = ISO_INSTANT.test(value) ? new Date(value) : value;
  }
  return args;
}

/** The recipient's locale when the catalogs carry it, else en-US. */
export function localeOf(value: string | null | undefined): Locale {
  return value !== null && value !== undefined && isLocale(value) ? value : "en-US";
}

export interface NotificationText {
  /** The kind's subject: the email subject, the push title. */
  readonly title: string;
  /** The kind's body: the push body and the SMS text. */
  readonly body: string;
}

/**
 * A kind's copy for push and SMS, from the `email` catalog under the registry's keys
 * (`email.kinds.<subject>.<event>`), the one home of notification copy on every channel (Section 3.15).
 * A missing message or argument throws, so a raw key never reaches a phone.
 */
export function notificationText(
  kind: string,
  raw: Readonly<Record<string, unknown>>,
  locale: Locale,
  timeZone: string,
): NotificationText {
  const keys = copyKeys(kind);
  const args = notificationArgs(raw);
  return {
    title: formatMessage(locale, keys.subject, args, timeZone),
    body: formatMessage(locale, keys.body, args, timeZone),
  };
}

/** Shortens text to a limit on a word boundary where it can, ending with an ellipsis. */
export function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > limit / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
