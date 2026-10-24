/**
 * The wallet-pass Edge Function's logic (A93, RRR-138): Compass posts which pass it wants (its own
 * credential or shift), for which wallet, and the pass's labels in the person's language (from its own
 * catalog); the pass comes from app.my_wallet_pass with the caller's own token, so nobody gets a pass for
 * another person's badge; the answer is the signed .pkpass for Apple Wallet or the "Save to Google Wallet"
 * link. A wallet whose certificate or key is not set answers 503 wallet_not_configured, which Compass
 * explains in plain words.
 *
 * It loads no npm package (A85): the request is checked here and the database is reached over PostgREST
 * with fetch, so the function's cold start stays small.
 */
import { buildPkpass, type AppleWalletEnv, type WalletLabels, type WalletPass } from "./apple.ts";
import { googleSaveUrl, type GoogleWalletEnv } from "./google.ts";

export const PKPASS_TYPE = "application/vnd.apple.pkpass";

export interface WalletRequest {
  readonly kind: "credential" | "shift";
  readonly id: string;
  readonly platform: "apple" | "google";
  /** BCP 47 language of the labels, such as es-US; Google Wallet tags the pass's text with it. */
  readonly locale: string;
  readonly labels: WalletLabels;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LABEL_KEYS: readonly (keyof WalletLabels)[] = [
  "holder",
  "credential",
  "role",
  "project",
  "starts",
  "ends",
  "validUntil",
  "organization",
];

/** The request, or null when it is not one. Labels are short text, 1 to 60 characters each. */
export function parseWalletRequest(body: unknown): WalletRequest | null {
  if (body === null || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b["kind"] !== "credential" && b["kind"] !== "shift") return null;
  if (b["platform"] !== "apple" && b["platform"] !== "google") return null;
  if (typeof b["id"] !== "string" || !UUID.test(b["id"])) return null;
  const locale = typeof b["locale"] === "string" ? b["locale"] : "en-US";
  if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(locale)) return null;
  const raw = b["labels"];
  if (raw === null || typeof raw !== "object") return null;
  const labels: Partial<Record<keyof WalletLabels, string>> = {};
  for (const key of LABEL_KEYS) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value !== "string" || value.trim().length === 0 || value.length > 60) return null;
    labels[key] = value;
  }
  return {
    kind: b["kind"],
    platform: b["platform"],
    id: b["id"],
    locale,
    labels: labels as WalletLabels,
  };
}

export interface WalletDeps {
  /** The pass for the caller's own credential or shift, or null (not theirs, or not found). */
  readonly loadPass: (kind: WalletRequest["kind"], id: string) => Promise<WalletPass | null>;
  readonly apple: AppleWalletEnv | null;
  readonly google: GoogleWalletEnv | null;
}

export interface WalletResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array | string;
}

function problem(status: number, reason: string, title: string): WalletResponse {
  return {
    status,
    headers: { "content-type": "application/problem+json" },
    body: JSON.stringify({
      type: `/problems/${reason.replaceAll("_", "-")}`,
      title,
      status,
      reason,
    }),
  };
}

export async function walletPassResponse(body: unknown, deps: WalletDeps): Promise<WalletResponse> {
  const request = parseWalletRequest(body);
  if (!request) return problem(422, "wallet_request_invalid", "The pass request is not valid.");
  const { kind, id, platform, labels, locale } = request;
  const wallet = platform === "apple" ? deps.apple : deps.google;
  if (!wallet || !wallet.signer.configured)
    return problem(503, "wallet_not_configured", "Wallet passes are not set up yet.");
  const pass = await deps.loadPass(kind, id);
  if (!pass) return problem(404, "wallet_pass_not_found", "No pass of yours matches.");
  if (platform === "apple" && deps.apple) {
    const bytes = await buildPkpass(pass, deps.apple.config, labels, deps.apple.signer);
    return {
      status: 200,
      headers: {
        "content-type": PKPASS_TYPE,
        "content-disposition": `attachment; filename="${kind}.pkpass"`,
        "cache-control": "no-store",
      },
      body: bytes,
    };
  }
  const google = deps.google as GoogleWalletEnv;
  const saveUrl = await googleSaveUrl(
    pass,
    google.config,
    labels,
    locale.slice(0, 2),
    google.signer,
  );
  return {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify({ saveUrl }),
  };
}

/** A row of app.my_wallet_pass as a WalletPass, or null for no row. */
export function passFromRow(
  row: Readonly<Record<string, unknown>> | null | undefined,
): WalletPass | null {
  if (!row) return null;
  const str = (key: string) => (typeof row[key] === "string" ? (row[key] as string) : null);
  const kind = str("kind");
  const serial = str("serial");
  const startsAt = str("starts_at");
  if ((kind !== "credential" && kind !== "shift") || !serial || !startsAt) return null;
  return {
    kind,
    serial,
    orgName: str("org_name") ?? "",
    accentHex: str("accent_hex"),
    title: str("title") ?? "",
    holderName: str("holder_name") ?? "",
    projectName: str("project_name") ?? "",
    barcode: str("barcode"),
    startsAt,
    endsAt: str("ends_at"),
    timeZone: str("time_zone") ?? "UTC",
    voided: row["voided"] === true,
  };
}

/**
 * Reads the caller's own pass through PostgREST with the caller's token (row level security and the
 * function's own holder check decide), never the service role.
 */
export function callerPassLoader(options: {
  readonly supabaseUrl: string;
  readonly anonKey: string;
  readonly authorization: string;
  readonly fetch?: typeof fetch;
}): WalletDeps["loadPass"] {
  const send = options.fetch ?? fetch;
  return async (kind, id) => {
    const response = await send(
      `${options.supabaseUrl.replace(/\/+$/, "")}/rest/v1/rpc/my_wallet_pass`,
      {
        method: "POST",
        headers: {
          apikey: options.anonKey,
          authorization: options.authorization,
          "content-type": "application/json",
          "content-profile": "app",
          accept: "application/json",
        },
        body: JSON.stringify({ p_kind: kind, p_id: id }),
      },
    );
    if (!response.ok) throw new Error(`my_wallet_pass failed: HTTP ${String(response.status)}`);
    const rows = (await response.json()) as
      Record<string, unknown>[] | Record<string, unknown> | null;
    return passFromRow(Array.isArray(rows) ? rows[0] : rows);
  };
}
