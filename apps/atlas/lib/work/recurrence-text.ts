/**
 * A recurrence rule in words (Section 11.10 item 2, A59-017): "Weekly on Mon, Wed", "Every 2 days",
 * never `FREQ=WEEKLY;BYDAY=MO,WE`. `t` reads `work.recurrence.*`. A rule outside what the editor writes
 * (DAILY, WEEKLY or MONTHLY, INTERVAL, BYDAY) reads as "Custom rule".
 */
export function describeRrule(
  rrule: string,
  t: (key: string, values?: Record<string, string | number>) => string,
): string {
  const parts = new Map(
    rrule
      .split(";")
      .map((p) => p.split("=") as [string, string | undefined])
      .filter((p): p is [string, string] => typeof p[1] === "string"),
  );
  const frequency = parts.get("FREQ") ?? "";
  if (!["DAILY", "WEEKLY", "MONTHLY"].includes(frequency)) return t("summary.custom");
  const interval = Math.max(1, Number(parts.get("INTERVAL") ?? "1") || 1);
  const summary = t(`summary.${frequency.toLowerCase()}`, { interval });
  const days = (parts.get("BYDAY") ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter((d) => /^(MO|TU|WE|TH|FR|SA|SU)$/.test(d));
  if (frequency !== "WEEKLY" || days.length === 0) return summary;
  return t("summary.on", { summary, days: days.map((d) => t(`weekday.${d}`)).join(", ") });
}
