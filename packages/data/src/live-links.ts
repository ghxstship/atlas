import type { XosClient } from "./client.ts";
import type { DatabaseErrorLike } from "./result.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";
import { cueProgress } from "./show.ts";

/**
 * Live links (P1, ADR 0130; migrations 2780 to 2782): a no-account link to one saved view of a
 * project, or to one running order on a display screen, that updates while it is open.
 *
 * - Members make links with {@link createViewLink} and {@link createDisplayLink}. The database
 *   decides who may (the collection's share capability, membership of the org, not read-only),
 *   checks the expiry (within 90 days) and draws the token and the 6-digit access code, which come
 *   back once. Every link has a code (Section 7.5 invariant 8, ADR 0033 decision 56).
 * - The anonymous page opens a link with its code ({@link openLiveLink}) and gets a device grant,
 *   then reads with token and grant ({@link readLiveView}, {@link readDisplay}). Both run with a
 *   cookie-less anonymous client, never the visitor's session.
 * - The page joins the channel each read names (Realtime broadcast, ping only) and rereads on a
 *   ping; {@link displayFrame} works out what a display screen shows at each tick.
 */

export const LIVE_VIEW_TOKEN = /^xshv_[0-9a-f]{64}$/;
export const DISPLAY_TOKEN = /^xscr_[0-9a-f]{64}$/;
/** A device grant, kept in the page's HttpOnly cookie. */
export const LIVE_GRANT = /^xlgr_[0-9a-f]{64}$/;

export type LiveLinkKind = "View" | "Display";

export const DISPLAY_MODES = ["Room Clock", "Presenter Timer", "Backstage"] as const;
export type DisplayMode = (typeof DISPLAY_MODES)[number];

export function isDisplayMode(value: unknown): value is DisplayMode {
  return typeof value === "string" && (DISPLAY_MODES as readonly string[]).includes(value);
}

/** The state app.live_link_states computes; nothing stores it. */
export type LiveLinkState = "Active" | "Locked" | "Expired" | "Revoked";

/** Collections a saved view may share live (private.live_view_collections). */
export const LIVE_VIEW_COLLECTIONS = [
  "project/schedule",
  "project/show",
  "show/run_of_show",
  "show/day_sheets",
] as const;

export function isLiveViewCollection(key: string | null | undefined): boolean {
  return (LIVE_VIEW_COLLECTIONS as readonly string[]).includes(key ?? "");
}

/** The longest a link may last, in days (the RPCs enforce the same). */
export const MAX_LIVE_LINK_DAYS = 90;

/** The public address of a link: /share/view/{token} or /share/screen/{token}. */
export function liveLinkPath(kind: LiveLinkKind, token: string): string {
  return `/share/${kind === "View" ? "view" : "screen"}/${token}`;
}

// Refusals ---------------------------------------------------------------------------------------

export const LIVE_LINK_REFUSALS = [
  "live_link_invalid",
  "live_link_rate_limited",
  "live_link_locked",
  "live_link_expired",
  "live_link_access_code_required",
  "live_link_access_code",
  "live_link_grant",
  "live_link_owner_access",
  "live_link_view_removed",
  "live_link_view_unsupported",
  "live_link_reclassified",
] as const;

export type LiveLinkRefusal = (typeof LIVE_LINK_REFUSALS)[number];

/** A reason the database answered, or live_link_invalid for anything unknown. */
export function parseRefusal(reason: unknown): LiveLinkRefusal {
  return (LIVE_LINK_REFUSALS as readonly unknown[]).includes(reason)
    ? (reason as LiveLinkRefusal)
    : "live_link_invalid";
}

/** True for a refusal the access code form answers (no grant yet, or a wrong code). */
export function asksForCode(reason: LiveLinkRefusal): boolean {
  return (
    reason === "live_link_grant" ||
    reason === "live_link_access_code_required" ||
    reason === "live_link_access_code"
  );
}

export type Refused = { readonly refused: true; readonly reason: LiveLinkRefusal };

// Managing links (signed in) ---------------------------------------------------------------------

export interface LiveLink {
  readonly id: string;
  readonly kind: LiveLinkKind;
  readonly projectId: string;
  readonly savedViewId: string | null;
  readonly runOfShowId: string | null;
  readonly defaultMode: DisplayMode | null;
  readonly tokenHint: string;
  readonly note: string | null;
  readonly expiresAt: string;
  readonly openCount: number;
  readonly lastOpenedAt: string | null;
  readonly rotatedAt: string | null;
  readonly revokedAt: string | null;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly state: LiveLinkState;
}

const LINK_COLUMNS =
  "id, link_kind, project_id, saved_view_id, run_of_show_id, default_mode, token_hint, note, expires_at, failed_attempts, open_count, last_opened_at, rotated_at, revoked_at, created_by, created_at";

interface LinkRow {
  id: string;
  link_kind: LiveLinkKind;
  project_id: string;
  saved_view_id: string | null;
  run_of_show_id: string | null;
  default_mode: string | null;
  token_hint: string;
  note: string | null;
  expires_at: string;
  failed_attempts: number;
  open_count: number;
  last_opened_at: string | null;
  rotated_at: string | null;
  revoked_at: string | null;
  created_by: string | null;
  created_at: string;
}

/** The state a link is in at `now`, as app.live_link_states computes it. */
export function liveLinkState(
  link: { revokedAt: string | null; expiresAt: string; failedAttempts: number },
  now: Date = new Date(),
): LiveLinkState {
  if (link.revokedAt !== null) return "Revoked";
  if (Date.parse(link.expiresAt) <= now.getTime()) return "Expired";
  if (link.failedAttempts >= 5) return "Locked";
  return "Active";
}

function toLink(r: LinkRow, state: LiveLinkState | undefined): LiveLink {
  return {
    id: r.id,
    kind: r.link_kind,
    projectId: r.project_id,
    savedViewId: r.saved_view_id,
    runOfShowId: r.run_of_show_id,
    defaultMode: isDisplayMode(r.default_mode) ? r.default_mode : null,
    tokenHint: r.token_hint,
    note: r.note,
    expiresAt: r.expires_at,
    openCount: r.open_count,
    lastOpenedAt: r.last_opened_at,
    rotatedAt: r.rotated_at,
    revokedAt: r.revoked_at,
    createdBy: r.created_by,
    createdAt: r.created_at,
    state:
      state ??
      liveLinkState({
        revokedAt: r.revoked_at,
        expiresAt: r.expires_at,
        failedAttempts: r.failed_attempts,
      }),
  };
}

/** The live links of a saved view or a running order, newest first, with their computed state. */
export async function listLiveLinks(
  db: XosClient,
  subject: { readonly savedViewId: string } | { readonly runOfShowId: string },
): Promise<Result<LiveLink[]>> {
  const base = db.from("live_links").select(LINK_COLUMNS).is("deleted_at", null);
  const { data, error } = await (
    "savedViewId" in subject
      ? base.eq("saved_view_id", subject.savedViewId)
      : base.eq("run_of_show_id", subject.runOfShowId)
  ).order("created_at", { ascending: false });
  if (error) return fail(toDataError(error));
  const rows = (data ?? []) as unknown as LinkRow[];
  if (rows.length === 0) return ok([]);
  const states = await db
    .from("live_link_states")
    .select("id, link_state")
    .in(
      "id",
      rows.map((r) => r.id),
    );
  if (states.error) return fail(toDataError(states.error));
  const byId = new Map(
    ((states.data ?? []) as unknown as { id: string; link_state: LiveLinkState }[]).map((s) => [
      s.id,
      s.link_state,
    ]),
  );
  return ok(rows.map((r) => toLink(r, byId.get(r.id))));
}

export interface CreatedLiveLink {
  readonly id: string;
  /** Shown once; only its hash is stored. */
  readonly token: string;
  /** Shown once; send it apart from the link. */
  readonly accessCode: string;
  readonly expiresAt: string;
}

function createdRow(data: unknown): CreatedLiveLink | null {
  const row = (Array.isArray(data) ? data[0] : null) as {
    live_link_id: string;
    token: string | null;
    access_code: string | null;
    expires_at: string;
  } | null;
  if (!row?.token || !row.access_code) return null;
  return {
    id: row.live_link_id,
    token: row.token,
    accessCode: row.access_code,
    expiresAt: row.expires_at,
  };
}

/** Makes a live link to a saved view on a project (app.create_view_link). */
export async function createViewLink(
  db: XosClient,
  input: {
    readonly savedViewId: string;
    readonly projectId: string;
    readonly expiresAt: string;
    readonly note: string | null;
  },
): Promise<Result<CreatedLiveLink>> {
  const { data, error } = await db.rpc("create_view_link", {
    p_saved_view_id: input.savedViewId,
    p_project_id: input.projectId,
    p_expires_at: input.expiresAt,
    ...(input.note === null ? {} : { p_note: input.note }),
  });
  if (error) return fail(toDataError(error));
  const row = createdRow(data);
  return row
    ? ok(row)
    : fail({ kind: "unexpected", message: "create_view_link returned no token" });
}

/** Makes a display screen link to a running order (app.create_display_link). */
export async function createDisplayLink(
  db: XosClient,
  input: {
    readonly runOfShowId: string;
    /** Null for the default: the end of the day after the show, in the project's zone. */
    readonly expiresAt: string | null;
    readonly defaultMode: DisplayMode;
    readonly note: string | null;
  },
): Promise<Result<CreatedLiveLink>> {
  const { data, error } = await db.rpc("create_display_link", {
    p_run_of_show_id: input.runOfShowId,
    ...(input.expiresAt === null ? {} : { p_expires_at: input.expiresAt }),
    p_default_mode: input.defaultMode,
    ...(input.note === null ? {} : { p_note: input.note }),
  });
  if (error) return fail(toDataError(error));
  const row = createdRow(data);
  return row
    ? ok(row)
    : fail({ kind: "unexpected", message: "create_display_link returned no token" });
}

/** A new token and access code for a link (app.regenerate_live_link); the old ones stop at once. */
export async function regenerateLiveLink(
  db: XosClient,
  id: string,
): Promise<Result<Omit<CreatedLiveLink, "id">>> {
  const { data, error } = await db.rpc("regenerate_live_link", { p_live_link_id: id });
  if (error) return fail(toDataError(error));
  const row = (Array.isArray(data) ? data[0] : null) as {
    token: string | null;
    access_code: string | null;
    expires_at: string;
  } | null;
  if (!row?.token || !row.access_code) {
    return fail({ kind: "unexpected", message: "regenerate_live_link returned no token" });
  }
  return ok({ token: row.token, accessCode: row.access_code, expiresAt: row.expires_at });
}

/** Revokes a link (app.revoke_live_link). Answers the revocation time. */
export async function revokeLiveLink(db: XosClient, id: string): Promise<Result<string>> {
  const { data, error } = await db.rpc("revoke_live_link", { p_live_link_id: id });
  if (error) return fail(toDataError(error));
  return ok(String(data));
}

// The anonymous side -----------------------------------------------------------------------------

type PublicRpc = {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: DatabaseErrorLike | null }>;
};

function publicRpc(db: XosClient): PublicRpc {
  return (db as unknown as { schema(name: "api_public"): PublicRpc }).schema("api_public");
}

function tokenShape(kind: LiveLinkKind): RegExp {
  return kind === "View" ? LIVE_VIEW_TOKEN : DISPLAY_TOKEN;
}

export interface OpenedLiveLink {
  readonly refused: false;
  readonly grant: string;
  readonly grantExpiresAt: string;
  readonly kind: LiveLinkKind;
}

/**
 * Opens a link with its access code (api_public.open_live_link). A POST, as every token RPC must be
 * (A69-001). The client address is the one the route relays, for the per-address failure limit.
 */
export async function openLiveLink(
  db: XosClient,
  input: {
    readonly kind: LiveLinkKind;
    readonly token: string;
    readonly accessCode: string | null;
    readonly clientAddress: string | null;
  },
): Promise<Result<OpenedLiveLink | Refused>> {
  if (!tokenShape(input.kind).test(input.token)) {
    return ok({ refused: true, reason: "live_link_invalid" });
  }
  const { data, error } = await publicRpc(db).rpc("open_live_link", {
    p_token: input.token,
    p_access_code: input.accessCode,
    p_client_address: input.clientAddress,
  });
  if (error) return fail(toDataError(error));
  const body = (data ?? {}) as Record<string, unknown>;
  if (body["status"] !== "ok" || typeof body["grant"] !== "string" || body["kind"] !== input.kind) {
    return ok({
      refused: true,
      reason: body["status"] === "ok" ? "live_link_invalid" : parseRefusal(body["reason"]),
    });
  }
  return ok({
    refused: false,
    grant: body["grant"],
    grantExpiresAt: String(body["grant_expires_at"] ?? ""),
    kind: input.kind,
  });
}

/** The heading every live link page carries: the org brand's Public columns and the project. */
export interface LiveMeta {
  readonly projectName: string;
  readonly timeZone: string;
  readonly brandName: string;
  readonly brandLogoLightPath: string | null;
  readonly brandLogoDarkPath: string | null;
  readonly brandAccentHex: string | null;
  readonly suppressPoweredBy: boolean;
  readonly expiresAt: string;
}

export interface LiveRecordRow {
  readonly key: string;
  readonly title: string;
  readonly kind: string;
  readonly subtype: string | null;
  readonly state: string;
  readonly phase: string | null;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly dueAt: string | null;
  readonly timeZone: string | null;
  readonly scopeNode: string | null;
}

/** A cue as a public page sees it: never who called it, its description or its cue calls. */
export interface PublicCue {
  readonly position: number;
  readonly label: string;
  readonly segment: string | null;
  readonly plannedAt: string | null;
  readonly durationSeconds: number | null;
  readonly calledAt: string | null;
}

export interface LiveRunRow {
  readonly name: string;
  readonly showDate: string;
  readonly cues: readonly PublicCue[];
}

export interface LiveDaySheetRow {
  readonly day: string;
  /** Plain text: the page never renders it as HTML. */
  readonly body: string;
  readonly publishedAt: string | null;
}

export type LiveRows =
  | { readonly collection: "project/schedule"; readonly rows: readonly LiveRecordRow[] }
  | {
      readonly collection: "project/show" | "show/run_of_show";
      readonly rows: readonly LiveRunRow[];
    }
  | { readonly collection: "show/day_sheets"; readonly rows: readonly LiveDaySheetRow[] };

export type LiveViewType = "List" | "Board" | "Table" | "Calendar" | "Timeline";

export interface LiveView {
  readonly refused: false;
  readonly meta: LiveMeta & {
    readonly viewName: string;
    readonly viewType: LiveViewType;
    readonly groupByField: string | null;
  };
  readonly channel: string | null;
  /** The database's clock when it answered, so a page can correct its own. */
  readonly serverNow: string;
  readonly data: LiveRows;
  readonly truncated: boolean;
}

export interface LiveDisplay {
  readonly refused: false;
  readonly meta: LiveMeta & {
    readonly name: string;
    readonly showDate: string;
    readonly defaultMode: DisplayMode;
  };
  readonly channel: string | null;
  readonly serverNow: string;
  readonly cues: readonly PublicCue[];
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

function toMeta(raw: Record<string, unknown>): LiveMeta {
  return {
    projectName: str(raw["project_name"]) ?? "",
    timeZone: str(raw["time_zone"]) ?? "UTC",
    brandName: str(raw["brand_name"]) ?? "",
    brandLogoLightPath: str(raw["brand_logo_light_path"]),
    brandLogoDarkPath: str(raw["brand_logo_dark_path"]),
    brandAccentHex: str(raw["brand_accent_hex"]),
    suppressPoweredBy: raw["brand_suppress_powered_by"] === true,
    expiresAt: str(raw["expires_at"]) ?? "",
  };
}

function toCue(raw: Record<string, unknown>): PublicCue {
  return {
    position: num(raw["position"]) ?? 0,
    label: str(raw["label"]) ?? "",
    segment: str(raw["segment"]),
    plannedAt: str(raw["planned_at"]),
    durationSeconds: num(raw["duration_seconds"]),
    calledAt: str(raw["called_at"]),
  };
}

function records(rows: unknown[]): LiveRecordRow[] {
  return (rows as Record<string, unknown>[]).map((r) => ({
    key: str(r["key"]) ?? "",
    title: str(r["title"]) ?? "",
    kind: str(r["kind"]) ?? "",
    subtype: str(r["subtype"]),
    state: str(r["state"]) ?? "",
    phase: str(r["phase"]),
    startsAt: str(r["starts_at"]),
    endsAt: str(r["ends_at"]),
    dueAt: str(r["due_at"]),
    timeZone: str(r["time_zone"]),
    scopeNode: str(r["scope_node"]),
  }));
}

function toRows(collection: string, rows: unknown[]): LiveRows | null {
  switch (collection) {
    case "project/schedule":
      return { collection, rows: records(rows) };
    case "project/show":
    case "show/run_of_show":
      return {
        collection,
        rows: (rows as Record<string, unknown>[]).map((r) => ({
          name: str(r["name"]) ?? "",
          showDate: str(r["show_date"]) ?? "",
          cues: (Array.isArray(r["cues"]) ? (r["cues"] as Record<string, unknown>[]) : []).map(
            toCue,
          ),
        })),
      };
    case "show/day_sheets":
      return {
        collection,
        rows: (rows as Record<string, unknown>[]).map((r) => ({
          day: str(r["day"]) ?? "",
          body: str(r["body"]) ?? "",
          publishedAt: str(r["published_at"]),
        })),
      };
    default:
      return null;
  }
}

async function read(
  db: XosClient,
  fn: "live_view" | "live_display",
  input: { readonly token: string; readonly grant: string; readonly clientAddress: string | null },
): Promise<Result<Record<string, unknown> | Refused>> {
  if (!LIVE_GRANT.test(input.grant)) return ok({ refused: true, reason: "live_link_grant" });
  const { data, error } = await publicRpc(db).rpc(fn, {
    p_token: input.token,
    p_grant: input.grant,
    p_client_address: input.clientAddress,
  });
  if (error) return fail(toDataError(error));
  const body = (data ?? {}) as Record<string, unknown>;
  if (body["status"] !== "ok") return ok({ refused: true, reason: parseRefusal(body["reason"]) });
  return ok(body);
}

/** Reads a saved view link with its device grant (api_public.live_view). */
export async function readLiveView(
  db: XosClient,
  input: { readonly token: string; readonly grant: string; readonly clientAddress: string | null },
): Promise<Result<LiveView | Refused>> {
  if (!LIVE_VIEW_TOKEN.test(input.token)) return ok({ refused: true, reason: "live_link_invalid" });
  const body = await read(db, "live_view", input);
  if (!body.ok || "refused" in body.data) return body as Result<Refused>;
  const raw = (body.data["meta"] ?? {}) as Record<string, unknown>;
  const rows = toRows(
    str(raw["collection_key"]) ?? "",
    Array.isArray(body.data["rows"]) ? body.data["rows"] : [],
  );
  if (!rows) return ok({ refused: true, reason: "live_link_view_unsupported" });
  const viewType = str(raw["view_type"]);
  return ok({
    refused: false,
    meta: {
      ...toMeta(raw),
      viewName: str(raw["view_name"]) ?? "",
      viewType:
        viewType === "Board" ||
        viewType === "Table" ||
        viewType === "Calendar" ||
        viewType === "Timeline"
          ? viewType
          : "List",
      groupByField: str(raw["group_by_field"]),
    },
    channel: str(body.data["channel"]),
    serverNow: str(body.data["server_now"]) ?? new Date().toISOString(),
    data: rows,
    truncated: body.data["truncated"] === true,
  });
}

/** Reads a display screen link with its device grant (api_public.live_display). */
export async function readDisplay(
  db: XosClient,
  input: { readonly token: string; readonly grant: string; readonly clientAddress: string | null },
): Promise<Result<LiveDisplay | Refused>> {
  if (!DISPLAY_TOKEN.test(input.token)) return ok({ refused: true, reason: "live_link_invalid" });
  const body = await read(db, "live_display", input);
  if (!body.ok || "refused" in body.data) return body as Result<Refused>;
  const raw = (body.data["meta"] ?? {}) as Record<string, unknown>;
  const mode = raw["default_mode"];
  return ok({
    refused: false,
    meta: {
      ...toMeta(raw),
      name: str(raw["name"]) ?? "",
      showDate: str(raw["show_date"]) ?? "",
      defaultMode: isDisplayMode(mode) ? mode : "Backstage",
    },
    channel: str(body.data["channel"]),
    serverNow: str(body.data["server_now"]) ?? new Date().toISOString(),
    cues: (Array.isArray(body.data["cues"])
      ? (body.data["cues"] as Record<string, unknown>[])
      : []
    ).map(toCue),
  });
}

// What a display screen shows --------------------------------------------------------------------

export interface DisplayFrame {
  /** The running cue: the last one called. */
  readonly current: PublicCue | null;
  /** The next cue to call. */
  readonly next: PublicCue | null;
  /** The three cues after the next one. */
  readonly upcoming: readonly PublicCue[];
  /** Seconds the current cue has run. */
  readonly elapsedSeconds: number | null;
  /** Its duration minus that; negative once it runs over; null without a duration. */
  readonly remainingSeconds: number | null;
  /** True from the moment the current cue runs past its duration until the next cue is called. */
  readonly overrun: boolean;
  /** How late the current cue was called against its planned time, in seconds; negative when early. */
  readonly latenessSeconds: number | null;
  /** Seconds until the next cue's planned time; negative when it is late. */
  readonly timeToNextSeconds: number | null;
  /** Every cue is called. */
  readonly complete: boolean;
}

/** What a display screen shows at `nowMs`, from the cues in order (built on cueProgress). */
export function displayFrame(cues: readonly PublicCue[], nowMs: number): DisplayFrame {
  const progress = cueProgress(cues, new Date(nowMs));
  const current = progress.current >= 0 ? (cues[progress.current] ?? null) : null;
  const next = progress.next >= 0 ? (cues[progress.next] ?? null) : null;
  const upcoming = progress.next >= 0 ? cues.slice(progress.next + 1, progress.next + 4) : [];
  const remaining =
    current?.durationSeconds !== null &&
    current?.durationSeconds !== undefined &&
    progress.elapsedSeconds !== null
      ? current.durationSeconds - progress.elapsedSeconds
      : null;
  const lateness =
    current?.calledAt && current.plannedAt
      ? Math.round((Date.parse(current.calledAt) - Date.parse(current.plannedAt)) / 1000)
      : null;
  return {
    current,
    next,
    upcoming,
    elapsedSeconds: progress.elapsedSeconds,
    remainingSeconds: remaining,
    overrun: remaining !== null && remaining < 0,
    latenessSeconds: lateness,
    timeToNextSeconds: progress.nextInSeconds,
    complete: progress.complete,
  };
}

/** Seconds as a clock: m:ss, or h:mm:ss from an hour; the sign is dropped. */
export function clockText(seconds: number): string {
  const s = Math.abs(Math.trunc(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
