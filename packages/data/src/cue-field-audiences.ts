import type { XosClient } from "./client.ts";
import type { CueFieldAudience, CustomDataType } from "./custom-fields.ts";
import { Constants } from "./database.types.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Cue field audiences (app.cue_field_audiences, 6240) as server modules read them (ADR 0142). The list comes from the
 * generated Constants, which weigh 6.3 KB gzip (ADR 0123): custom-fields.ts reaches client components, so this stays
 * apart from it, imported only by governance.tsx, surface-actions.ts and show-pages.tsx.
 */

/** Who a cue field is for: Crew in Atlas, Showcaller on showcaller links, Client in Gateway. */
export const CUE_FIELD_AUDIENCES = Constants.app.Enums.cue_field_audience;

/** Data types that never go to a showcaller link or a Client: neither has an account or holds money. */
export const CREW_ONLY_TYPES: readonly CustomDataType[] = ["Person", "Money", "Email"];

/** The audiences a field of this type may take. */
export function audiencesFor(type: CustomDataType): readonly CueFieldAudience[] {
  return CREW_ONLY_TYPES.includes(type) ? ["Crew"] : CUE_FIELD_AUDIENCES;
}

/** The live audiences of the org's cue fields, by definition id. */
export async function listCueFieldAudiences(
  db: XosClient,
  orgId: string,
): Promise<Result<ReadonlyMap<string, readonly CueFieldAudience[]>>> {
  const { data, error } = await db
    .from("cue_field_audiences")
    .select("custom_field_definition_id, audience")
    .eq("org_id", orgId)
    .is("deleted_at", null);
  if (error) return fail(toDataError(error));
  const byField = new Map<string, CueFieldAudience[]>();
  for (const r of data ?? []) {
    byField.set(r.custom_field_definition_id, [
      ...(byField.get(r.custom_field_definition_id) ?? []),
      r.audience,
    ]);
  }
  for (const list of byField.values()) {
    list.sort((a, b) => CUE_FIELD_AUDIENCES.indexOf(a) - CUE_FIELD_AUDIENCES.indexOf(b));
  }
  return ok(byField);
}
