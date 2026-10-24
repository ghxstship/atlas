import type { Alert } from "@/lib/home/data";

type Translate = (key: string, values?: Record<string, string | number>) => string;
/** Formats a date in the medium date style of the person's locale, on a time zone's calendar. */
type MediumDate = (date: Date, timeZone: string) => string;

/**
 * The text of a Home alert from the `home.alerts` catalog, with its date in the person's locale.
 * Plain, so the server renders the Home tiles' alerts and the browser never builds the date
 * formatter during hydration (gate 10, Total Blocking Time); useAlertText wraps it for client views.
 *
 * A gate gap's date is a calendar date (`YYYY-MM-DD`, the project's first production day) and reads
 * the same everywhere. An overdue record's date is the instant it was due, shown on the org's
 * calendar (`timeZone`, getOrgTimeZone), the calendar the alerts' "today" is on (A71): in UTC a record
 * due at 22:00 in New York read as due tomorrow.
 */
export function formatAlert(
  t: Translate,
  mediumDate: MediumDate,
  a: Alert,
  timeZone: string,
): string {
  const values = { ...a.values };
  if (a.kind === "gateGap" || a.kind === "overdue") {
    const raw = String(values["date"] ?? "");
    if (raw) {
      values["date"] =
        raw.length === 10
          ? mediumDate(new Date(`${raw}T00:00:00Z`), "UTC")
          : mediumDate(new Date(raw), timeZone);
    }
  }
  return t(a.kind, values);
}
