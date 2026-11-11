/**
 * Server reads of the identity settings (ADR 0070), with the person's own session, so row level security returns
 * only their own rows. Each returns the rows the device keeps (src/settings/writes.ts MIRROR), or null when the read
 * failed, and the device keeps what it had.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Row } from "@xos/sync";
import { DEFAULT_ORG_ROW } from "./writes";

function rows(data: unknown): Row[] {
  return Array.isArray(data)
    ? (data as Record<string, unknown>[]).filter((r): r is Row => typeof r["id"] === "string")
    : [];
}

/** The person's profile, created Private with a handle from their name when missing (app.ensure_my_profile). */
export async function readMyProfile(client: SupabaseClient): Promise<Row[] | null> {
  const ensured = await client.rpc("ensure_my_profile");
  if (ensured.error || typeof ensured.data !== "string") return null;
  const { data, error } = await client.from("person_profiles").select("*").eq("id", ensured.data);
  return error ? null : rows(data);
}

/** The person's name: full, given and family (app.people, the columns the person may change). */
export async function readMyPerson(
  client: SupabaseClient,
  personId: string,
): Promise<Row[] | null> {
  const { data, error } = await client
    .from("people")
    .select("id, full_name, given_name, family_name, updated_at")
    .eq("id", personId);
  return error ? null : rows(data);
}

/** The live rows of one of the person's own tables (person_skills, profile_section_visibility and the like). */
export async function readMyRows(
  client: SupabaseClient,
  table: string,
  personId: string,
): Promise<Row[] | null> {
  const { data, error } = await client
    .from(table)
    .select("*")
    .eq("person_id", personId)
    .is("deleted_at", null);
  return error ? null : rows(data);
}

/** The default org as the one device-local row, or none when the person never chose one (app.active_org_selections). */
export async function readDefaultOrgRow(
  client: SupabaseClient,
  userId: string,
): Promise<Row[] | null> {
  const { data, error } = await client
    .from("active_org_selections")
    .select("org_id, selected_at")
    .eq("user_id", userId);
  if (error) return null;
  const row = (Array.isArray(data) ? data : [])[0] as Record<string, unknown> | undefined;
  return row
    ? [{ id: DEFAULT_ORG_ROW, org_id: row["org_id"], selected_at: row["selected_at"] }]
    : [];
}

export interface SkillCategory {
  readonly catUrid: string;
  readonly category: string;
}

/** The canon categories a skill names (xpms.dim_category), by URID. */
export async function readSkillCategories(client: SupabaseClient): Promise<SkillCategory[] | null> {
  const { data, error } = await client
    .schema("xpms")
    .from("dim_category")
    .select("cat_urid, category")
    .order("cat_urid");
  if (error || !Array.isArray(data)) return null;
  return (data as { cat_urid: string; category: string }[]).map((c) => ({
    catUrid: c.cat_urid,
    category: c.category,
  }));
}
