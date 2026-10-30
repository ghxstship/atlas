import { REQUEST_OUTCOMES, type RequestOutcome } from "@xos/data/credential-photos";
import type { Translate } from "@/lib/shell/translate";

/**
 * The outcome of asking for badge photos (P5), in plain words: one sentence per outcome, such as "2 holders asked.
 * 1 has no sign-in, so cannot be asked.", or "Nobody needed asking."
 */
export function outcomeSummary(
  t: Translate,
  counts: Readonly<Partial<Record<RequestOutcome, number>>>,
): string {
  const parts = REQUEST_OUTCOMES.filter((o) => (counts[o] ?? 0) > 0).map((o) =>
    t(`credentials.photo.outcomes.${o}`, { count: counts[o] ?? 0 }),
  );
  return parts.length > 0 ? `${parts.join(". ")}.` : t("credentials.photo.outcomes.none");
}

/** The `asked` parameter the print panel returns with: counts only, never a name. */
export function formatAsked(counts: Readonly<Partial<Record<RequestOutcome, number>>>): string {
  return (
    REQUEST_OUTCOMES.filter((o) => (counts[o] ?? 0) > 0)
      .map((o) => `${o}:${counts[o]}`)
      .join(",") || "none"
  );
}

/** The counts of an `asked` parameter; anything unexpected is ignored. */
export function parseAsked(value: string | undefined): Partial<Record<RequestOutcome, number>> {
  const counts: Partial<Record<RequestOutcome, number>> = {};
  for (const part of (value ?? "").split(",")) {
    const [outcome, count] = part.split(":");
    if (
      (REQUEST_OUTCOMES as readonly string[]).includes(outcome ?? "") &&
      /^\d{1,3}$/.test(count ?? "")
    ) {
      counts[outcome as RequestOutcome] = Number(count);
    }
  }
  return counts;
}
