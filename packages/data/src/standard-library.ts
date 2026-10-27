import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * The XOS Standard Library in an org (migration 1612, finding A65-027, Section 7.2). A new org receives an
 * editable copy of every Standard Library table, each row naming its standard source. An org created before
 * that adopts it with the "Adopt Standard Library" action (Settings, Canon Extensions), which copies only the
 * rows the org never held: nothing the org edited or removed changes, and a second run copies nothing.
 */

/** The ten Standard Library tables, in the order of Section 7.2. */
export const STANDARD_LIBRARIES = [
  "document_library",
  "emergency_codes",
  "enumerations",
  "labor_rate_cards",
  "radio_channels",
  "roles",
  "sops",
  "vendor_classes",
  "vendor_entitlements",
  "verbiage",
] as const;

export type StandardLibrary = (typeof STANDARD_LIBRARIES)[number];

export interface StandardLibraryCount {
  readonly library: StandardLibrary;
  /** Rows the Standard Library holds. */
  readonly standardCount: number;
  /** Standard rows the org holds a copy of, or held one it removed. */
  readonly adoptedCount: number;
}

function isLibrary(value: string): value is StandardLibrary {
  return (STANDARD_LIBRARIES as readonly string[]).includes(value);
}

/** Per library, how many standard rows exist and how many the org holds. Needs org.settings.read. */
export async function getStandardLibraryStatus(
  db: XosClient,
  orgId: string,
): Promise<Result<StandardLibraryCount[]>> {
  const { data, error } = await db.rpc("standard_library_status", { p_org_id: orgId });
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).flatMap((r) =>
      isLibrary(r.library)
        ? [{ library: r.library, standardCount: r.standard_count, adoptedCount: r.adopted_count }]
        : [],
    ),
  );
}

/** True when the org holds a copy of every standard row. */
export function isFullyAdopted(counts: readonly StandardLibraryCount[]): boolean {
  return counts.every((c) => c.adoptedCount >= c.standardCount);
}

export interface AdoptionResult {
  /** Rows copied by this run, per library. */
  readonly copied: Readonly<Record<StandardLibrary, number>>;
  readonly total: number;
}

/** The "Adopt Standard Library" action. Needs canon.extension.write. */
export async function adoptStandardLibrary(
  db: XosClient,
  orgId: string,
): Promise<Result<AdoptionResult>> {
  const { data, error } = await db.rpc("adopt_standard_library", { p_org_id: orgId });
  if (error) return fail(toDataError(error));
  const raw = (data ?? {}) as Record<string, unknown>;
  const copied = Object.fromEntries(
    STANDARD_LIBRARIES.map((l) => [l, typeof raw[l] === "number" ? raw[l] : 0]),
  ) as Record<StandardLibrary, number>;
  return ok({ copied, total: Object.values(copied).reduce((a, b) => a + b, 0) });
}
