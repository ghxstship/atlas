/** Query string helpers for People and Crew pages: every view keeps its filters (Section 11.15). */

/** The page's search params as plain strings (first value wins). */
export type SearchParams = Readonly<Record<string, string | undefined>>;

export function flatParams(raw: Record<string, string | string[] | undefined>): SearchParams {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(raw)) out[k] = Array.isArray(v) ? v[0] : v;
  return out;
}

/** The query string of the current view with some keys replaced or removed. */
export function withParams(
  base: string,
  current: SearchParams,
  changes: Readonly<Record<string, string | null>>,
): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(current)) if (v !== undefined) q.set(k, v);
  for (const [k, v] of Object.entries(changes)) {
    if (v === null) q.delete(k);
    else q.set(k, v);
  }
  const s = q.toString();
  return s ? `${base}?${s}` : base;
}
