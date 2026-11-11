/**
 * Writes from the identity settings that queue offline (ADR 0070). Compass keeps the person's own rows in
 * device-local tables (names starting with "_", which no scope change purges and sign-out wipes): the profile, the
 * name and the profile lists, read online with the person's session and shown from the device afterwards. A change
 * queues as an ordinary insert or update of the server table, which owner-only row level security admits (0205,
 * 0860, 1340), and lays its optimistic row on the device copy at once. A profile or name update merges with edits
 * made elsewhere; a list insert carries its own id, so a retry is the same row.
 *
 * What needs the server's answer at once never queues: leaving an organization or a company account, sharing,
 * security changes, and account deletion. Their controls are disabled offline.
 */
import { uuidv7, type Mutation, type MutationInput, type Row } from "@xos/sync";
import type { Visibility } from "./forms";

/** The device-local copies of the person's own rows. */
export const MIRROR = {
  profile: "_me_profile",
  person: "_me_person",
  skills: "_me_person_skills",
  languages: "_me_person_languages",
  links: "_me_person_links",
  certifications: "_me_person_certifications",
  sections: "_me_profile_section_visibility",
  defaultOrg: "_me_default_org",
} as const;

/** When each device copy was last read from the server, by its table name (device-local too). */
export const MIRROR_READS = "_me_reads";

export type ProfileList = "skills" | "languages" | "links" | "certifications";

/** The server table of each profile list (app.person_*, owner-only, soft delete). */
export const LIST_TABLE: Readonly<Record<ProfileList, string>> = {
  skills: "person_skills",
  languages: "person_languages",
  links: "person_links",
  certifications: "person_certifications",
};

/** A row the person has not removed (soft delete leaves deleted_at set). */
export function isLive(row: Readonly<Record<string, unknown>>): boolean {
  return row["deleted_at"] === null || row["deleted_at"] === undefined;
}

/** The row id of the one device-local row that records the default org. */
export const DEFAULT_ORG_ROW = "default";

/** An update of the person's profile (app.person_profiles), with only the columns that changed. */
export function profileUpdate(row: Row, changes: Readonly<Record<string, unknown>>): MutationInput {
  return {
    op: "update",
    target: "person_profiles",
    table: MIRROR.profile,
    rowId: row.id,
    payload: { ...changes },
    policy: "merge",
    optimistic: { ...row, ...changes },
  };
}

/** An update of the person's name (app.people: full_name, given_name and family_name only). */
export function personUpdate(row: Row, changes: Readonly<Record<string, unknown>>): MutationInput {
  return {
    op: "update",
    target: "people",
    table: MIRROR.person,
    rowId: row.id,
    payload: { ...changes },
    policy: "merge",
    optimistic: { ...row, ...changes },
  };
}

/** A new row in one of the person's profile lists, with its own id. */
export function listInsert(
  list: ProfileList,
  personId: string,
  fields: Readonly<Record<string, unknown>>,
  nowMs: number,
  newId: (ms: number) => string = uuidv7,
): MutationInput {
  const id = newId(nowMs);
  const payload = { id, person_id: personId, ...fields };
  return {
    op: "insert",
    target: LIST_TABLE[list],
    table: MIRROR[list],
    rowId: id,
    payload,
    policy: "append",
    optimistic: { ...payload, deleted_at: null },
  };
}

/** Removes a row from a profile list: the owner's soft delete (removeProfileItem in @xos/data/profiles). */
export function listRemove(list: ProfileList, row: Row, nowIso: string): MutationInput {
  return {
    op: "update",
    target: LIST_TABLE[list],
    table: MIRROR[list],
    rowId: row.id,
    payload: { deleted_at: nowIso },
    policy: "append",
    optimistic: { ...row, deleted_at: nowIso },
  };
}

/**
 * One section's visibility (app.profile_section_visibility): a section can be narrower than the profile, never
 * wider. "inherit" clears the entry, so the section follows the profile. Null when nothing changes.
 */
export function sectionVisibilityWrite(
  personId: string,
  section: string,
  value: Visibility | "inherit",
  existing: Row | undefined,
  nowMs: number,
  newId: (ms: number) => string = uuidv7,
): MutationInput | null {
  const live = existing && isLive(existing) ? existing : undefined;
  if (value === "inherit") {
    if (!live) return null;
    const deletedAt = new Date(nowMs).toISOString();
    return {
      op: "update",
      target: "profile_section_visibility",
      table: MIRROR.sections,
      rowId: live.id,
      payload: { deleted_at: deletedAt },
      policy: "append",
      optimistic: { ...live, deleted_at: deletedAt },
    };
  }
  if (live) {
    if (live["visibility"] === value) return null;
    return {
      op: "update",
      target: "profile_section_visibility",
      table: MIRROR.sections,
      rowId: live.id,
      payload: { visibility: value },
      policy: "merge",
      optimistic: { ...live, visibility: value },
    };
  }
  const id = newId(nowMs);
  const payload = { id, person_id: personId, section, visibility: value };
  return {
    op: "insert",
    target: "profile_section_visibility",
    table: MIRROR.sections,
    rowId: id,
    payload,
    policy: "append",
    optimistic: { ...payload, deleted_at: null },
  };
}

/**
 * The default org (Section 4.5.6 item 5): app.set_active_org records it for the sign-in, the org the access token,
 * the public API and account notices follow (0920), and the org Compass opens on a device that has not chosen one.
 * Setting it twice is the same as once, so it queues as a plain RPC.
 */
export function defaultOrgWrite(orgId: string, nowIso: string): MutationInput {
  return {
    op: "rpc",
    target: "set_active_org",
    table: MIRROR.defaultOrg,
    rowId: DEFAULT_ORG_ROW,
    payload: { p_org_id: orgId },
    policy: "append",
    optimistic: { id: DEFAULT_ORG_ROW, org_id: orgId, selected_at: nowIso },
  };
}

/**
 * The rows a fresh server read leaves on the device: the server's rows, and any device row a queued write still
 * owns (an insert not sent yet, or a change waiting for its answer), so a read never drops a change in flight.
 */
export function mirrorRows(
  table: string,
  server: readonly Row[],
  device: readonly Row[],
  queued: readonly Pick<Mutation, "table" | "rowId">[],
): Row[] {
  const owned = new Set(queued.filter((m) => m.table === table).map((m) => m.rowId));
  const kept = device.filter((row) => owned.has(row.id));
  const keptIds = new Set(kept.map((row) => row.id));
  return [...server.filter((row) => !keptIds.has(row.id)), ...kept];
}

/** Where a saved change stands. */
export type WriteState =
  | { readonly kind: "idle" }
  | { readonly kind: "sending" }
  | { readonly kind: "queued" }
  | { readonly kind: "saved" }
  | {
      readonly kind: "refused";
      readonly rule: string | null;
      readonly code: string;
      readonly message: string;
    };

/** The rule a refusal names ("handle_taken: ..."), or for a unique value already in use, "conflict". */
export function refusalRule(error: {
  readonly code: string;
  readonly message: string;
}): string | null {
  if (error.code === "23505") return "conflict";
  const rule = /^([a-z][a-z0-9_]*):\s/.exec(error.message)?.[1];
  return rule ?? null;
}

/**
 * The state of a queued change from the outbox: gone means the server took it (or the person discarded it in the
 * offline queue); a conflict means the server refused it; still pending means it waits for a connection or is on
 * its way.
 */
export function writeStateOf(mutation: Mutation | undefined, online: boolean): WriteState {
  if (!mutation) return { kind: "saved" };
  if (mutation.status === "conflict") {
    const error = mutation.lastError ?? { code: "", message: "" };
    return { kind: "refused", rule: refusalRule(error), code: error.code, message: error.message };
  }
  return online ? { kind: "sending" } : { kind: "queued" };
}
