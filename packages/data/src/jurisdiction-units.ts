import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * The unit system a project's jurisdiction uses (Section 15: "The unit system follows the project jurisdiction
 * (imperial for US, metric otherwise) with per-user override"): the project's jurisdiction once resolved at
 * gate 1, otherwise its venue's, read from xpms.jurisdiction_resolved, which inherits the country's system.
 * Null when neither is known; callers then follow the person's locale (`resolveUnitSystem`).
 */
export async function getProjectUnitSystem(
  db: XosClient,
  projectId: string,
): Promise<Result<"imperial" | "metric" | null>> {
  const project = await db
    .from("projects")
    .select("jurisdiction_id, venues(jurisdiction_id)")
    .eq("id", projectId)
    .maybeSingle();
  if (project.error) return fail(toDataError(project.error));
  const row = project.data as {
    jurisdiction_id: string | null;
    venues: { jurisdiction_id: string | null } | null;
  } | null;
  const jurisdiction = row?.jurisdiction_id ?? row?.venues?.jurisdiction_id ?? null;
  if (jurisdiction === null) return ok(null);
  const resolved = await db
    .schema("xpms")
    .from("jurisdiction_resolved")
    .select("unit_system")
    .eq("jurisdiction_id", jurisdiction)
    .maybeSingle();
  if (resolved.error) return fail(toDataError(resolved.error));
  const system = (resolved.data as { unit_system: string | null } | null)?.unit_system ?? null;
  return ok(system === "imperial" || system === "metric" ? system : null);
}
