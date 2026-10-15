/**
 * Identity handlers (A30, migrations 0860 and 0861): requests to join, invitation links, person and
 * organization profiles and offboarding checklists. Writes go through the RPCs and policies of
 * those migrations, so the database decides every refusal. See packages/api/README.md.
 */
import type { XosClient } from "@xos/data";
import type { Components } from "../contract/operations.generated.ts";
import { badRequest, notFound, refused } from "../problem.ts";
import { requireOrg, requirePerson } from "../runtime/context.ts";
import { created, defineHandlers, ok } from "../runtime/handler.ts";
import { decodeCursor, pageSize, toPage } from "../runtime/pagination.ts";

type JoinRequest = Components["JoinRequest"];
type InvitationLink = Components["InvitationLink"];
type PersonProfile = Components["PersonProfile"];
type OrganizationProfile = Components["OrganizationProfile"];
type OffboardingChecklist = Components["OffboardingChecklist"];
type OrgRole = Exclude<Components["OrgRole"], null>;

const ROLE_CODES: Readonly<Record<OrgRole, string>> = {
  Owner: "owner",
  Admin: "admin",
  Manager: "manager",
  Member: "member",
  Collaborator: "collaborator",
  Field: "field",
  Viewer: "viewer",
};

function audit(row: { created_by: string | null; updated_by: string | null }): {
  created_by: string;
  updated_by: string;
} {
  return { created_by: row.created_by ?? "", updated_by: row.updated_by ?? "" };
}

function cursorAfter(cursor: string | undefined): string | undefined {
  return cursor === undefined ? undefined : String(decodeCursor(cursor, ["id"])["id"]);
}

// Join requests ------------------------------------------------------------------------------------

const JOIN_COLUMNS =
  "id, org_id, created_at, created_by, updated_at, updated_by, person_id, message, join_request_state, decided_by";

interface JoinRow {
  id: string;
  org_id: string;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  updated_by: string | null;
  person_id: string;
  message: string | null;
  join_request_state: string;
  decided_by: string | null;
}

function toJoinRequest(row: JoinRow): JoinRequest {
  return {
    id: row.id,
    org_id: row.org_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...audit(row),
    person_id: row.person_id,
    message: row.message,
    join_request_state: row.join_request_state,
    decided_by: row.decided_by,
  };
}

async function readJoinRequest(db: XosClient, id: string): Promise<JoinRow> {
  const { data, error } = await db
    .from("join_requests")
    .select(JOIN_COLUMNS)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error !== null) throw error;
  if (data === null) throw notFound("No join request with this identifier is visible to you.");
  return data as JoinRow;
}

// Invitation links -----------------------------------------------------------------------------------

const LINK_COLUMNS =
  "id, org_id, created_at, created_by, updated_at, updated_by, expires_at, max_uses, revoked_at, role:roles(code, band)";

interface LinkRow {
  id: string;
  org_id: string;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  updated_by: string | null;
  expires_at: string;
  max_uses: number;
  revoked_at: string | null;
  role: { code: string; band: number } | null;
}

function toInvitationLink(row: LinkRow): InvitationLink {
  const role =
    (Object.entries(ROLE_CODES).find(([, code]) => code === row.role?.code)?.[0] as
      OrgRole | undefined) ?? null;
  return {
    id: row.id,
    org_id: row.org_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...audit(row),
    role,
    expires_at: row.expires_at,
    max_uses: row.max_uses,
    revoked_at: row.revoked_at,
  };
}

async function readLink(db: XosClient, id: string): Promise<LinkRow> {
  const { data, error } = await db
    .from("invite_links")
    .select(LINK_COLUMNS)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error !== null) throw error;
  if (data === null) throw notFound("No invitation link with this identifier is visible to you.");
  return data as unknown as LinkRow;
}

async function systemRoleId(db: XosClient, role: OrgRole): Promise<string> {
  const { data, error } = await db
    .from("roles")
    .select("id")
    .is("org_id", null)
    .eq("code", ROLE_CODES[role])
    .maybeSingle();
  if (error !== null) throw error;
  if (data === null) throw badRequest(`Unknown role ${role}.`);
  return data.id;
}

// Profiles -----------------------------------------------------------------------------------------

const PERSON_COLUMNS =
  "id, created_at, updated_at, person_id, headline, bio, pronouns, city, country_code, visibility, search_indexing";

interface PersonRow {
  id: string;
  created_at: string;
  updated_at: string;
  person_id: string;
  headline: string | null;
  bio: string | null;
  pronouns: string | null;
  city: string | null;
  country_code: string | null;
  visibility: Components["ProfileVisibility"];
  search_indexing: boolean;
}

function toPersonProfile(row: PersonRow): PersonProfile {
  return {
    id: row.id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    person_id: row.person_id,
    headline: row.headline,
    bio: row.bio,
    pronouns: row.pronouns,
    locality: row.city,
    country: row.country_code,
    visibility: row.visibility,
    search_indexing: row.search_indexing,
  };
}

async function readPersonProfile(db: XosClient, id: string): Promise<PersonRow> {
  const { data, error } = await db
    .from("person_profiles")
    .select(PERSON_COLUMNS)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error !== null) throw error;
  if (data === null) throw notFound("No profile with this identifier is visible to you.");
  return data as PersonRow;
}

const ORG_PROFILE_COLUMNS =
  "id, created_at, updated_at, org_id, about, visibility, search_indexing";

interface OrgProfileRow {
  id: string;
  created_at: string;
  updated_at: string;
  org_id: string;
  about: string | null;
  visibility: Components["ProfileVisibility"];
  search_indexing: boolean;
}

function toOrganizationProfile(row: OrgProfileRow): OrganizationProfile {
  return {
    id: row.id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    organization_id: row.org_id,
    about: row.about,
    visibility: row.visibility,
    search_indexing: row.search_indexing,
  };
}

async function readOrgProfile(db: XosClient, id: string): Promise<OrgProfileRow> {
  const { data, error } = await db
    .from("organization_profiles")
    .select(ORG_PROFILE_COLUMNS)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error !== null) throw error;
  if (data === null)
    throw notFound("No organization profile with this identifier is visible to you.");
  return data as OrgProfileRow;
}

// Offboarding ---------------------------------------------------------------------------------------

const OFFBOARDING_COLUMNS =
  "id, org_id, created_at, created_by, updated_at, updated_by, membership_id, completed_at";

interface OffboardingRow {
  id: string;
  org_id: string;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  updated_by: string | null;
  membership_id: string;
  completed_at: string | null;
}

async function openRecordCounts(
  db: XosClient,
  ids: readonly string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (ids.length === 0) return counts;
  const { data, error } = await db
    .from("offboarding_open_records")
    .select("offboarding_id")
    .in("offboarding_id", [...ids]);
  if (error !== null) throw error;
  for (const row of data) {
    if (row.offboarding_id)
      counts.set(row.offboarding_id, (counts.get(row.offboarding_id) ?? 0) + 1);
  }
  return counts;
}

function toChecklist(
  row: OffboardingRow,
  counts: Map<string, number>,
  reassignTo: string | null = null,
): OffboardingChecklist {
  return {
    id: row.id,
    org_id: row.org_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...audit(row),
    membership_id: row.membership_id,
    reassign_to_person_id: reassignTo,
    open_record_count: counts.get(row.id) ?? 0,
    completed_at: row.completed_at,
  };
}

async function readOffboarding(db: XosClient, id: string): Promise<OffboardingRow> {
  const { data, error } = await db
    .from("offboardings")
    .select(OFFBOARDING_COLUMNS)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error !== null) throw error;
  if (data === null)
    throw notFound("No offboarding checklist with this identifier is visible to you.");
  return data as OffboardingRow;
}

export const handlers = defineHandlers("Identity", {
  "joinRequests.list": async ({ query }, context) => {
    const org = requireOrg(context);
    const size = pageSize(query.limit);
    let request = context.db
      .from("join_requests")
      .select(JOIN_COLUMNS)
      .eq("org_id", org.id)
      .is("deleted_at", null)
      .order("id", { ascending: true })
      .limit(size + 1);
    const after = cursorAfter(query.cursor);
    if (after !== undefined) request = request.gt("id", after);
    const { data, error } = await request;
    if (error !== null) throw error;
    return ok(toPage((data as JoinRow[]).map(toJoinRequest), size, (row) => ({ id: row.id })));
  },

  "joinRequests.get": async ({ params }, { db }) =>
    ok(toJoinRequest(await readJoinRequest(db, params.id))),

  "joinRequests.create": async ({ body }, context) => {
    const org = requireOrg(context);
    const person = requirePerson(context);
    if (body.person_id !== person) {
      throw refused("REFUSE", "A person asks to join for themselves only.", "join_request_self");
    }
    const { data, error } = await context.db.rpc("request_to_join", {
      p_org_id: org.id,
      ...(body.message ? { p_message: body.message } : {}),
    });
    if (error !== null) throw error;
    return created(toJoinRequest(await readJoinRequest(context.db, data)));
  },

  "joinRequests.approve": async ({ params }, { db }) => {
    const { error } = await db.rpc("decide_join_request", {
      p_join_request_id: params.id,
      p_approve: true,
      p_role_id: await systemRoleId(db, "Member"),
    });
    if (error !== null) throw error;
    return ok(toJoinRequest(await readJoinRequest(db, params.id)));
  },

  "joinRequests.decline": async ({ params }, { db }) => {
    const { error } = await db.rpc("decide_join_request", {
      p_join_request_id: params.id,
      p_approve: false,
    });
    if (error !== null) throw error;
    return ok(toJoinRequest(await readJoinRequest(db, params.id)));
  },

  "invitationLinks.list": async ({ query }, context) => {
    const org = requireOrg(context);
    const size = pageSize(query.limit);
    let request = context.db
      .from("invite_links")
      .select(LINK_COLUMNS)
      .eq("org_id", org.id)
      .is("deleted_at", null)
      .order("id", { ascending: true })
      .limit(size + 1);
    const after = cursorAfter(query.cursor);
    if (after !== undefined) request = request.gt("id", after);
    const { data, error } = await request;
    if (error !== null) throw error;
    const rows = (data as unknown as LinkRow[]).map(toInvitationLink);
    return ok(toPage(rows, size, (row) => ({ id: row.id })));
  },

  "invitationLinks.get": async ({ params }, { db }) =>
    ok(toInvitationLink(await readLink(db, params.id))),

  "invitationLinks.create": async ({ body }, context) => {
    const org = requireOrg(context);
    if (body.role === null) throw badRequest("Name the role the link gives.");
    const hours = Math.round((Date.parse(body.expires_at) - Date.now()) / 3_600_000);
    if (!Number.isFinite(hours)) throw badRequest("expires_at must be a date-time.");
    const { data, error } = await context.db
      .rpc("create_invite_link", {
        p_org_id: org.id,
        p_role_id: await systemRoleId(context.db, body.role),
        p_valid_for: `${hours} hours`,
        p_max_uses: body.max_uses ?? 25,
      })
      .single();
    if (error !== null) throw error;
    // The token is shown once, in a header, because the resource never stores it.
    return created(toInvitationLink(await readLink(context.db, data.invite_link_id)), {
      "X-Invitation-Token": data.invite_token,
    });
  },

  "invitationLinks.revoke": async ({ params }, { db }) => {
    const { error } = await db.rpc("revoke_invite_link", { p_invite_link_id: params.id });
    if (error !== null) throw error;
    return ok(toInvitationLink(await readLink(db, params.id)));
  },

  "personProfiles.list": async ({ query }, { db }) => {
    const size = pageSize(query.limit);
    let request = db
      .from("person_profiles")
      .select(PERSON_COLUMNS)
      .is("deleted_at", null)
      .order("id", { ascending: true })
      .limit(size + 1);
    const after = cursorAfter(query.cursor);
    if (after !== undefined) request = request.gt("id", after);
    const { data, error } = await request;
    if (error !== null) throw error;
    return ok(toPage((data as PersonRow[]).map(toPersonProfile), size, (row) => ({ id: row.id })));
  },

  "personProfiles.get": async ({ params }, { db }) =>
    ok(toPersonProfile(await readPersonProfile(db, params.id))),

  "personProfiles.create": async (_request, context) => {
    requirePerson(context);
    const { data, error } = await context.db.rpc("ensure_my_profile");
    if (error !== null) throw error;
    return created(toPersonProfile(await readPersonProfile(context.db, data)));
  },

  "personProfiles.update": async ({ params, body }, { db }) => {
    await readPersonProfile(db, params.id);
    const { error } = await db
      .from("person_profiles")
      .update({
        ...(body.headline !== undefined ? { headline: body.headline } : {}),
        ...(body.bio !== undefined ? { bio: body.bio } : {}),
        ...(body.pronouns !== undefined ? { pronouns: body.pronouns } : {}),
        ...(body.locality !== undefined ? { city: body.locality } : {}),
        ...(body.country !== undefined ? { country_code: body.country } : {}),
        ...(body.visibility !== undefined ? { visibility: body.visibility } : {}),
        ...(body.search_indexing !== undefined ? { search_indexing: body.search_indexing } : {}),
      })
      .eq("id", params.id);
    if (error !== null) throw error;
    return ok(toPersonProfile(await readPersonProfile(db, params.id)));
  },

  "organizationProfiles.list": async ({ query }, { db }) => {
    const size = pageSize(query.limit);
    let request = db
      .from("organization_profiles")
      .select(ORG_PROFILE_COLUMNS)
      .is("deleted_at", null)
      .order("id", { ascending: true })
      .limit(size + 1);
    const after = cursorAfter(query.cursor);
    if (after !== undefined) request = request.gt("id", after);
    const { data, error } = await request;
    if (error !== null) throw error;
    const rows = (data as OrgProfileRow[]).map(toOrganizationProfile);
    return ok(toPage(rows, size, (row) => ({ id: row.id })));
  },

  "organizationProfiles.get": async ({ params }, { db }) =>
    ok(toOrganizationProfile(await readOrgProfile(db, params.id))),

  "organizationProfiles.create": async (_request, context) => {
    const org = requireOrg(context);
    const { data, error } = await context.db.rpc("ensure_organization_profile", {
      p_org_id: org.id,
    });
    if (error !== null) throw error;
    return created(toOrganizationProfile(await readOrgProfile(context.db, data)));
  },

  "organizationProfiles.update": async ({ params, body }, { db }) => {
    await readOrgProfile(db, params.id);
    const { data, error } = await db
      .from("organization_profiles")
      .update({
        ...(body.about !== undefined ? { about: body.about } : {}),
        ...(body.visibility !== undefined ? { visibility: body.visibility } : {}),
        ...(body.search_indexing !== undefined ? { search_indexing: body.search_indexing } : {}),
      })
      .eq("id", params.id)
      .select("id");
    if (error !== null) throw error;
    if (data.length === 0)
      throw notFound("No organization profile you may edit has this identifier.");
    return ok(toOrganizationProfile(await readOrgProfile(db, params.id)));
  },

  "offboardingChecklists.list": async ({ query }, context) => {
    const org = requireOrg(context);
    const size = pageSize(query.limit);
    let request = context.db
      .from("offboardings")
      .select(OFFBOARDING_COLUMNS)
      .eq("org_id", org.id)
      .is("deleted_at", null)
      .order("id", { ascending: true })
      .limit(size + 1);
    const after = cursorAfter(query.cursor);
    if (after !== undefined) request = request.gt("id", after);
    const { data, error } = await request;
    if (error !== null) throw error;
    const rows = data as OffboardingRow[];
    const counts = await openRecordCounts(
      context.db,
      rows.map((r) => r.id),
    );
    return ok(
      toPage(
        rows.map((r) => toChecklist(r, counts)),
        size,
        (row) => ({ id: row.id }),
      ),
    );
  },

  "offboardingChecklists.get": async ({ params }, { db }) => {
    const row = await readOffboarding(db, params.id);
    return ok(toChecklist(row, await openRecordCounts(db, [row.id])));
  },

  "offboardingChecklists.update": async ({ params, body }, { db }) => {
    const row = await readOffboarding(db, params.id);
    const to = body.reassign_to_person_id ?? null;
    if (to !== null) {
      const { error } = await db.rpc("reassign_offboarding_records", {
        p_offboarding_id: row.id,
        p_to_person_id: to,
      });
      if (error !== null) throw error;
    }
    return ok(
      toChecklist(await readOffboarding(db, row.id), await openRecordCounts(db, [row.id]), to),
    );
  },
});
