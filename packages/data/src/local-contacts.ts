import type { Database, XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Local contacts (B5, RRR-229, ADR 0144 decision 4; migration 2944): a project's contacts for every day or one day,
 * and a venue's for every project there. A Member row names a membership and is read live (current name, directory
 * work phone); a Contact row carries a typed business phone (E.164) and email. Reads need show.run_of_show.read on the
 * project, or venue read for venue rows; writes need show.day_sheet.write, or places.venue.write for venue rows.
 * Refusals: local_contact_member (not an active member), local_contact_day_outside_project.
 */

type Tables = Database["app"]["Tables"];
type Derived<T> = Omit<T, "org_id">;

export type LocalContactRole = Database["app"]["Enums"]["local_contact_role"];
export const LOCAL_CONTACT_ROLES: readonly LocalContactRole[] = [
  "Promoter",
  "Venue",
  "Production",
  "Security",
  "Transport",
  "Hospitality",
  "Medical",
  "Other",
];
export type LocalContactAudience = Database["app"]["Enums"]["local_contact_audience"];
export const LOCAL_CONTACT_AUDIENCES: readonly LocalContactAudience[] = ["Internal", "Shared"];

export interface LocalContact {
  readonly id: string;
  readonly projectId: string | null;
  readonly venueId: string | null;
  readonly day: string | null;
  readonly role: LocalContactRole;
  readonly title: string | null;
  readonly source: "Member" | "Contact";
  readonly membershipId: string | null;
  readonly displayName: string | null;
  readonly organizationName: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly audience: LocalContactAudience;
  readonly memberActive: boolean;
  readonly notes: string | null;
}

interface ContactRow {
  id: string;
  project_id: string | null;
  venue_id: string | null;
  day: string | null;
  contact_role: LocalContactRole;
  contact_title: string | null;
  source: string | null;
  membership_id: string | null;
  display_name: string | null;
  organization_name: string | null;
  phone: string | null;
  email: string | null;
  audience: LocalContactAudience;
  member_active: boolean | null;
  notes: string | null;
}

const COLUMNS =
  "id, project_id, venue_id, day, contact_role, contact_title, source, membership_id, display_name, organization_name, " +
  "phone, email, audience, member_active, notes";

/** Display order on a day sheet: by role, then name. */
const ROLE_ORDER = new Map(LOCAL_CONTACT_ROLES.map((r, i) => [r, i]));

export function sortLocalContacts<T extends { role: LocalContactRole; displayName: string | null }>(rows: readonly T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      (ROLE_ORDER.get(a.role) ?? 99) - (ROLE_ORDER.get(b.role) ?? 99) ||
      (a.displayName ?? "").localeCompare(b.displayName ?? ""),
  );
}

function toContact(row: ContactRow): LocalContact {
  return {
    id: row.id,
    projectId: row.project_id,
    venueId: row.venue_id,
    day: row.day,
    role: row.contact_role,
    title: row.contact_title,
    source: row.source === "Member" ? "Member" : "Contact",
    membershipId: row.membership_id,
    displayName: row.display_name,
    organizationName: row.organization_name,
    phone: row.phone,
    email: row.email,
    audience: row.audience,
    memberActive: row.member_active !== false,
    notes: row.notes,
  };
}

export interface ProjectContactsOptions {
  /** Include member contacts whose membership has ended (left out by default). */
  readonly includeEnded?: boolean;
}

/**
 * The local contacts listed for a project: its own rows and its venue's. With `day`, only every-day rows and that
 * day's; ended members are left out unless asked for.
 */
export async function listProjectLocalContacts(
  db: XosClient,
  projectId: string,
  day?: string | null,
  options: ProjectContactsOptions = {},
): Promise<Result<LocalContact[]>> {
  let query = db.from("project_local_contacts").select(COLUMNS).eq("project_id", projectId);
  if (day) query = query.or(`day.is.null,day.eq.${day}`);
  if (!options.includeEnded) query = query.eq("member_active", true);
  const { data, error } = await query;
  if (error) return fail(toDataError(error));
  return ok(sortLocalContacts((data as unknown as ContactRow[]).map(toContact)));
}

/** A venue's own rows, as the Places venue peek manages them. Member rows show the current name only. */
export async function listVenueContacts(db: XosClient, venueId: string): Promise<Result<LocalContact[]>> {
  const { data, error } = await db
    .from("local_contacts")
    .select("id, project_id, venue_id, day, contact_role, contact_title, membership_id, contact_name, phone, email, audience, notes")
    .eq("venue_id", venueId)
    .is("deleted_at", null);
  if (error) return fail(toDataError(error));
  const rows = (data ?? []) as unknown as (Omit<ContactRow, "source" | "display_name" | "organization_name" | "member_active"> & {
    contact_name: string | null;
  })[];
  return ok(
    sortLocalContacts(
      rows.map((r) => ({
        id: r.id,
        projectId: r.project_id,
        venueId: r.venue_id,
        day: r.day,
        role: r.contact_role,
        title: r.contact_title,
        source: r.membership_id ? ("Member" as const) : ("Contact" as const),
        membershipId: r.membership_id,
        displayName: r.contact_name,
        organizationName: null,
        phone: r.phone,
        email: r.email,
        audience: r.audience,
        memberActive: true,
        notes: r.notes,
      })),
    ),
  );
}

export type LocalContactHome = { readonly projectId: string; readonly day: string | null } | { readonly venueId: string };

export interface LocalContactInput {
  readonly role: LocalContactRole;
  readonly title: string | null;
  readonly audience: LocalContactAudience;
  readonly notes: string | null;
  /** A member of the org, read live; or a typed contact with its own phone and email. */
  readonly who:
    | { readonly membershipId: string }
    | {
        readonly name: string;
        readonly phone: string | null;
        readonly email: string | null;
        readonly supplierId: string | null;
      };
}

function contactColumns(input: LocalContactInput) {
  const member = "membershipId" in input.who;
  return {
    contact_role: input.role,
    contact_title: input.title,
    audience: input.audience,
    notes: input.notes,
    membership_id: "membershipId" in input.who ? input.who.membershipId : null,
    contact_name: "name" in input.who ? input.who.name : null,
    phone: member || !("phone" in input.who) ? null : input.who.phone,
    email: member || !("email" in input.who) ? null : (input.who.email?.toLowerCase() ?? null),
    counterparty_id: member || !("supplierId" in input.who) ? null : input.who.supplierId,
  };
}

export async function createLocalContact(
  db: XosClient,
  home: LocalContactHome,
  input: LocalContactInput,
): Promise<Result<{ id: string }>> {
  const row: Derived<Tables["local_contacts"]["Insert"]> = {
    ...("venueId" in home ? { venue_id: home.venueId } : { project_id: home.projectId, day: home.day }),
    ...contactColumns(input),
  };
  const { data, error } = await db.from("local_contacts").insert(row as Tables["local_contacts"]["Insert"]).select("id");
  if (error) return fail(toDataError(error));
  const created = data?.[0];
  return created ? ok(created) : fail({ kind: "not-found" });
}

/** Edits a contact; `day` moves a project contact between every day (null) and one day. */
export async function updateLocalContact(
  db: XosClient,
  id: string,
  input: LocalContactInput,
  day?: string | null,
): Promise<Result<null>> {
  const { data, error } = await db
    .from("local_contacts")
    .update({ ...contactColumns(input), ...(day !== undefined ? { day } : {}) })
    .eq("id", id)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 1 ? ok(null) : fail({ kind: "not-found" });
}

export async function deleteLocalContact(db: XosClient, id: string): Promise<Result<null>> {
  const { data, error } = await db
    .from("local_contacts")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 1 ? ok(null) : fail({ kind: "not-found" });
}

/** An E.164 number (+ and 7 to 15 digits, no leading zero), the form tel: links and the database take. */
export const E164 = /^\+[1-9][0-9]{6,14}$/;

/**
 * The E.164 form of a typed phone: spaces, dots, dashes and brackets dropped. Null when it cannot be one, so a
 * call button is offered only for a number that dials.
 */
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const compact = raw.trim().replace(/[\s.()-]/g, "");
  return E164.test(compact) ? compact : null;
}
