import type { Result } from "@xos/data/result";

/**
 * The row a page's `?peek=<id>` names: from the loaded list, or read by its id when the list leaves
 * it out, such as an archived row a Favorite or a link names (A124, ADR 0085 decision 1). The read
 * happens only on a miss; a row the viewer cannot read, or one the page does not keep, opens nothing.
 */
export async function peekedRow<T extends { readonly id: string }>(
  rows: readonly T[],
  peek: string | null | undefined,
  read: (id: string) => Promise<Result<T>>,
  keep: (row: T) => boolean = () => true,
): Promise<T | null> {
  if (!peek) return null;
  const listed = rows.find((r) => r.id === peek);
  if (listed) return listed;
  const found = await read(peek);
  return found.ok && keep(found.data) ? found.data : null;
}
