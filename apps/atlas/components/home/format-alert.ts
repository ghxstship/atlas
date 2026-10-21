import type { Alert } from "@/lib/home/data";

type Translate = (key: string, values?: Record<string, string | number>) => string;
/** Formats a date in the medium date style of the person's locale. */
type MediumDate = (date: Date) => string;

/**
 * The text of a Home alert from the `home.alerts` catalog, with its date in the person's locale.
 * Plain, so the server renders the Home tiles' alerts and the browser never builds the date
 * formatter during hydration (gate 10, Total Blocking Time); useAlertText wraps it for client views.
 */
export function formatAlert(t: Translate, mediumDate: MediumDate, a: Alert): string {
  const values = { ...a.values };
  if (a.kind === "gateGap" || a.kind === "overdue") {
    const raw = String(values["date"] ?? "");
    if (raw) {
      values["date"] = mediumDate(new Date(raw.length === 10 ? `${raw}T00:00:00` : raw));
    }
  }
  return t(a.kind, values);
}
