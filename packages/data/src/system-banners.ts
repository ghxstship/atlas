import type { SupabaseClient } from "@supabase/supabase-js";
import { fail, ok, toDataError, type DatabaseErrorLike, type Result } from "./result.ts";

/**
 * System banners (A90, migration 1474; Section 4.10): platform-wide maintenance, incident, plan and other notices
 * the operator console publishes. Atlas, Gateway and Compass read the live ones of their shell through
 * api_public.active_system_banners, callable before sign-in. Rendering must stay cheap: the web shells answer
 * from a short-lived cache on their own route and render after the page, and Compass keeps the last answer and
 * asks again when it comes to the foreground. A person hides a dismissible banner on their device only.
 */

export type BannerSurface = "atlas" | "gateway" | "compass";
export type BannerKind = "Maintenance" | "Incident" | "Plan Notice" | "Notice";
export type BannerSeverity = "Info" | "Warning" | "Critical";

export interface SystemBanner {
  readonly id: string;
  readonly kind: BannerKind;
  readonly severity: BannerSeverity;
  /** The operator's en-US text. */
  readonly message: string;
  /** The es-US text, when the operator wrote one. */
  readonly messageEs: string | null;
  /** An https link, such as the status page for an incident. */
  readonly linkUrl: string | null;
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly dismissible: boolean;
}

/** How long a shell may serve a cached answer, in seconds. */
export const BANNER_CACHE_SECONDS = 60;

/** The device storage key of the banners a person dismissed. */
export const DISMISSED_BANNERS_KEY = "xos.system-banners.dismissed";

/** The most dismissals kept; older ones fall off, since their banners have long ended. */
const DISMISSED_LIMIT = 50;

const KINDS: readonly BannerKind[] = ["Maintenance", "Incident", "Plan Notice", "Notice"];
const SEVERITIES: readonly BannerSeverity[] = ["Info", "Warning", "Critical"];

/** The client a shell reads banners with: any Supabase client, signed in or not. */
export type BannerClient = Pick<SupabaseClient, "schema">;

function parseRow(row: Record<string, unknown>): SystemBanner | null {
  const kind = KINDS.find((k) => k === row["banner_kind"]);
  const severity = SEVERITIES.find((s) => s === row["severity"]);
  const id = row["id"];
  const message = row["message"];
  const startsAt = row["starts_at"];
  if (!kind || !severity || typeof id !== "string" || typeof message !== "string") return null;
  if (typeof startsAt !== "string") return null;
  const text = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);
  const link = text(row["link_url"]);
  return {
    id,
    kind,
    severity,
    message,
    messageEs: text(row["message_es"]),
    linkUrl: link !== null && link.startsWith("https://") ? link : null,
    startsAt,
    endsAt: text(row["ends_at"]),
    // A Critical banner always stays, whatever a row says.
    dismissible: severity !== "Critical" && row["dismissible"] === true,
  };
}

/** Parses the RPC's rows, dropping any row that is not a well-formed banner. */
export function parseBanners(data: unknown): SystemBanner[] {
  if (!Array.isArray(data)) return [];
  return data
    .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
    .map(parseRow)
    .filter((b): b is SystemBanner => b !== null);
}

/**
 * Parses banners a shell's own route answered (the SystemBanner shape, as JSON), dropping anything malformed. The
 * browser never trusts the route blindly: links must still be https and a Critical banner still stays.
 */
export function parseBannerJson(data: unknown): SystemBanner[] {
  if (!Array.isArray(data)) return [];
  return parseBanners(
    data
      .filter((b): b is Record<string, unknown> => typeof b === "object" && b !== null)
      .map((b) => ({
        id: b["id"],
        banner_kind: b["kind"],
        severity: b["severity"],
        message: b["message"],
        message_es: b["messageEs"],
        link_url: b["linkUrl"],
        starts_at: b["startsAt"],
        ends_at: b["endsAt"],
        dismissible: b["dismissible"],
      })),
  );
}

/** The live banners of one shell, at most three, most severe first. */
export async function listActiveSystemBanners(
  db: BannerClient,
  surface: BannerSurface,
): Promise<Result<SystemBanner[]>> {
  const { data, error } = (await db
    .schema("api_public")
    .rpc("active_system_banners", { p_surface: surface })) as {
    data: unknown;
    error: DatabaseErrorLike | null;
  };
  if (error) return fail(toDataError(error));
  return ok(parseBanners(data));
}

/** The banner's text in the person's language: es-US when written, else en-US. */
export function bannerText(banner: SystemBanner, locale: string): string {
  return locale.toLowerCase().startsWith("es") && banner.messageEs
    ? banner.messageEs
    : banner.message;
}

/** The ids a person dismissed on this device, from the stored value. */
export function parseDismissed(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter((v): v is string => typeof v === "string").slice(-DISMISSED_LIMIT)
      : [];
  } catch (error) {
    if (error instanceof SyntaxError) return [];
    throw error;
  }
}

/** The stored value after dismissing one more banner. */
export function addDismissed(raw: string | null | undefined, id: string): string {
  const ids = parseDismissed(raw).filter((d) => d !== id);
  return JSON.stringify([...ids, id].slice(-DISMISSED_LIMIT));
}

/**
 * What to show now: banners inside their window that the person has not dismissed (a Critical one always shows),
 * most severe first.
 */
export function visibleBanners(
  banners: readonly SystemBanner[],
  dismissed: readonly string[],
  now: Date = new Date(),
): SystemBanner[] {
  const at = now.getTime();
  const hidden = new Set(dismissed);
  return banners
    .filter((b) => Date.parse(b.startsAt) <= at && (b.endsAt === null || Date.parse(b.endsAt) > at))
    .filter((b) => !(b.dismissible && hidden.has(b.id)))
    .sort((a, b) => SEVERITIES.indexOf(b.severity) - SEVERITIES.indexOf(a.severity));
}

/** The design-system tone of a severity. */
export function bannerTone(severity: BannerSeverity): "info" | "warning" | "danger" {
  return severity === "Critical" ? "danger" : severity === "Warning" ? "warning" : "info";
}

interface CacheEntry {
  readonly at: number;
  readonly banners: SystemBanner[];
}

/**
 * A per-process cache of each shell's banners for a web server: at most one database read per shell per
 * BANNER_CACHE_SECONDS, and on a failed read the last answer stands (or none), so a banner outage never breaks a
 * page.
 */
export function createBannerCache(
  read: (surface: BannerSurface) => Promise<Result<SystemBanner[]>>,
  ttlSeconds: number = BANNER_CACHE_SECONDS,
  clock: () => number = Date.now,
) {
  const entries = new Map<BannerSurface, CacheEntry>();
  const pending = new Map<BannerSurface, Promise<SystemBanner[]>>();
  return async function cached(surface: BannerSurface): Promise<SystemBanner[]> {
    const entry = entries.get(surface);
    if (entry && clock() - entry.at < ttlSeconds * 1000) return entry.banners;
    const inFlight = pending.get(surface);
    if (inFlight) return inFlight;
    const next = read(surface)
      .then((result) => {
        const banners = result.ok ? result.data : (entry?.banners ?? []);
        entries.set(surface, { at: clock(), banners });
        return banners;
      })
      .finally(() => pending.delete(surface));
    pending.set(surface, next);
    return next;
  };
}
