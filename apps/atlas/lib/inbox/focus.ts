/**
 * The item that takes the focus when `id` leaves the Inbox list: the next one, or the previous one when
 * it was the last (journey 57). Null when nothing is left.
 */
export function neighbourOf(ids: readonly string[], id: string): string | null {
  const index = ids.indexOf(id);
  if (index < 0) return ids[0] ?? null;
  return ids[index + 1] ?? ids[index - 1] ?? null;
}
