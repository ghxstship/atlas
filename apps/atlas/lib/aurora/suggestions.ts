import { transitionAiSuggestion } from "@xos/data/ai";
import type { XosClient } from "@xos/data";
import { SUGGESTION_FIELD } from "./suggestion-field";

/**
 * Closing Aurora's extraction suggestions when the form they filled is saved (A95, Section 4.7).
 * The extraction panel fills the invoice, expense or RFQ response form and adds each suggestion's id
 * as a hidden `aiSuggestionId`; the person reviews the form and saves it, which is the confirmation.
 * After the save succeeds, each suggestion moves Proposed, Confirmed, Applied with the record the
 * save wrote, so the ledger says what Aurora proposed and what was kept. The suggestion RPC lets only
 * the person who asked decide, and a suggestion that cannot be closed is left to expire and logged,
 * never allowed to fail a save that already happened.
 */

export { SUGGESTION_FIELD };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The suggestion ids a form carries, at most 50, each once. */
export function suggestionIds(form: FormData): string[] {
  const ids = form
    .getAll(SUGGESTION_FIELD)
    .filter((v): v is string => typeof v === "string" && UUID.test(v));
  return [...new Set(ids)].slice(0, 50);
}

/** Confirms and applies each suggestion with the record written; returns how many stay open. */
export async function applySuggestions(
  db: XosClient,
  ids: readonly string[],
  appliedId: string,
  reason: string,
): Promise<number> {
  let open = 0;
  for (const id of ids) {
    const confirmed = await transitionAiSuggestion(db, {
      id,
      expected: "Proposed",
      next: "Confirmed",
      reason,
    });
    const applied = confirmed.ok
      ? await transitionAiSuggestion(db, {
          id,
          expected: "Confirmed",
          next: "Applied",
          reason,
          appliedId,
        })
      : confirmed;
    if (!applied.ok) {
      open += 1;
      console.error("An Aurora suggestion stays open after its form was saved", id, applied.error);
    }
  }
  return open;
}
