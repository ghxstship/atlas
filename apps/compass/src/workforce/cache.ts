/**
 * Offline copies of Workforce reads a person needs without signal, such as the published forms and their
 * templates (journey 65: a form completed offline). A successful read replaces the device copy; when the
 * read fails for want of a connection, the last copy answers instead. A refusal or a missing row never
 * falls back, so access the server withdrew is not served from the device.
 */
import type { Result } from "@xos/data/result";
import type { LocalStore } from "@xos/sync";

export const CACHE_TABLE = "workforce_cache";

export async function cachedRead<T>(
  store: LocalStore | null,
  key: string,
  load: () => Promise<Result<T>>,
): Promise<Result<T>> {
  const result = await load();
  if (!store) return result;
  if (result.ok) {
    await store.transaction((tx) =>
      tx.put(CACHE_TABLE, { id: key, value: JSON.stringify(result.data) }),
    );
    return result;
  }
  if (result.error.kind !== "unexpected") return result;
  const copy = await store.get(CACHE_TABLE, key);
  const value = copy?.["value"];
  return typeof value === "string" ? { ok: true, data: JSON.parse(value) as T } : result;
}
