import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * The org blocklist of email addresses and domains (B16, migration 3050, ADR 0155 D3; Section 4.8.1). Admins with
 * org.members.manage read and change it in Settings, Members; every new membership whose sign-in address matches a live
 * entry is refused by the database, whatever the path. Adding an entry revokes matching pending invitations and
 * declines matching requests to join; current members are counted, never removed.
 */

export type BlocklistEntryKind = "Email" | "Domain";

export interface BlocklistEntry {
  readonly entryId: string;
  readonly kind: BlocklistEntryKind;
  readonly value: string;
  readonly reason: string | null;
  readonly createdAt: string;
  readonly createdByName: string | null;
  /** Current members whose sign-in address the entry matches. */
  readonly membersMatching: number;
}

export interface BlocklistAdded {
  readonly entryId: string;
  readonly invitesRevoked: number;
  readonly requestsDeclined: number;
  readonly membersMatching: number;
}

/** Refusals of the blocklist and of the joins it refuses, each with its own copy in the memberBlocklist namespace. */
export const BLOCKLIST_REFUSALS = [
  "blocklist_value_invalid",
  "blocklist_own_domain",
  "blocklist_duplicate",
  "blocklist_full",
  "invite_blocked",
  "member_blocked",
] as const;

export type BlocklistRefusal = (typeof BLOCKLIST_REFUSALS)[number];

/** The rule of a refusal when it is one of the blocklist's, else null. */
export function blocklistRefusal(rule: string): BlocklistRefusal | null {
  return (BLOCKLIST_REFUSALS as readonly string[]).includes(rule)
    ? (rule as BlocklistRefusal)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** app.member_blocklist: the org's live entries with who added them and how many current members match. */
export async function listBlocklist(
  db: XosClient,
  orgId: string,
): Promise<Result<BlocklistEntry[]>> {
  const { data, error } = await db.rpc("member_blocklist", { p_org_id: orgId });
  if (error) return fail(toDataError(error));
  return ok(
    (data ?? []).map((r) => ({
      entryId: r.entry_id,
      kind: r.entry_kind === "Domain" ? "Domain" : "Email",
      value: r.entry_value,
      reason: text(r.reason),
      createdAt: r.created_at,
      createdByName: text(r.created_by_name),
      membersMatching: r.members_matching,
    })),
  );
}

/** app.add_blocklist_entry: adds an entry and returns what it revoked, declined and matched. */
export async function addBlocklistEntry(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly kind: BlocklistEntryKind;
    readonly value: string;
    readonly reason?: string | null;
  },
): Promise<Result<BlocklistAdded>> {
  const { data, error } = await db.rpc("add_blocklist_entry", {
    p_org_id: input.orgId,
    p_kind: input.kind,
    p_value: input.value,
    ...(input.reason ? { p_reason: input.reason } : {}),
  });
  if (error) return fail(toDataError(error));
  const row = data[0];
  if (row === undefined) {
    return fail({ kind: "unexpected", message: "add_blocklist_entry returned no row" });
  }
  return ok({
    entryId: row.entry_id,
    invitesRevoked: row.invites_revoked,
    requestsDeclined: row.requests_declined,
    membersMatching: row.members_matching,
  });
}

/** app.remove_blocklist_entry: the address or domain may join again. */
export async function removeBlocklistEntry(db: XosClient, entryId: string): Promise<Result<null>> {
  const { error } = await db.rpc("remove_blocklist_entry", { p_entry_id: entryId });
  return error ? fail(toDataError(error)) : ok(null);
}
