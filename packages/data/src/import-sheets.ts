import type { Sheet } from "./import-parse.ts";

/**
 * Google Sheets links for the import wizard (A83, finding A65-025; Section 4.6.2 step 1: "a Google Sheets link
 * through the Google Drive integration"). The import worker reads the spreadsheet with the org's Google Drive
 * connection: its OAuth token (Vault, read by the service role) calls the Sheets API v4 for the sheet list and
 * every grid sheet's formatted values, and the worker saves the result to the imports bucket to be scanned and
 * read like an upload. Fetch is injected, so tests never reach Google.
 *
 * The token needs read access to the spreadsheet: the scope spreadsheets.readonly or drive.readonly, and the
 * sheet shared with the Google account that connected Drive. infra/runbooks/integrations.md has the setup.
 */

export const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
/** Sheets read per link and cells per spreadsheet; a bigger one is refused with a reason. */
export const MAX_SHEETS = 50;
export const MAX_CELLS = 500_000;

export interface Workbook {
  readonly title: string;
  readonly sheets: readonly Sheet[];
}

export type SheetsFetch = (
  url: string,
  init: { readonly headers: Readonly<Record<string, string>> },
) => Promise<{ readonly status: number; json(): Promise<unknown> }>;

/** Why a link could not be read; the worker records the code on the import and Atlas explains it. */
export class GoogleSheetError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "GoogleSheetError";
    this.code = code;
    this.retryable = retryable;
  }
}

/** The spreadsheet id of a docs.google.com spreadsheet link, or null for anything else. */
export function spreadsheetId(link: string): string | null {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null; // Not a URL at all.
  }
  if (url.protocol !== "https:" || url.hostname !== "docs.google.com") return null;
  return /^\/spreadsheets\/d\/([A-Za-z0-9_-]{20,100})(?:\/|$)/.exec(url.pathname)?.[1] ?? null;
}

/** The access token of a stored Drive credential: JSON with access_token (or token), or the token alone. */
export function driveAccessToken(secret: string): string {
  const trimmed = secret.trim();
  if (!trimmed.startsWith("{")) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const token = parsed["access_token"] ?? parsed["token"];
    if (typeof token === "string" && token.length > 0) return token;
  } catch {
    // Falls through to the refusal below.
  }
  throw new GoogleSheetError(
    "google_drive_credential_malformed",
    "The Google Drive credential has no access token.",
  );
}

function failureFor(status: number): GoogleSheetError {
  if (status === 404)
    return new GoogleSheetError(
      "google_sheet_not_found",
      "The Google Sheets link points to no spreadsheet.",
    );
  if (status === 403) {
    return new GoogleSheetError(
      "google_sheet_not_shared",
      "The spreadsheet is not shared with the Google account that connected Drive.",
    );
  }
  if (status === 401) {
    return new GoogleSheetError(
      "google_drive_credential_refused",
      "Google refused the Drive connection's token; reconnect Google Drive.",
    );
  }
  return new GoogleSheetError(
    "google_sheet_unavailable",
    `Google answered ${status}.`,
    status === 429 || status >= 500,
  );
}

/** A1 sheet reference: the title in single quotes, any quote doubled. */
const quoted = (title: string) => `'${title.replace(/'/g, "''")}'`;

/** Reads every grid sheet of a linked spreadsheet as rows of formatted cell text. */
export async function readGoogleSheet(
  fetchImpl: SheetsFetch,
  token: string,
  link: string,
): Promise<Workbook> {
  const id = spreadsheetId(link);
  if (id === null)
    throw new GoogleSheetError(
      "google_sheet_link_invalid",
      "The link is not a Google Sheets spreadsheet link.",
    );
  const headers = { authorization: `Bearer ${token}`, accept: "application/json" };
  const meta = await fetchImpl(
    `${SHEETS_API}/${id}?fields=${encodeURIComponent("properties.title,sheets.properties(title,index,sheetType)")}`,
    { headers },
  );
  if (meta.status !== 200) throw failureFor(meta.status);
  const body = (await meta.json()) as {
    properties?: { title?: string };
    sheets?: { properties?: { title?: string; index?: number; sheetType?: string } }[];
  };
  const titles = (body.sheets ?? [])
    .map((s) => s.properties)
    .filter(
      (p): p is { title: string; index?: number; sheetType?: string } =>
        typeof p?.title === "string",
    )
    .filter((p) => p.sheetType === undefined || p.sheetType === "GRID")
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((p) => p.title);
  if (titles.length > MAX_SHEETS) {
    throw new GoogleSheetError(
      "google_sheet_too_large",
      `The spreadsheet has more than ${MAX_SHEETS} sheets.`,
    );
  }
  if (titles.length === 0) return { title: body.properties?.title ?? "Google Sheet", sheets: [] };
  const query = new URLSearchParams({
    valueRenderOption: "FORMATTED_VALUE",
    majorDimension: "ROWS",
  });
  for (const title of titles) query.append("ranges", quoted(title));
  const values = await fetchImpl(`${SHEETS_API}/${id}/values:batchGet?${query.toString()}`, {
    headers,
  });
  if (values.status !== 200) throw failureFor(values.status);
  const ranges =
    ((await values.json()) as { valueRanges?: { values?: unknown[][] }[] }).valueRanges ?? [];
  let cells = 0;
  const sheets = titles.map((name, i) => {
    const rows = (ranges[i]?.values ?? []).map((row) =>
      (Array.isArray(row) ? row : []).map((cell) =>
        cell === null || cell === undefined ? "" : String(cell),
      ),
    );
    cells += rows.reduce((n, r) => n + r.length, 0);
    return { name, rows };
  });
  if (cells > MAX_CELLS) {
    throw new GoogleSheetError(
      "google_sheet_too_large",
      `The spreadsheet has more than ${MAX_CELLS} cells.`,
    );
  }
  return { title: body.properties?.title ?? "Google Sheet", sheets };
}
