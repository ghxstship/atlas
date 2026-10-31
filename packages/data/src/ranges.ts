/**
 * Postgres range literals as PostgREST returns them. One parser for every tstzrange the apps read: R7a's hire periods
 * (procurement.ts) and B14's bump-in, bump-out and site windows (projects.ts).
 */

export interface InstantRange {
  /** Lower bound as an ISO instant; null when unbounded or absent. */
  readonly startsAt: string | null;
  /** Upper bound as an ISO instant; null when unbounded or absent. */
  readonly endsAt: string | null;
}

/** A tstzrange (`["2027-06-01 12:00:00+00","2027-06-05 12:00:00+00")`) split into its bounds. */
export function parseTstzRange(value: string | null | undefined): InstantRange {
  const match = value?.match(/^[[(]"?([^",]*)"?,"?([^",]*)"?[\])]$/);
  if (!match) return { startsAt: null, endsAt: null };
  const bound = (raw: string | undefined) => {
    if (!raw) return null;
    const at = new Date(raw.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00"));
    return Number.isNaN(at.getTime()) ? null : at.toISOString();
  };
  return { startsAt: bound(match[1]), endsAt: bound(match[2]) };
}

/** A range as an InstantRange, or null when neither bound is set. */
export function rangeOrNull(value: string | null | undefined): InstantRange | null {
  const range = parseTstzRange(value);
  return range.startsAt === null && range.endsAt === null ? null : range;
}
