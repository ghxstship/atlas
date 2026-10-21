import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * A person's hover card (Section 11.7): who they are in the org at a glance, read as the viewer, so
 * row level security decides what shows. A person the viewer cannot see reads as not found.
 */
export interface PersonCard {
  readonly personId: string;
  readonly name: string | null;
  /** The best role the person holds in the org (lowest band), by name. */
  readonly role: string | null;
  /** When their membership began, as an ISO timestamp. */
  readonly memberSince: string | null;
  /** Records they own that are not Complete or Canceled, among those the viewer can read. */
  readonly openRecords: number;
}

interface MembershipRow {
  readonly valid_from: string | null;
  readonly person: { readonly full_name: string | null } | null;
  readonly membership_roles: readonly {
    readonly deleted_at: string | null;
    readonly role: { readonly name: string | null; readonly band: number } | null;
  }[];
}

export async function getPersonCard(
  db: XosClient,
  orgId: string,
  personId: string,
): Promise<Result<PersonCard>> {
  const [membership, records] = await Promise.all([
    db
      .from("memberships")
      .select(
        "valid_from, person:people!memberships_person_id_fkey(full_name), membership_roles(deleted_at, role:roles(name, band))",
      )
      .eq("org_id", orgId)
      .eq("person_id", personId)
      .is("deleted_at", null)
      .order("valid_from", { ascending: true })
      .limit(1)
      .maybeSingle(),
    db
      .from("records")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("owner_party_id", personId)
      .is("deleted_at", null)
      .not("record_state", "in", "(Complete,Canceled)"),
  ]);
  if (membership.error) return fail(toDataError(membership.error));
  if (records.error) return fail(toDataError(records.error));
  const row = membership.data as unknown as MembershipRow | null;
  if (!row) return fail({ kind: "not-found" });
  const best = row.membership_roles
    .flatMap((m) => (m.deleted_at === null && m.role ? [m.role] : []))
    .sort((a, b) => a.band - b.band)[0];
  return ok({
    personId,
    name: row.person?.full_name ?? null,
    role: best?.name ?? null,
    memberSince: row.valid_from,
    openRecords: records.count ?? 0,
  });
}
