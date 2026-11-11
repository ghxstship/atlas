import type { IncidentSeverity } from "@xos/data/incidents";

/**
 * The Severity choices of Report incident (crawl 4.9). Canon lists the severities most severe first, so a select
 * without a blank first choice preselected "Level 1 - Critical": a quick report went out as critical and notified the
 * dispatchers. The first choice is now an empty prompt, and the field is required, so the reporter picks a level (the
 * near-miss guidance asks for Level 5 - Advisory). The value of the prompt is empty, which the action refuses.
 */
export function reportSeverityOptions(
  severities: readonly IncidentSeverity[],
  prompt: string,
): { value: string; label: string }[] {
  return [
    { value: "", label: prompt },
    ...severities.map((s) => ({ value: s.id, label: s.label })),
  ];
}
