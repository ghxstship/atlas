import type { XosClient } from "./client.ts";

/**
 * One name resolution for people across Atlas (finding A59-011, migration 1275). Lists that embed
 * `app.people` see a name only for members of the reader's orgs, so an engaged crew member read as
 * "Unnamed person" on Offers or Credentials while Pipeline named them. `app.person_names` returns the
 * display name of anyone the reader may know by name (members, and people their orgs engage, received
 * an application from, or recorded a credential or certification for), and nothing else.
 */

/** Names by person id for the ids the reader may know; unknown or hidden ids are absent. */
export async function personNames(
  db: XosClient,
  ids: Iterable<string | null | undefined>,
): Promise<ReadonlyMap<string, string>> {
  const unique = [
    ...new Set([...ids].filter((id): id is string => typeof id === "string" && id !== "")),
  ];
  const names = new Map<string, string>();
  if (unique.length === 0) return names;
  // A failed lookup leaves names as the list already had them; it never fails the list.
  const { data, error } = await db.rpc("person_names", { p_person_ids: unique });
  if (error || !data) return names;
  for (const row of data as readonly { person_id: string | null; full_name: string | null }[]) {
    if (row.person_id && row.full_name) names.set(row.person_id, row.full_name);
  }
  return names;
}

/**
 * Fills each item's missing name from `app.person_names`: `idOf` reads the person id, `nameOf` the
 * name the list already has, and `withName` returns the item with the resolved name. Items that
 * already carry a name, or whose person stays hidden, come back unchanged.
 */
export async function fillPersonNames<T>(
  db: XosClient,
  items: readonly T[],
  idOf: (item: T) => string | null | undefined,
  nameOf: (item: T) => string | null | undefined,
  withName: (item: T, name: string) => T,
): Promise<T[]> {
  const missing = items.filter((item) => !nameOf(item) && idOf(item)).map(idOf);
  if (missing.length === 0) return [...items];
  const names = await personNames(db, missing);
  return items.map((item) => {
    if (nameOf(item)) return item;
    const id = idOf(item);
    const name = id ? names.get(id) : undefined;
    return name ? withName(item, name) : item;
  });
}
