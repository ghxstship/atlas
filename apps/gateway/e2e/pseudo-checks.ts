import type { Page } from "@playwright/test";
import {
  databaseText as loadDatabaseText,
  hardCodedText as findHardCoded,
} from "@xos/testing/pseudo";
import type { Found } from "@xos/testing/pseudo";

/**
 * Gate 16 (Section 15): the pseudo-locale checks, shared by every web shell in
 * packages/testing/src/pseudo.ts, bound to the stack this app's journeys run against. Text that is
 * data is looked up in that database (E2E_DATABASE_URL); apps/atlas/e2e/pseudo-checks.ts does the
 * same for Atlas.
 */
export { describe, truncatedText, unwrappedText, type Found } from "@xos/testing/pseudo";

const DATABASE_URL =
  process.env["E2E_DATABASE_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:56922/postgres";

/** Every text value the demo database holds, loaded once per worker from the local stack. */
export function databaseText(): Promise<Set<string>> {
  return loadDatabaseText(DATABASE_URL);
}

/** Unwrapped text that is neither data nor formatting: hard-coded or untranslated strings. */
export async function hardCodedText(page: Page): Promise<Found[]> {
  return findHardCoded(page, await databaseText());
}
