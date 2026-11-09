import type { PolicyWarning } from "@xos/data/crew";

/** A warning as a short tag, in whole or half hours: "Under 10 h rest", "Over 12 h that day", "Over 50 h that week". */
export function policyTag(
  t: (key: string, values?: Record<string, string | number>) => string,
  warning: PolicyWarning,
): string {
  return t(`crew.policy.tags.${warning.code}`, {
    hours: Math.round((warning.limitMinutes / 60) * 2) / 2,
  });
}
