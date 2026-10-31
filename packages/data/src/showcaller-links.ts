import type { XosClient } from "./client.ts";
import { CUE_CALL_KINDS, isCueCallKind, type CueCallKind } from "./cue-calls.ts";
import type { DatabaseErrorLike } from "./result.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";
import type { PublicCue } from "./live-links.ts";
import { isSegmentColor, type Cue, type CueCall, type SegmentColor } from "./show.ts";
import { untyped } from "./untyped.ts";

/**
 * Showcaller links (B3, ADR 0142; migrations 2923 to 2925): a no-account link and access code that let an outside
 * showcaller call one running order and edit it live, within that running order only.
 *
 * - Members make links with {@link createShowcallerLink}. The database decides who may (membership of the org and
 *   both show.run_of_show.write and show.cue.call), checks the expiry (within 14 days) and draws the token and the
 *   6-digit access code, which come back once.
 * - The portal opens a link with its code ({@link openShowcallerLink}) and gets a device grant, then reads
 *   ({@link readShowcallerRun}) and writes ({@link showcallerWrite}) with token and grant, through a cookie-less
 *   anonymous client. Every write is checked and attributed to the link by the database.
 * - The tables and RPCs are newer than the generated data types, so every row is mapped here (untyped.ts).
 */

export const SHOWCALLER_TOKEN = /^xscl_[0-9a-f]{64}$/;
/** A device grant, kept in the portal's HttpOnly cookie. */
export const SHOWCALLER_GRANT = /^xcgr_[0-9a-f]{64}$/;
/** The longest a link may last, in days (the RPCs enforce the same). */
export const MAX_SHOWCALLER_LINK_DAYS = 14;
/** The most devices one link serves at once. */
export const MAX_SHOWCALLER_DEVICES = 5;

/** The portal's address: /share/showcaller/{token}. */
export function showcallerPath(token: string): string {
  return `/share/showcaller/${token}`;
}

export type ShowcallerLinkState = "Active" | "Locked" | "Expired" | "Revoked";

// Refusals ---------------------------------------------------------------------------------------

export const SHOWCALLER_REFUSALS = [
  "showcaller_link_invalid",
  "showcaller_link_rate_limited",
  "showcaller_link_locked",
  "showcaller_link_expired",
  "showcaller_link_access_code_required",
  "showcaller_link_access_code",
  "showcaller_link_devices",
  "showcaller_link_grant",
  "showcaller_link_owner_access",
  "showcaller_link_run_removed",
  "showcaller_link_reclassified",
  "showcaller_link_scope",
  "showcaller_cue_field",
  "showcaller_cue_changed",
  "showcaller_cue_called",
  "showcaller_cue_linked",
  "showcaller_cue_limit",
  "org_read_only",
  "cue_already_called",
  "cue_standby_called",
  "cue_move_called",
  "cue_move_before_called",
  "cue_shift_range",
  "cue_call_kind",
] as const;

export type ShowcallerRefusal = (typeof SHOWCALLER_REFUSALS)[number];

/** A reason the database answered, or showcaller_link_invalid for anything unknown. */
export function parseShowcallerRefusal(reason: unknown): ShowcallerRefusal {
  return (SHOWCALLER_REFUSALS as readonly unknown[]).includes(reason)
    ? (reason as ShowcallerRefusal)
    : "showcaller_link_invalid";
}

/** True for a refusal the access code form answers (no grant yet, or a wrong code). */
export function showcallerAsksForCode(reason: ShowcallerRefusal): boolean {
  return (
    reason === "showcaller_link_grant" ||
    reason === "showcaller_link_access_code_required" ||
    reason === "showcaller_link_access_code"
  );
}

/** True when the portal can do nothing more with this link: it says the link is no longer available. */
export function showcallerLinkGone(reason: ShowcallerRefusal): boolean {
  return (
    reason === "showcaller_link_invalid" ||
    reason === "showcaller_link_expired" ||
    reason === "showcaller_link_owner_access" ||
    reason === "showcaller_link_run_removed" ||
    reason === "showcaller_link_reclassified"
  );
}

export type ShowcallerRefused = { readonly refused: true; readonly reason: ShowcallerRefusal };

// Managing links (signed in) ---------------------------------------------------------------------

export interface ShowcallerLink {
  readonly id: string;
  readonly runOfShowId: string;
  readonly callerName: string;
  readonly note: string | null;
  readonly tokenHint: string;
  readonly expiresAt: string;
  readonly openCount: number;
  readonly lastOpenedAt: string | null;
  readonly rotatedAt: string | null;
  readonly revokedAt: string | null;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly state: ShowcallerLinkState;
  /** Devices holding an unexpired grant, when the caller may manage the link; null otherwise. */
  readonly devices: number | null;
}

interface LinkRow {
  id: string;
  run_of_show_id: string;
  caller_name: string;
  note: string | null;
  token_hint: string;
  expires_at: string;
  failed_attempts: number;
  open_count: number;
  last_opened_at: string | null;
  rotated_at: string | null;
  revoked_at: string | null;
  created_by: string | null;
  created_at: string;
}

const LINK_COLUMNS =
  "id, run_of_show_id, caller_name, note, token_hint, expires_at, failed_attempts, open_count, last_opened_at, rotated_at, revoked_at, created_by, created_at";

/** The state a link is in at `now`, as app.showcaller_link_states computes it. */
export function showcallerLinkState(
  link: { revokedAt: string | null; expiresAt: string; failedAttempts: number },
  now: Date = new Date(),
): ShowcallerLinkState {
  if (link.revokedAt !== null) return "Revoked";
  if (Date.parse(link.expiresAt) <= now.getTime()) return "Expired";
  if (link.failedAttempts >= 5) return "Locked";
  return "Active";
}

/** The showcaller links of a running order, newest first, with their state and device count. */
export async function listShowcallerLinks(
  db: XosClient,
  runOfShowId: string,
): Promise<Result<ShowcallerLink[]>> {
  const { data, error } = await untyped(db)
    .from("showcaller_links")
    .select(LINK_COLUMNS)
    .eq("run_of_show_id", runOfShowId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (error) return fail(toDataError(error));
  const rows = (data ?? []) as LinkRow[];
  const devices = await Promise.all(
    rows.map(async (r) => {
      if (r.revoked_at !== null) return 0;
      const { data: count, error: countError } = await untyped(db).rpc("showcaller_link_devices", {
        p_showcaller_link_id: r.id,
      });
      return countError ? null : Number(count);
    }),
  );
  return ok(
    rows.map((r, i) => ({
      id: r.id,
      runOfShowId: r.run_of_show_id,
      callerName: r.caller_name,
      note: r.note,
      tokenHint: r.token_hint,
      expiresAt: r.expires_at,
      openCount: r.open_count,
      lastOpenedAt: r.last_opened_at,
      rotatedAt: r.rotated_at,
      revokedAt: r.revoked_at,
      createdBy: r.created_by,
      createdAt: r.created_at,
      state: showcallerLinkState({
        revokedAt: r.revoked_at,
        expiresAt: r.expires_at,
        failedAttempts: r.failed_attempts,
      }),
      devices: devices[i] ?? null,
    })),
  );
}

export interface CreatedShowcallerLink {
  readonly id: string;
  /** Shown once; only its hash is stored. */
  readonly token: string;
  /** Shown once; send it apart from the link. */
  readonly accessCode: string;
  readonly expiresAt: string;
}

/** Makes a showcaller link to a running order (app.create_showcaller_link). */
export async function createShowcallerLink(
  db: XosClient,
  input: {
    readonly runOfShowId: string;
    readonly callerName: string;
    /** Null for the default: the end of the day after the show, at most 14 days ahead. */
    readonly expiresAt: string | null;
    readonly note: string | null;
  },
): Promise<Result<CreatedShowcallerLink>> {
  const { data, error } = await untyped(db).rpc("create_showcaller_link", {
    p_run_of_show_id: input.runOfShowId,
    p_caller_name: input.callerName,
    ...(input.expiresAt === null ? {} : { p_expires_at: input.expiresAt }),
    ...(input.note === null ? {} : { p_note: input.note }),
  });
  if (error) return fail(toDataError(error));
  const row = (Array.isArray(data) ? data[0] : null) as {
    showcaller_link_id: string;
    token: string | null;
    access_code: string | null;
    expires_at: string;
  } | null;
  if (!row?.token || !row.access_code) {
    return fail({ kind: "unexpected", message: "create_showcaller_link returned no token" });
  }
  return ok({
    id: row.showcaller_link_id,
    token: row.token,
    accessCode: row.access_code,
    expiresAt: row.expires_at,
  });
}

/** A new token and access code (app.regenerate_showcaller_link); the old ones and every device stop at once. */
export async function regenerateShowcallerLink(
  db: XosClient,
  id: string,
): Promise<Result<Omit<CreatedShowcallerLink, "id">>> {
  const { data, error } = await untyped(db).rpc("regenerate_showcaller_link", {
    p_showcaller_link_id: id,
  });
  if (error) return fail(toDataError(error));
  const row = (Array.isArray(data) ? data[0] : null) as {
    token: string | null;
    access_code: string | null;
    expires_at: string;
  } | null;
  if (!row?.token || !row.access_code) {
    return fail({ kind: "unexpected", message: "regenerate_showcaller_link returned no token" });
  }
  return ok({ token: row.token, accessCode: row.access_code, expiresAt: row.expires_at });
}

/** Revokes a link (app.revoke_showcaller_link). Answers the revocation time. */
export async function revokeShowcallerLink(db: XosClient, id: string): Promise<Result<string>> {
  const { data, error } = await untyped(db).rpc("revoke_showcaller_link", {
    p_showcaller_link_id: id,
  });
  if (error) return fail(toDataError(error));
  return ok(String(data));
}

/** Signs every device out of a link (app.sign_out_showcaller_devices). Answers how many were signed out. */
export async function signOutShowcallerDevices(db: XosClient, id: string): Promise<Result<number>> {
  const { data, error } = await untyped(db).rpc("sign_out_showcaller_devices", {
    p_showcaller_link_id: id,
  });
  if (error) return fail(toDataError(error));
  return ok(Number(data));
}

// The portal (anonymous) --------------------------------------------------------------------------

type PublicRpc = {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: DatabaseErrorLike | null }>;
};

function publicRpc(db: XosClient): PublicRpc {
  return (db as unknown as { schema(name: "api_public"): PublicRpc }).schema("api_public");
}

export interface OpenedShowcallerLink {
  readonly refused: false;
  readonly grant: string;
  readonly grantExpiresAt: string;
}

/**
 * Opens a link with its access code (api_public.open_showcaller_link). A POST, as every token RPC must be
 * (A69-001). The client address is the one the route relays, for the per-address failure limit.
 */
export async function openShowcallerLink(
  db: XosClient,
  input: {
    readonly token: string;
    readonly accessCode: string | null;
    readonly clientAddress: string | null;
  },
): Promise<Result<OpenedShowcallerLink | ShowcallerRefused>> {
  if (!SHOWCALLER_TOKEN.test(input.token)) {
    return ok({ refused: true, reason: "showcaller_link_invalid" });
  }
  const { data, error } = await publicRpc(db).rpc("open_showcaller_link", {
    p_token: input.token,
    p_access_code: input.accessCode,
    p_client_address: input.clientAddress,
  });
  if (error) return fail(toDataError(error));
  const body = (data ?? {}) as Record<string, unknown>;
  if (body["status"] !== "ok" || typeof body["grant"] !== "string") {
    return ok({
      refused: true,
      reason:
        body["status"] === "ok"
          ? "showcaller_link_invalid"
          : parseShowcallerRefusal(body["reason"]),
    });
  }
  return ok({
    refused: false,
    grant: body["grant"],
    grantExpiresAt: String(body["grant_expires_at"] ?? ""),
  });
}

/** A Showcaller-audience custom value of a cue, as the portal renders it. */
export interface ShowcallerField {
  readonly key: string;
  readonly label: string;
  readonly dataType: string;
  readonly text: string | null;
  readonly number: number | null;
  readonly date: string | null;
  readonly timestamp: string | null;
  readonly boolean: boolean | null;
  readonly choiceLabel: string | null;
  readonly colorKey: SegmentColor | null;
}

/** A cue as the portal sees it: never who called it. */
export interface ShowcallerCue {
  readonly id: string;
  readonly position: number;
  readonly label: string;
  readonly segment: string | null;
  readonly segmentColor: SegmentColor | null;
  readonly plannedAt: string | null;
  readonly startTbc: boolean;
  readonly durationSeconds: number | null;
  readonly calledAt: string | null;
  readonly standbyAt: string | null;
  readonly description: string | null;
  readonly script: string | null;
  readonly updatedAt: string;
  readonly calls: readonly { readonly kind: CueCallKind; readonly instruction: string }[];
  readonly fields: readonly ShowcallerField[];
}

export interface ShowcallerMeta {
  readonly projectName: string;
  readonly timeZone: string;
  readonly brandName: string;
  readonly brandLogoLightPath: string | null;
  readonly brandLogoDarkPath: string | null;
  readonly brandAccentHex: string | null;
  readonly suppressPoweredBy: boolean;
  readonly callerName: string;
  readonly expiresAt: string;
  readonly grantExpiresAt: string;
  readonly name: string;
  readonly showDate: string;
  readonly stage: string | null;
  readonly curfewAt: string | null;
}

export interface ShowcallerRun {
  readonly refused: false;
  readonly meta: ShowcallerMeta;
  readonly channel: string | null;
  /** The database's clock when it answered, so the portal can correct its own. */
  readonly serverNow: string;
  readonly cues: readonly ShowcallerCue[];
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

function toField(raw: Record<string, unknown>): ShowcallerField {
  return {
    key: str(raw["key"]) ?? "",
    label: str(raw["label"]) ?? "",
    dataType: str(raw["data_type"]) ?? "Text",
    text: str(raw["value_text"]),
    number: num(raw["value_number"]),
    date: str(raw["value_date"]),
    timestamp: str(raw["value_timestamp"]),
    boolean: typeof raw["value_boolean"] === "boolean" ? raw["value_boolean"] : null,
    choiceLabel: str(raw["choice_label"]),
    colorKey: isSegmentColor(raw["color_key"]) ? raw["color_key"] : null,
  };
}

function toShowcallerCue(raw: Record<string, unknown>): ShowcallerCue {
  const calls = Array.isArray(raw["calls"]) ? (raw["calls"] as Record<string, unknown>[]) : [];
  return {
    id: str(raw["id"]) ?? "",
    position: num(raw["position"]) ?? 0,
    label: str(raw["label"]) ?? "",
    segment: str(raw["segment"]),
    segmentColor: isSegmentColor(raw["segment_color"]) ? raw["segment_color"] : null,
    plannedAt: str(raw["planned_at"]),
    startTbc: raw["start_tbc"] === true,
    durationSeconds: num(raw["duration_seconds"]),
    calledAt: str(raw["called_at"]),
    standbyAt: str(raw["standby_at"]),
    description: str(raw["description"]),
    script: str(raw["script"]),
    updatedAt: str(raw["updated_at"]) ?? "",
    calls: calls
      .filter((c) => isCueCallKind(c["kind"]) && typeof c["instruction"] === "string")
      .map((c) => ({ kind: c["kind"] as CueCallKind, instruction: c["instruction"] as string }))
      .sort((a, b) => CUE_CALL_KINDS.indexOf(a.kind) - CUE_CALL_KINDS.indexOf(b.kind)),
    fields: (Array.isArray(raw["fields"]) ? (raw["fields"] as Record<string, unknown>[]) : []).map(
      toField,
    ),
  };
}

/** Reads the link's running order with its device grant (api_public.showcaller_run). */
export async function readShowcallerRun(
  db: XosClient,
  input: { readonly token: string; readonly grant: string; readonly clientAddress: string | null },
): Promise<Result<ShowcallerRun | ShowcallerRefused>> {
  if (!SHOWCALLER_TOKEN.test(input.token)) {
    return ok({ refused: true, reason: "showcaller_link_invalid" });
  }
  if (!SHOWCALLER_GRANT.test(input.grant))
    return ok({ refused: true, reason: "showcaller_link_grant" });
  const { data, error } = await publicRpc(db).rpc("showcaller_run", {
    p_token: input.token,
    p_grant: input.grant,
    p_client_address: input.clientAddress,
  });
  if (error) return fail(toDataError(error));
  const body = (data ?? {}) as Record<string, unknown>;
  if (body["status"] !== "ok") {
    return ok({ refused: true, reason: parseShowcallerRefusal(body["reason"]) });
  }
  const meta = (body["meta"] ?? {}) as Record<string, unknown>;
  return ok({
    refused: false,
    meta: {
      projectName: str(meta["project_name"]) ?? "",
      timeZone: str(meta["time_zone"]) ?? "UTC",
      brandName: str(meta["brand_name"]) ?? "",
      brandLogoLightPath: str(meta["brand_logo_light_path"]),
      brandLogoDarkPath: str(meta["brand_logo_dark_path"]),
      brandAccentHex: str(meta["brand_accent_hex"]),
      suppressPoweredBy: meta["brand_suppress_powered_by"] === true,
      callerName: str(meta["caller_name"]) ?? "",
      expiresAt: str(meta["expires_at"]) ?? "",
      grantExpiresAt: str(meta["grant_expires_at"]) ?? "",
      name: str(meta["name"]) ?? "",
      showDate: str(meta["show_date"]) ?? "",
      stage: str(meta["stage"]),
      curfewAt: str(meta["curfew_at"]),
    },
    channel: str(body["channel"]),
    serverNow: str(body["server_now"]) ?? new Date().toISOString(),
    cues: (Array.isArray(body["cues"]) ? (body["cues"] as Record<string, unknown>[]) : []).map(
      toShowcallerCue,
    ),
  });
}

/** The fields a portal edit may send (the allowlist of api_public.showcaller_save_cue). */
export interface ShowcallerCueFields {
  readonly label?: string;
  readonly segment?: string | null;
  readonly description?: string | null;
  readonly script?: string | null;
  readonly plannedAt?: string | null;
  readonly startTbc?: boolean;
  readonly durationSeconds?: number | null;
}

/** One portal write and its arguments after the token, grant and address. */
export type ShowcallerWrite =
  | { readonly op: "call"; readonly cueId: string }
  | { readonly op: "standby"; readonly cueId: string | null }
  | { readonly op: "shift"; readonly seconds: number }
  | { readonly op: "move"; readonly cueId: string; readonly toPosition: number }
  | {
      readonly op: "save";
      readonly cueId: string | null;
      readonly fields: ShowcallerCueFields;
      readonly expectedUpdatedAt: string | null;
    }
  | { readonly op: "remove"; readonly cueId: string }
  | {
      readonly op: "calls";
      readonly cueId: string;
      readonly calls: Partial<Record<CueCallKind, string | null>>;
    };

/** The JSON object a save sends: only the keys given, in the database's names. */
export function fieldsBody(fields: ShowcallerCueFields): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (fields.label !== undefined) body["label"] = fields.label;
  if (fields.segment !== undefined) body["segment"] = fields.segment;
  if (fields.description !== undefined) body["description"] = fields.description;
  if (fields.script !== undefined) body["script"] = fields.script;
  if (fields.plannedAt !== undefined) body["planned_at"] = fields.plannedAt;
  if (fields.startTbc !== undefined) body["start_tbc"] = fields.startTbc;
  if (fields.durationSeconds !== undefined) body["duration_seconds"] = fields.durationSeconds;
  return body;
}

function writeCall(write: ShowcallerWrite): [string, Record<string, unknown>] {
  switch (write.op) {
    case "call":
      return ["showcaller_call_cue", { p_cue_id: write.cueId }];
    case "standby":
      return ["showcaller_standby_cue", { p_cue_id: write.cueId }];
    case "shift":
      return ["showcaller_shift_plan", { p_seconds: write.seconds }];
    case "move":
      return ["showcaller_move_cue", { p_cue_id: write.cueId, p_to_position: write.toPosition }];
    case "save":
      return [
        "showcaller_save_cue",
        {
          p_cue_id: write.cueId,
          p_fields: fieldsBody(write.fields),
          p_expected_updated_at: write.expectedUpdatedAt,
        },
      ];
    case "remove":
      return ["showcaller_remove_cue", { p_cue_id: write.cueId }];
    case "calls":
      return ["showcaller_save_cue_calls", { p_cue_id: write.cueId, p_calls: write.calls }];
  }
}

/** A portal write with token and grant (the api_public.showcaller_* RPCs). Answers ok or the refusal. */
export async function showcallerWrite(
  db: XosClient,
  input: {
    readonly token: string;
    readonly grant: string;
    readonly clientAddress: string | null;
    readonly write: ShowcallerWrite;
  },
): Promise<Result<{ readonly refused: false } | ShowcallerRefused>> {
  if (!SHOWCALLER_TOKEN.test(input.token)) {
    return ok({ refused: true, reason: "showcaller_link_invalid" });
  }
  if (!SHOWCALLER_GRANT.test(input.grant))
    return ok({ refused: true, reason: "showcaller_link_grant" });
  const [fn, args] = writeCall(input.write);
  const { data, error } = await publicRpc(db).rpc(fn, {
    p_token: input.token,
    p_grant: input.grant,
    p_client_address: input.clientAddress,
    ...args,
  });
  if (error) return fail(toDataError(error));
  const body = (data ?? {}) as Record<string, unknown>;
  return ok(
    body["status"] === "ok"
      ? { refused: false }
      : { refused: true, reason: parseShowcallerRefusal(body["reason"]) },
  );
}

// Shapes the shared components take --------------------------------------------------------------

/** A portal cue as the showcaller console takes it (show.ts Cue). Nobody's name is known to the portal. */
export function consoleCue(cue: ShowcallerCue, runOfShowId: string): Cue {
  return {
    id: cue.id,
    runOfShowId,
    position: cue.position,
    label: cue.label,
    plannedAt: cue.plannedAt,
    durationSeconds: cue.durationSeconds,
    calledAt: cue.calledAt,
    calledByName: null,
    startTbc: cue.startTbc,
    standbyAt: cue.standbyAt,
    segment: cue.segment,
    description: cue.description,
    script: cue.script,
    segmentInstanceId: null,
    calledViaLink: null,
    updatedAt: cue.updatedAt,
  };
}

/** The portal's department calls as the console takes them (show.ts CueCall). */
export function consoleCalls(cues: readonly ShowcallerCue[]): CueCall[] {
  return cues.flatMap((c) =>
    c.calls.map((k) => ({
      id: `${c.id}:${k.kind}`,
      cueId: c.id,
      kind: k.kind,
      instruction: k.instruction,
    })),
  );
}

/** A portal cue as P1's display screen takes it, for the pop-out clock. */
export function displayCue(cue: ShowcallerCue): PublicCue {
  return {
    position: cue.position,
    label: cue.label,
    segment: cue.segment,
    plannedAt: cue.plannedAt,
    durationSeconds: cue.durationSeconds,
    calledAt: cue.calledAt,
  };
}
