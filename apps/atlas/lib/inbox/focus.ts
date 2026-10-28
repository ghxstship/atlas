/**
 * The item that takes the focus when `id` leaves the Inbox list: the next one, or the previous one when
 * it was the last (journey 57). Null when nothing is left.
 */
export function neighbourOf(ids: readonly string[], id: string): string | null {
  const index = ids.indexOf(id);
  if (index < 0) return ids[0] ?? null;
  return ids[index + 1] ?? ids[index - 1] ?? null;
}

/**
 * The item that takes the focus when several leave at once (Done or Snooze on a selection): the
 * first one after `id` that stays, else the nearest one before it. Null when nothing is left.
 */
export function neighbourOutside(
  ids: readonly string[],
  id: string,
  leaving: ReadonlySet<string>,
): string | null {
  const index = Math.max(0, ids.indexOf(id));
  const after = ids.slice(index).find((each) => !leaving.has(each));
  return after ?? ids.slice(0, index).findLast((each) => !leaving.has(each)) ?? null;
}

/**
 * The selection after X (`range` false) or Shift+X (`range` true) on `id`: X toggles the item and
 * makes it the anchor; Shift+X adds every item from the anchor to it, or toggles it without one.
 */
export function selectItems(
  ids: readonly string[],
  selected: ReadonlySet<string>,
  anchor: string | null,
  id: string,
  range: boolean,
): { selected: ReadonlySet<string>; anchor: string } {
  const next = new Set(selected);
  const from = anchor === null ? -1 : ids.indexOf(anchor);
  const to = ids.indexOf(id);
  if (range && from !== -1 && to !== -1 && from !== to) {
    for (const each of ids.slice(Math.min(from, to), Math.max(from, to) + 1)) next.add(each);
    return { selected: next, anchor: anchor ?? id };
  }
  if (!next.delete(id)) next.add(id);
  return { selected: next, anchor: id };
}
