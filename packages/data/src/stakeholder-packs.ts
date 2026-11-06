import type { SupabaseClient } from "@supabase/supabase-js";
import type { XosClient } from "./client.ts";
import type { DatabaseErrorLike } from "./result.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";
import type { ReportEmail, ReportMailer } from "./report-deliveries.ts";

/**
 * Stakeholder packs (B2, ADR 0141; migrations 2910 to 2913): a named bundle of a project's live links
 * and Public or Internal files for people outside the org. Each recipient has an access code given out
 * of band and gets an emailed sign-in link that lasts 7 days; a correct code earns a device grant.
 *
 * - Members manage packs with the signed-in client; the database decides who may, and the code comes
 *   back once.
 * - The anonymous page opens a link ({@link openStakeholderPack}) and reads with its grants
 *   ({@link readStakeholderPack} and the rest) through a cookie-less anonymous client.
 * - {@link runPackDeliveries} is the pack.deliver worker, shaped as runReportDeliveries: claim, mint,
 *   send, finish. A failed send revokes its link; a retry mints a new one. The email never carries
 *   the access code and never a report file (ADR 0029 item 6 stays true).
 */

export const PACK_LINK_TOKEN = /^xpkl_[0-9a-f]{64}$/;
export const PACK_GRANT = /^xpkg_[0-9a-f]{64}$/;
export const PACK_UNSUBSCRIBE_TOKEN = /^xpku_[0-9a-f]{64}$/;

/** The most grants the cookie keeps; the RPCs read the same 8, newest first. */
export const MAX_PACK_GRANTS = 8;

/** The longest a pack may last, in days (the RPCs enforce the same). */
export const MAX_PACK_DAYS = 90;

export function packPath(token: string): string {
  return `/share/pack/${token}`;
}

export function packUnsubscribePath(token: string): string {
  return `/share/pack/unsubscribe/${token}`;
}

// Refusals ---------------------------------------------------------------------------------------

export const PACK_REFUSALS = [
  "pack_link_invalid",
  "pack_link_rate_limited",
  "pack_link_expired",
  "pack_revoked",
  "pack_recipient_revoked",
  "pack_locked",
  "pack_access_code_required",
  "pack_access_code",
  "pack_grant",
  "pack_item_unavailable",
  "pack_item_not_acknowledgeable",
  "pack_signer_name",
  "already_signed",
] as const;

export type PackRefusal = (typeof PACK_REFUSALS)[number];

export function parsePackRefusal(reason: unknown): PackRefusal {
  return (PACK_REFUSALS as readonly unknown[]).includes(reason)
    ? (reason as PackRefusal)
    : "pack_link_invalid";
}

/** True for a refusal the access code form answers (no grant yet, or a wrong code). */
export function packAsksForCode(reason: PackRefusal): boolean {
  return (
    reason === "pack_grant" ||
    reason === "pack_access_code_required" ||
    reason === "pack_access_code"
  );
}

export type PackRefused = { readonly refused: true; readonly reason: PackRefusal };

// The grant cookie ---------------------------------------------------------------------------------

/** The grants a cookie holds: space-separated, newest first, only well-formed ones, at most 8. */
export function parsePackGrants(cookie: string | null | undefined): string[] {
  return (cookie ?? "")
    .split(" ")
    .filter((g) => PACK_GRANT.test(g))
    .slice(0, MAX_PACK_GRANTS);
}

/** The cookie's value after a new grant: the new one first, then the others, at most 8. */
export function addPackGrant(cookie: string | null | undefined, grant: string): string {
  return [grant, ...parsePackGrants(cookie).filter((g) => g !== grant)]
    .slice(0, MAX_PACK_GRANTS)
    .join(" ");
}

// Managing packs (signed in) -----------------------------------------------------------------------

export interface PackSummary {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly message: string | null;
  readonly note: string | null;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly createdAt: string;
}

const PACK_COLUMNS = "id, project_id, name, message, note, expires_at, revoked_at, created_at";

interface PackRow {
  id: string;
  project_id: string;
  name: string;
  message: string | null;
  note: string | null;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
}

function toPack(r: PackRow): PackSummary {
  return {
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    message: r.message,
    note: r.note,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
    createdAt: r.created_at,
  };
}

export async function listStakeholderPacks(
  db: XosClient,
  projectId: string,
): Promise<Result<PackSummary[]>> {
  const { data, error } = await db
    .from("stakeholder_packs")
    .select(PACK_COLUMNS)
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (error) return fail(toDataError(error));
  return ok(((data ?? []) as unknown as PackRow[]).map(toPack));
}

export async function createStakeholderPack(
  db: XosClient,
  input: {
    readonly projectId: string;
    readonly name: string;
    readonly expiresAt: string;
    readonly message: string | null;
    readonly note: string | null;
  },
): Promise<Result<string>> {
  const { data, error } = await db.rpc("create_stakeholder_pack", {
    p_project_id: input.projectId,
    p_name: input.name,
    p_expires_at: input.expiresAt,
    ...(input.message === null ? {} : { p_message: input.message }),
    ...(input.note === null ? {} : { p_note: input.note }),
  });
  if (error) return fail(toDataError(error));
  return ok(String(data));
}

export async function updateStakeholderPack(
  db: XosClient,
  input: {
    readonly id: string;
    readonly name: string;
    readonly expiresAt: string;
    readonly message: string | null;
    readonly note: string | null;
  },
): Promise<Result<void>> {
  const { error } = await db.rpc("update_stakeholder_pack", {
    p_pack_id: input.id,
    p_name: input.name,
    p_message: input.message ?? "",
    p_note: input.note ?? "",
    p_expires_at: input.expiresAt,
  });
  if (error) return fail(toDataError(error));
  return ok(undefined);
}

export async function revokeStakeholderPack(db: XosClient, id: string): Promise<Result<string>> {
  const { data, error } = await db.rpc("revoke_stakeholder_pack", { p_pack_id: id });
  if (error) return fail(toDataError(error));
  return ok(String(data));
}

export interface PackItem {
  readonly id: string;
  readonly kind: "Live Link" | "File";
  readonly liveLinkId: string | null;
  readonly attachmentId: string | null;
  readonly title: string;
  readonly position: number;
  readonly requiresAcknowledgement: boolean;
}

export async function listPackItems(db: XosClient, packId: string): Promise<Result<PackItem[]>> {
  const { data, error } = await db
    .from("stakeholder_pack_items")
    .select("id, item_kind, live_link_id, attachment_id, title, position, requires_acknowledgement")
    .eq("stakeholder_pack_id", packId)
    .is("deleted_at", null)
    .order("position");
  if (error) return fail(toDataError(error));
  const rows = (data ?? []) as unknown as {
    id: string;
    item_kind: PackItem["kind"];
    live_link_id: string | null;
    attachment_id: string | null;
    title: string;
    position: number;
    requires_acknowledgement: boolean;
  }[];
  return ok(
    rows.map((r) => ({
      id: r.id,
      kind: r.item_kind,
      liveLinkId: r.live_link_id,
      attachmentId: r.attachment_id,
      title: r.title,
      position: r.position,
      requiresAcknowledgement: r.requires_acknowledgement,
    })),
  );
}

export async function addPackItem(
  db: XosClient,
  input: {
    readonly packId: string;
    readonly subject: { readonly liveLinkId: string } | { readonly attachmentId: string };
    readonly title: string;
    readonly requiresAcknowledgement: boolean;
  },
): Promise<Result<string>> {
  const { data, error } = await db.rpc("add_stakeholder_pack_item", {
    p_pack_id: input.packId,
    ...("liveLinkId" in input.subject
      ? { p_live_link_id: input.subject.liveLinkId }
      : { p_attachment_id: input.subject.attachmentId }),
    p_title: input.title,
    p_requires_acknowledgement: input.requiresAcknowledgement,
  });
  if (error) return fail(toDataError(error));
  return ok(String(data));
}

export async function removePackItem(db: XosClient, id: string): Promise<Result<void>> {
  const { error } = await db.rpc("remove_stakeholder_pack_item", { p_item_id: id });
  if (error) return fail(toDataError(error));
  return ok(undefined);
}

export async function orderPackItems(
  db: XosClient,
  packId: string,
  itemIds: readonly string[],
): Promise<Result<void>> {
  const { error } = await db.rpc("order_stakeholder_pack_items", {
    p_pack_id: packId,
    p_item_ids: [...itemIds],
  });
  if (error) return fail(toDataError(error));
  return ok(undefined);
}

export interface PackRecipient {
  readonly id: string;
  readonly fullName: string;
  readonly email: string;
  readonly counterpartyId: string | null;
  readonly label: string | null;
  readonly failedAttempts: number;
  readonly unsubscribedAt: string | null;
  readonly revokedAt: string | null;
}

export interface PackRecipientActivity {
  readonly recipientId: string;
  readonly lastSentAt: string | null;
  readonly opens: number;
  readonly firstOpenedAt: string | null;
  readonly lastOpenedAt: string | null;
  readonly itemsViewed: number;
  readonly downloads: number;
  readonly signatures: number;
}

export async function listPackRecipients(
  db: XosClient,
  packId: string,
): Promise<Result<PackRecipient[]>> {
  const { data, error } = await db
    .from("stakeholder_pack_recipients")
    .select(
      "id, full_name, email, counterparty_id, label, failed_attempts, unsubscribed_at, revoked_at",
    )
    .eq("stakeholder_pack_id", packId)
    .is("deleted_at", null)
    .order("created_at");
  if (error) return fail(toDataError(error));
  const rows = (data ?? []) as unknown as {
    id: string;
    full_name: string;
    email: string;
    counterparty_id: string | null;
    label: string | null;
    failed_attempts: number;
    unsubscribed_at: string | null;
    revoked_at: string | null;
  }[];
  return ok(
    rows.map((r) => ({
      id: r.id,
      fullName: r.full_name,
      email: r.email,
      counterpartyId: r.counterparty_id,
      label: r.label,
      failedAttempts: r.failed_attempts,
      unsubscribedAt: r.unsubscribed_at,
      revokedAt: r.revoked_at,
    })),
  );
}

export async function listPackActivity(
  db: XosClient,
  packId: string,
): Promise<Result<PackRecipientActivity[]>> {
  const { data, error } = await db
    .from("stakeholder_pack_recipient_activity")
    .select(
      "recipient_id, last_sent_at, opens, first_opened_at, last_opened_at, items_viewed, downloads, signatures",
    )
    .eq("stakeholder_pack_id", packId);
  if (error) return fail(toDataError(error));
  const rows = (data ?? []) as unknown as {
    recipient_id: string;
    last_sent_at: string | null;
    opens: number;
    first_opened_at: string | null;
    last_opened_at: string | null;
    items_viewed: number;
    downloads: number;
    signatures: number;
  }[];
  return ok(
    rows.map((r) => ({
      recipientId: r.recipient_id,
      lastSentAt: r.last_sent_at,
      opens: r.opens,
      firstOpenedAt: r.first_opened_at,
      lastOpenedAt: r.last_opened_at,
      itemsViewed: r.items_viewed,
      downloads: r.downloads,
      signatures: r.signatures,
    })),
  );
}

/** Acknowledgements with the name typed and when, for the Activity grid. */
export interface PackSignature {
  readonly recipientId: string;
  readonly itemId: string;
  readonly signerName: string;
  readonly occurredAt: string;
}

export async function listPackSignatures(
  db: XosClient,
  packId: string,
): Promise<Result<PackSignature[]>> {
  const { data, error } = await db
    .from("stakeholder_pack_events")
    .select("recipient_id, item_id, signer_name, occurred_at")
    .eq("stakeholder_pack_id", packId)
    .eq("action", "Signed")
    .order("occurred_at");
  if (error) return fail(toDataError(error));
  const rows = (data ?? []) as unknown as {
    recipient_id: string;
    item_id: string;
    signer_name: string;
    occurred_at: string;
  }[];
  return ok(
    rows.map((r) => ({
      recipientId: r.recipient_id,
      itemId: r.item_id,
      signerName: r.signer_name,
      occurredAt: r.occurred_at,
    })),
  );
}

export interface AddedPackRecipient {
  readonly id: string;
  /** Shown once; give it by phone or message. No email ever carries it. */
  readonly accessCode: string;
}

export async function addPackRecipient(
  db: XosClient,
  input: {
    readonly packId: string;
    readonly fullName: string;
    readonly email: string;
    readonly counterpartyId: string | null;
    readonly label: string | null;
  },
): Promise<Result<AddedPackRecipient>> {
  const { data, error } = await db.rpc("add_stakeholder_pack_recipient", {
    p_pack_id: input.packId,
    p_full_name: input.fullName,
    p_email: input.email,
    ...(input.counterpartyId === null ? {} : { p_counterparty_id: input.counterpartyId }),
    ...(input.label === null ? {} : { p_label: input.label }),
  });
  if (error) return fail(toDataError(error));
  const row = (Array.isArray(data) ? data[0] : null) as {
    recipient_id: string;
    access_code: string | null;
  } | null;
  if (!row?.access_code) {
    return fail({ kind: "unexpected", message: "add_stakeholder_pack_recipient returned no code" });
  }
  return ok({ id: row.recipient_id, accessCode: row.access_code });
}

export async function resetPackRecipientCode(db: XosClient, id: string): Promise<Result<string>> {
  const { data, error } = await db.rpc("reset_stakeholder_pack_recipient_code", {
    p_recipient_id: id,
  });
  if (error) return fail(toDataError(error));
  return ok(String(data));
}

export async function revokePackRecipient(db: XosClient, id: string): Promise<Result<string>> {
  const { data, error } = await db.rpc("revoke_stakeholder_pack_recipient", { p_recipient_id: id });
  if (error) return fail(toDataError(error));
  return ok(String(data));
}

/** Queues invites and resends (app.send_stakeholder_pack). Answers how many were queued. */
export async function sendStakeholderPack(
  db: XosClient,
  packId: string,
  recipientIds: readonly string[] | null,
): Promise<Result<number>> {
  const { data, error } = await db.rpc("send_stakeholder_pack", {
    p_pack_id: packId,
    ...(recipientIds === null ? {} : { p_recipient_ids: [...recipientIds] }),
  });
  if (error) return fail(toDataError(error));
  return ok(Number(data));
}

export type PackCadence = "Daily" | "Weekly" | "Monthly";

export interface PackSchedule {
  readonly id: string;
  readonly cadence: PackCadence;
  readonly localHour: number;
  readonly weekday: number | null;
  readonly monthDay: number | null;
  readonly timeZone: string;
  readonly nextRunAt: string;
  readonly pausedAt: string | null;
}

export async function getPackSchedule(
  db: XosClient,
  packId: string,
): Promise<Result<PackSchedule | null>> {
  const { data, error } = await db
    .from("stakeholder_pack_schedules")
    .select("id, cadence, local_hour, weekday, month_day, time_zone, next_run_at, paused_at")
    .eq("stakeholder_pack_id", packId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  const r = data as unknown as {
    id: string;
    cadence: PackCadence;
    local_hour: number;
    weekday: number | null;
    month_day: number | null;
    time_zone: string;
    next_run_at: string;
    paused_at: string | null;
  } | null;
  return ok(
    r && {
      id: r.id,
      cadence: r.cadence,
      localHour: r.local_hour,
      weekday: r.weekday,
      monthDay: r.month_day,
      timeZone: r.time_zone,
      nextRunAt: r.next_run_at,
      pausedAt: r.paused_at,
    },
  );
}

export async function setPackSchedule(
  db: XosClient,
  input: {
    readonly packId: string;
    readonly cadence: PackCadence;
    readonly localHour: number;
    readonly weekday: number | null;
    readonly monthDay: number | null;
    readonly timeZone: string | null;
  },
): Promise<Result<string>> {
  const { data, error } = await db.rpc("set_stakeholder_pack_schedule", {
    p_pack_id: input.packId,
    p_cadence: input.cadence,
    p_local_hour: input.localHour,
    ...(input.weekday === null ? {} : { p_weekday: input.weekday }),
    ...(input.monthDay === null ? {} : { p_month_day: input.monthDay }),
    ...(input.timeZone === null ? {} : { p_time_zone: input.timeZone }),
  });
  if (error) return fail(toDataError(error));
  return ok(String(data));
}

export async function clearPackSchedule(db: XosClient, packId: string): Promise<Result<void>> {
  const { error } = await db.rpc("clear_stakeholder_pack_schedule", { p_pack_id: packId });
  if (error) return fail(toDataError(error));
  return ok(undefined);
}

// The anonymous side -------------------------------------------------------------------------------

type PublicRpc = {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: DatabaseErrorLike | null }>;
};

function publicRpc(db: XosClient): PublicRpc {
  return (db as unknown as { schema(name: "api_public"): PublicRpc }).schema("api_public");
}

export interface OpenedPack {
  readonly refused: false;
  readonly grant: string;
  readonly grantExpiresAt: string;
}

/** Opens a pack with its code, or with a grant the device holds (api_public.open_stakeholder_pack). */
export async function openStakeholderPack(
  db: XosClient,
  input: {
    readonly token: string;
    readonly accessCode: string | null;
    readonly grants: readonly string[];
    readonly clientAddress: string | null;
  },
): Promise<Result<OpenedPack | PackRefused>> {
  if (!PACK_LINK_TOKEN.test(input.token)) return ok({ refused: true, reason: "pack_link_invalid" });
  const { data, error } = await publicRpc(db).rpc("open_stakeholder_pack", {
    p_token: input.token,
    p_access_code: input.accessCode,
    p_client_address: input.clientAddress,
    p_grants: input.grants.length > 0 ? input.grants : null,
  });
  if (error) return fail(toDataError(error));
  const body = (data ?? {}) as Record<string, unknown>;
  if (body["status"] !== "ok" || typeof body["grant"] !== "string") {
    return ok({ refused: true, reason: parsePackRefusal(body["reason"]) });
  }
  return ok({
    refused: false,
    grant: body["grant"],
    grantExpiresAt: String(body["grant_expires_at"] ?? ""),
  });
}

export interface PackMeta {
  readonly projectName: string;
  readonly timeZone: string;
  readonly brandName: string;
  readonly brandLogoLightPath: string | null;
  readonly brandLogoDarkPath: string | null;
  readonly brandAccentHex: string | null;
  readonly suppressPoweredBy: boolean;
  readonly packName: string;
  readonly message: string | null;
  readonly expiresAt: string;
}

export interface PublicPackItem {
  readonly id: string;
  readonly title: string;
  readonly kind: "Live Link" | "File";
  readonly available: boolean;
  readonly requiresAcknowledgement: boolean;
  readonly signedAt: string | null;
}

export interface PublicPack {
  readonly refused: false;
  readonly meta: PackMeta;
  readonly recipientName: string;
  readonly items: readonly PublicPackItem[];
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);

function toMeta(m: Record<string, unknown>): PackMeta {
  return {
    projectName: str(m["project_name"]),
    timeZone: str(m["time_zone"]) || "UTC",
    brandName: str(m["brand_name"]),
    brandLogoLightPath: strOrNull(m["brand_logo_light_path"]),
    brandLogoDarkPath: strOrNull(m["brand_logo_dark_path"]),
    brandAccentHex: strOrNull(m["brand_accent_hex"]),
    suppressPoweredBy: m["brand_suppress_powered_by"] === true,
    packName: str(m["pack_name"]),
    message: strOrNull(m["message"]),
    expiresAt: str(m["expires_at"]),
  };
}

export async function readStakeholderPack(
  db: XosClient,
  input: {
    readonly token: string;
    readonly grants: readonly string[];
    readonly clientAddress: string | null;
  },
): Promise<Result<PublicPack | PackRefused>> {
  if (!PACK_LINK_TOKEN.test(input.token)) return ok({ refused: true, reason: "pack_link_invalid" });
  const { data, error } = await publicRpc(db).rpc("stakeholder_pack", {
    p_token: input.token,
    p_grants: input.grants,
    p_client_address: input.clientAddress,
  });
  if (error) return fail(toDataError(error));
  const body = (data ?? {}) as Record<string, unknown>;
  if (body["status"] !== "ok") {
    return ok({ refused: true, reason: parsePackRefusal(body["reason"]) });
  }
  const items = (Array.isArray(body["items"]) ? body["items"] : []) as Record<string, unknown>[];
  return ok({
    refused: false,
    meta: toMeta((body["meta"] ?? {}) as Record<string, unknown>),
    recipientName: str(body["recipient_name"]),
    items: items.map((i) => ({
      id: str(i["id"]),
      title: str(i["title"]),
      kind: i["kind"] === "File" ? "File" : "Live Link",
      available: i["available"] === true,
      requiresAcknowledgement: i["requires_acknowledgement"] === true,
      signedAt: strOrNull(i["signed_at"]),
    })),
  });
}

/**
 * One live item: P1's raw payload (api_public.stakeholder_pack_item), with the item's id and title.
 * The caller passes `payload` to P1's parsers (parseLiveView, parseDisplay).
 */
export async function readPackItem(
  db: XosClient,
  input: {
    readonly token: string;
    readonly grants: readonly string[];
    readonly itemId: string;
    readonly clientAddress: string | null;
  },
): Promise<
  Result<{ readonly refused: false; readonly payload: Record<string, unknown> } | PackRefused>
> {
  if (!PACK_LINK_TOKEN.test(input.token)) return ok({ refused: true, reason: "pack_link_invalid" });
  const { data, error } = await publicRpc(db).rpc("stakeholder_pack_item", {
    p_token: input.token,
    p_grants: input.grants,
    p_item_id: input.itemId,
    p_client_address: input.clientAddress,
  });
  if (error) return fail(toDataError(error));
  const body = (data ?? {}) as Record<string, unknown>;
  if (body["status"] !== "ok") {
    return ok({ refused: true, reason: parsePackRefusal(body["reason"]) });
  }
  return ok({ refused: false, payload: body });
}

export interface PackFileTicket {
  readonly refused: false;
  readonly ticket: string;
  readonly filename: string;
  readonly contentType: string;
}

export async function packFileTicket(
  db: XosClient,
  input: {
    readonly token: string;
    readonly grants: readonly string[];
    readonly itemId: string;
    readonly clientAddress: string | null;
  },
): Promise<Result<PackFileTicket | PackRefused>> {
  if (!PACK_LINK_TOKEN.test(input.token)) return ok({ refused: true, reason: "pack_link_invalid" });
  const { data, error } = await publicRpc(db).rpc("stakeholder_pack_file", {
    p_token: input.token,
    p_grants: input.grants,
    p_item_id: input.itemId,
    p_client_address: input.clientAddress,
  });
  if (error) return fail(toDataError(error));
  const row = (Array.isArray(data) ? data[0] : null) as {
    refusal: string | null;
    ticket: string | null;
    filename: string | null;
    content_type: string | null;
  } | null;
  if (!row || row.refusal || !row.ticket) {
    return ok({ refused: true, reason: parsePackRefusal(row?.refusal) });
  }
  return ok({
    refused: false,
    ticket: row.ticket,
    filename: row.filename ?? "",
    contentType: row.content_type ?? "",
  });
}

export async function signPackItem(
  db: XosClient,
  input: {
    readonly token: string;
    readonly grants: readonly string[];
    readonly itemId: string;
    readonly signerName: string;
    readonly clientAddress: string | null;
  },
): Promise<Result<{ readonly refused: false; readonly signedAt: string } | PackRefused>> {
  if (!PACK_LINK_TOKEN.test(input.token)) return ok({ refused: true, reason: "pack_link_invalid" });
  const { data, error } = await publicRpc(db).rpc("sign_stakeholder_pack_item", {
    p_token: input.token,
    p_grants: input.grants,
    p_item_id: input.itemId,
    p_signer_name: input.signerName,
    p_client_address: input.clientAddress,
  });
  if (error) return fail(toDataError(error));
  const body = (data ?? {}) as Record<string, unknown>;
  if (body["status"] !== "ok") {
    return ok({ refused: true, reason: parsePackRefusal(body["reason"]) });
  }
  return ok({ refused: false, signedAt: str(body["signed_at"]) });
}

export async function unsubscribeStakeholderPack(
  db: XosClient,
  input: { readonly token: string; readonly clientAddress: string | null },
): Promise<Result<{ readonly refused: false } | PackRefused>> {
  if (!PACK_UNSUBSCRIBE_TOKEN.test(input.token)) {
    return ok({ refused: true, reason: "pack_link_invalid" });
  }
  const { data, error } = await publicRpc(db).rpc("unsubscribe_stakeholder_pack", {
    p_unsubscribe_token: input.token,
    p_client_address: input.clientAddress,
  });
  if (error) return fail(toDataError(error));
  const body = (data ?? {}) as Record<string, unknown>;
  if (body["status"] !== "ok") {
    return ok({ refused: true, reason: parsePackRefusal(body["reason"]) });
  }
  return ok({ refused: false });
}

// The pack.deliver worker --------------------------------------------------------------------------

export const PACK_DELIVER_JOB = "pack.deliver";

export interface MintedPackLink {
  readonly token: string;
  readonly unsubscribeToken: string;
  readonly expiresAt: string;
  readonly email: PackEmailFacts;
}

/** What the database says the email is about. It holds no access code. */
export interface PackEmailFacts {
  readonly recipientName: string;
  readonly recipientEmail: string;
  readonly locale: string;
  readonly orgName: string;
  readonly brandName: string;
  readonly packName: string;
  readonly message: string | null;
  readonly itemTitles: readonly string[];
  readonly senderName: string | null;
  readonly expiresAt: string;
  readonly timeZone: string;
}

export interface PackDeliveryStore {
  claim(worker: string, limit: number): Promise<readonly { jobId: string; deliveryId: string }[]>;
  /** Null when the delivery is not queued, or was marked Skipped. */
  mint(deliveryId: string): Promise<MintedPackLink | null>;
  finish(
    deliveryId: string,
    outcome: { sent: true; messageId: string } | { sent: false; error: string; willRetry: boolean },
  ): Promise<void>;
  /** Answers the job's status after the attempt (Queued means it will retry). */
  finishJob(jobId: string, succeeded: boolean, error: string | null): Promise<string>;
}

export interface PackEmailCopy {
  subject(values: { readonly sender: string; readonly pack: string }): string;
  intro(values: { readonly sender: string; readonly pack: string }): string;
  message(values: { readonly message: string }): string;
  items(values: { readonly items: string }): string;
  open(values: { readonly url: string }): string;
  expires(values: { readonly date: string }): string;
  code(): string;
  sentBy(values: { readonly org: string; readonly address: string }): string;
  stop(values: { readonly url: string }): string;
}

export interface PackDeliveryEnv {
  /** The Atlas origin the links are on; a delivery fails with the reason while it is unset. */
  readonly appUrl: string | undefined;
  /** The postal address the CAN-SPAM footer needs (ADR 0033 decision 41). */
  readonly postalAddress: string | undefined;
  /** This function's own API origin, for the one-click unsubscribe header. */
  readonly apiUrl: string;
}

export interface PackDeliveryResult {
  readonly jobId: string;
  readonly deliveryId: string;
  readonly status: "Sent" | "Failed" | "Queued" | "Skipped";
  readonly error?: string;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The expiry as the recipient reads it: in the project's zone, with the zone's name. */
export function packExpiryText(expiresAt: string, locale: string, timeZone: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
    timeZoneName: "short",
  }).format(new Date(expiresAt));
}

/** The email of one delivery. It carries a sign-in link, never a code and never a file. */
export function packEmail(
  link: MintedPackLink,
  copy: PackEmailCopy,
  env: { readonly appUrl: string; readonly postalAddress: string; readonly apiUrl: string },
): ReportEmail {
  const facts = link.email;
  const url = `${env.appUrl}${packPath(link.token)}`;
  const stopUrl = `${env.appUrl}${packUnsubscribePath(link.unsubscribeToken)}`;
  const sender = facts.senderName ?? facts.brandName;
  const words = { sender, pack: facts.packName };
  const date = packExpiryText(link.expiresAt, facts.locale, facts.timeZone);
  const paragraphs = [
    copy.intro(words),
    ...(facts.message ? [copy.message({ message: facts.message })] : []),
    ...(facts.itemTitles.length > 0 ? [copy.items({ items: facts.itemTitles.join(", ") })] : []),
    copy.open({ url }),
    copy.expires({ date }),
    copy.code(),
  ];
  const footer = [
    copy.sentBy({ org: facts.orgName, address: env.postalAddress }),
    copy.stop({ url: stopUrl }),
  ];
  return {
    to: facts.recipientEmail,
    toName: facts.recipientName,
    subject: copy.subject(words),
    text: [...paragraphs, ...footer].join("\n\n"),
    html: [
      ...paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`),
      ...footer.map((p) => `<p><small>${escapeHtml(p)}</small></p>`),
    ].join(""),
    headers: {
      "List-Unsubscribe": `<${env.apiUrl}/functions/v1/email-unsubscribe?token=${link.unsubscribeToken}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}

/** One pass of the pack.deliver worker: claim, mint, send, finish. */
export async function runPackDeliveries(options: {
  readonly store: PackDeliveryStore;
  readonly mailer: ReportMailer;
  readonly copy: (locale: string) => Promise<PackEmailCopy>;
  readonly env: PackDeliveryEnv;
  readonly worker: string;
  readonly limit?: number;
}): Promise<readonly PackDeliveryResult[]> {
  const { store, mailer, copy, env, worker } = options;
  const claimed = await store.claim(worker, options.limit ?? 25);
  const results: PackDeliveryResult[] = [];
  for (const job of claimed) {
    try {
      if (!env.appUrl) throw new Error("XOS_APP_URL is not set, so a pack link cannot be built.");
      if (!env.postalAddress) {
        throw new Error("XOS_POSTAL_ADDRESS is not set, so a pack email has no CAN-SPAM footer.");
      }
      const link = await store.mint(job.deliveryId);
      if (!link) {
        await store.finishJob(job.jobId, true, null);
        results.push({ jobId: job.jobId, deliveryId: job.deliveryId, status: "Skipped" });
        continue;
      }
      const email = packEmail(link, await copy(link.email.locale), {
        appUrl: env.appUrl,
        postalAddress: env.postalAddress,
        apiUrl: env.apiUrl,
      });
      const sent = await mailer.send(email);
      await store.finish(job.deliveryId, { sent: true, messageId: sent.messageId });
      await store.finishJob(job.jobId, true, null);
      results.push({ jobId: job.jobId, deliveryId: job.deliveryId, status: "Sent" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const jobStatus = await store.finishJob(job.jobId, false, message);
      const willRetry = jobStatus === "Queued";
      // A failed send revokes the link it carried, so it leaves no working one; a retry mints a new one.
      await store.finish(job.deliveryId, { sent: false, error: message, willRetry });
      results.push({
        jobId: job.jobId,
        deliveryId: job.deliveryId,
        status: willRetry ? "Queued" : "Failed",
        error: message,
      });
    }
  }
  return results;
}

/** PackDeliveryStore over the service-role client: the 0510 queue RPCs and the 2913 RPCs. */
export function supabasePackDeliveryStore(client: SupabaseClient): PackDeliveryStore {
  const app = client.schema("app");
  const call = async (fn: string, args: Record<string, unknown>): Promise<unknown> => {
    const { data, error } = await app.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data;
  };
  return {
    async claim(worker, limit) {
      const rows = (await call("claim_jobs", {
        p_worker: worker,
        p_job_kind: PACK_DELIVER_JOB,
        p_limit: limit,
      })) as Record<string, unknown>[] | null;
      return (rows ?? []).map((r) => ({ jobId: str(r["id"]), deliveryId: str(r["subject_id"]) }));
    },
    async mint(deliveryId) {
      const rows = (await call("mint_stakeholder_pack_link", {
        p_delivery_id: deliveryId,
      })) as Record<string, unknown>[] | null;
      const r = rows?.[0];
      if (!r) return null;
      const e = (r["email"] ?? {}) as Record<string, unknown>;
      return {
        token: str(r["token"]),
        unsubscribeToken: str(r["unsubscribe_token"]),
        expiresAt: str(r["expires_at"]),
        email: {
          recipientName: str(e["recipient_name"]),
          recipientEmail: str(e["recipient_email"]),
          locale: str(e["locale"]) || "en-US",
          orgName: str(e["org_name"]),
          brandName: str(e["brand_name"]),
          packName: str(e["pack_name"]),
          message: strOrNull(e["message"]),
          itemTitles: (Array.isArray(e["item_titles"]) ? e["item_titles"] : []).map(str),
          senderName: strOrNull(e["sender_name"]),
          expiresAt: str(e["expires_at"]),
          timeZone: str(e["time_zone"]) || "UTC",
        },
      };
    },
    async finish(deliveryId, outcome) {
      await call(
        "finish_stakeholder_pack_delivery",
        outcome.sent
          ? { p_delivery_id: deliveryId, p_sent: true, p_provider_message_id: outcome.messageId }
          : {
              p_delivery_id: deliveryId,
              p_sent: false,
              p_error: outcome.error,
              p_retry: outcome.willRetry,
            },
      );
    },
    async finishJob(jobId, succeeded, error) {
      return String(
        await call("finish_job", { p_job_id: jobId, p_succeeded: succeeded, p_error: error }),
      );
    },
  };
}
