/**
 * The wallet-pass Edge Function's logic (A93, RRR-138): Compass posts which pass it wants (its own
 * credential or shift) and for which wallet; the pass comes from app.my_wallet_pass with the caller's own
 * token, so nobody gets a pass for another person's badge; the answer is the signed .pkpass for Apple
 * Wallet or the "Save to Google Wallet" link. A wallet whose certificate or key is not set answers 503
 * wallet_not_configured, which Compass explains in plain words.
 */
import { getMessages, isLocale, type Locale } from "@xos/i18n";
import { z } from "zod";
import { buildPkpass, type AppleWalletEnv, type WalletLabels, type WalletPass } from "./apple.ts";
import { googleSaveUrl, type GoogleWalletEnv } from "./google.ts";

export const PKPASS_TYPE = "application/vnd.apple.pkpass";

const request = z.object({
  kind: z.enum(["credential", "shift"]),
  id: z.uuid(),
  platform: z.enum(["apple", "google"]),
  locale: z.string().max(10).optional(),
});

export type WalletRequest = z.infer<typeof request>;

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

/** The pass labels in the holder's language (compass.wallet in the catalog). */
export function walletLabels(locale: Locale): WalletLabels {
  const wallet = (getMessages(locale) as unknown as { compass: { wallet: Record<string, string> } })
    .compass.wallet;
  const label = (key: keyof WalletLabels) => wallet[key] ?? key;
  return {
    holder: label("holder"),
    credential: label("credential"),
    role: label("role"),
    project: label("project"),
    starts: label("starts"),
    ends: label("ends"),
    validUntil: label("validUntil"),
    organization: label("organization"),
  };
}

export async function walletPassResponse(body: unknown, deps: WalletDeps): Promise<WalletResponse> {
  const parsed = request.safeParse(body);
  if (!parsed.success)
    return problem(422, "wallet_request_invalid", "The pass request is not valid.");
  const { kind, id, platform } = parsed.data;
  const locale: Locale =
    parsed.data.locale && isLocale(parsed.data.locale) ? parsed.data.locale : "en-US";
  const wallet = platform === "apple" ? deps.apple : deps.google;
  if (!wallet || !wallet.signer.configured)
    return problem(503, "wallet_not_configured", "Wallet passes are not set up yet.");
  const pass = await deps.loadPass(kind, id);
  if (!pass) return problem(404, "wallet_pass_not_found", "No pass of yours matches.");
  const labels = walletLabels(locale);
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
