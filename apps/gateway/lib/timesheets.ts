/**
 * What a person is told before certifying a timesheet (4.9 surface crawl): Submit sends the period's hours to the
 * organization as worked, so a period with no hours, or one that has not ended in the project's zone, is named first.
 * Pure, so the warnings are unit tested; the database still decides (app.submit_timesheet refuses open entries).
 */
export type TimesheetWarning = "empty" | "future";

export function timesheetWarnings(
  sheet: { readonly workedMinutes: number | null; readonly periodEnd: string | null },
  /** Today in the project's zone, YYYY-MM-DD. */
  today: string,
): TimesheetWarning[] {
  const warnings: TimesheetWarning[] = [];
  if ((sheet.workedMinutes ?? 0) <= 0) warnings.push("empty");
  if (sheet.periodEnd !== null && sheet.periodEnd >= today) warnings.push("future");
  return warnings;
}
