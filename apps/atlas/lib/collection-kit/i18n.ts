import { getTranslations } from "next-intl/server";

/**
 * A translator for one A16 namespace with keys computed at runtime (states, moves, refusal rules).
 * The catalog tests guarantee the keys exist in en-US and es-US; the typed key union is widened
 * here, in one place, like lib/shell/translate.ts.
 */
export type Copy = ((key: string, values?: Record<string, string | number>) => string) & {
  has: (key: string) => boolean;
};

export async function getCopy(namespace: string): Promise<Copy> {
  return (await getTranslations(namespace as never)) as unknown as Copy;
}
