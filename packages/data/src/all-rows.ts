import { fail, ok, toDataError, type DatabaseErrorLike, type Result } from "./result.ts";

/** PostgREST's `max_rows` (supabase/config.toml, ADR 0044): an answer past it is cut short without an error. */
export const ROWS_PAGE = 1000;

/**
 * Every row of a read whose figures are summed or listed in full, page by page, so the cap can never leave a partial sum
 * that reads as a complete one. The read must have a stable order. Any page failing fails the read: the whole figure or
 * none (ADR 0151 item 4).
 */
export async function allRows<T>(
  page: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: unknown; error: DatabaseErrorLike | null }>,
  map: (row: Record<string, unknown>) => T,
): Promise<Result<T[]>> {
  const out: T[] = [];
  for (let from = 0; ; from += ROWS_PAGE) {
    const { data, error } = await page(from, from + ROWS_PAGE - 1);
    if (error) return fail(toDataError(error));
    const found = (data as Record<string, unknown>[] | null) ?? [];
    for (const row of found) out.push(map(row));
    if (found.length < ROWS_PAGE) return ok(out);
  }
}
