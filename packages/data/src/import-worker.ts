import type { SupabaseClient } from "@supabase/supabase-js";
import {
  dataRows,
  headers,
  parseCsv,
  playbookFieldMap,
  proposeTarget,
  sheetLayout,
  suggestWithSources,
  type DataRow,
  type PlaybookColumn,
  type PlaybookSheet,
  type Sheet,
  type SheetLayout,
  type SuggestionSource,
} from "./import-parse.ts";
import {
  GoogleSheetError,
  driveAccessToken,
  readGoogleSheet,
  type SheetsFetch,
  type Workbook,
} from "./import-sheets.ts";

/**
 * The import worker (A36; Section 4.6.2 steps 2, 4, 5 and 7), run with the service role like A35's
 * report.run worker: it claims import.detect, import.validate and import.commit jobs from A18's queue.
 *   * detect: reads the uploaded spreadsheet, records its columns with a suggested field each, and marks
 *     the import Mapped for the person to confirm
 *   * validate: checks every row against the target (required fields, canon values, references by name),
 *     records the row states with per-cell issues, matches strong keys exactly and sends name plus address
 *     to the fuzzy match (0.85, merge review), and marks the import Validated
 *   * commit: writes each Valid row in the batch the person's commit opened: a create, an update of the
 *     strong key match, or a merge into the candidate the person chose, each recorded with the batch id
 *   * fetch (A83): reads a Google Sheets link through the org's Google Drive connection and saves it to the
 *     imports bucket, where it is scanned like an upload; its Clean verdict queues detection
 * Detection reads every sheet of the workbook (A83, finding A65-025): it records each sheet with its header row,
 * data range and a proposed target, and the import reads one sheet; another sheet is imported as its own import.
 * Suggestions come from a saved profile, the Playbook column map and header similarity, each with its source.
 * A failed attempt goes back to the queue while attempts remain, then the import is marked Failed.
 * A spreadsheet is parsed only once its virus scan is Clean (owner decision 10, migration 1240): the
 * database queues detection on the Clean verdict, and every step checks again before reading.
 * When validation or a commit finishes, the person who started or committed the import is sent import.finished
 * (A104, migration 1701) with a link to review it in Atlas; the database counts the rows.
 * Not exported from the package index: only the worker entry points load it, with its .xlsx reader.
 */

export const IMPORT_JOB_KINDS = [
  "import.fetch",
  "import.detect",
  "import.validate",
  "import.commit",
] as const;
export type ImportJobKind = (typeof IMPORT_JOB_KINDS)[number];

type Row = Record<string, unknown>;

export interface ClaimedJob {
  readonly jobId: string;
  readonly subjectId: string;
}

export interface ImportJobRecord {
  readonly id: string;
  readonly orgId: string;
  readonly targetCode: string;
  readonly source: string;
  readonly path: string;
  readonly filename: string;
  readonly status: string;
  readonly profileId: string | null;
  /** The sheet the import reads; null until detection picks one. */
  readonly sheetName?: string | null;
  /** The Google Sheets link of a Google Sheets import. */
  readonly sourceUrl?: string | null;
}

/** One detected sheet of a workbook, with the target proposed for it. */
export interface DetectedSheet extends SheetLayout {
  readonly name: string;
  readonly index: number;
  readonly proposedTarget: string | null;
  readonly proposedFromPlaybook: boolean;
}

export interface MappedColumn {
  readonly index: number;
  readonly fieldName: string | null;
}

export interface CellIssue {
  readonly columnIndex: number;
  readonly issue: string;
}

export interface ValidRow {
  readonly id: string;
  readonly rowNumber: number;
  readonly matchedId: string | null;
  readonly mergeInto: { table: string; id: string } | null;
}

/** The database and storage side of the worker; supabaseImportStore implements it over the service role. */
export interface ImportStore {
  claim(kind: ImportJobKind, worker: string, limit: number): Promise<ClaimedJob[]>;
  finishJob(jobId: string, succeeded: boolean, error: string | null): Promise<string>;
  job(id: string): Promise<ImportJobRecord | null>;
  batchJob(batchId: string): Promise<string | null>;
  /** The upload's virus-scan status (1240): Scanning, Clean, Infected, Scan Failed, or null. */
  scanStatus(path: string): Promise<string | null>;
  download(path: string): Promise<Uint8Array>;
  targetFields(
    targetCode: string,
  ): Promise<{ name: string; required: boolean; strongKey: boolean }[]>;
  profileMapping(profileId: string): Promise<Map<string, string>>;
  setStatus(jobId: string, status: string): Promise<void>;
  insertColumns(
    jobId: string,
    sheet: string,
    columns: { header: string; suggested: string | null; source?: SuggestionSource | null }[],
  ): Promise<void>;
  /** Records every sheet detection found (A83). */
  insertSheets(jobId: string, sheets: readonly DetectedSheet[]): Promise<void>;
  /** Records the sheet the import reads, once (A83). */
  setSheet(jobId: string, sheetName: string): Promise<void>;
  /** The Playbook column map and its sheets (xpms.playbook_column, xpms.playbook_sheet). */
  playbook(): Promise<{ columns: readonly PlaybookColumn[]; sheets: readonly PlaybookSheet[] }>;
  /** Every import target with its fields, for proposing a target per sheet. */
  importTargets(): Promise<{ code: string; fields: string[]; required: string[] }[]>;
  /** The decrypted credential of the org's Connected Google Drive connection, or null when it has none. */
  driveCredential(orgId: string): Promise<string | null>;
  /** Saves a fetched Google Sheet into the imports bucket at the import's path, to be scanned. */
  saveUpload(path: string, bytes: Uint8Array): Promise<void>;
  /** Fails an import before it was read, with the reason Atlas explains (failure_code). */
  failImport(jobId: string, code: string): Promise<void>;
  mappedColumns(jobId: string): Promise<MappedColumn[]>;
  recordRow(input: {
    jobId: string;
    sheet: string;
    rowNumber: number;
    state: "Valid" | "Invalid" | "Skipped";
    reason: string | null;
    matchName: string | null;
    matchAddress: string | null;
  }): Promise<string>;
  recordCellIssues(rowId: string, issues: readonly CellIssue[]): Promise<void>;
  recordMatch(rowId: string, targetId: string): Promise<void>;
  validRows(jobId: string): Promise<ValidRow[]>;
  commitWrite(input: {
    rowId: string;
    batchId: string;
    targetId: string;
    action: "Created" | "Updated" | "Merged";
    before: Row | null;
  }): Promise<void>;
  refuseRow(rowId: string, reason: string): Promise<void>;
  finishBatch(batchId: string): Promise<void>;
  /** The org's slug, the first segment of its Atlas paths. */
  orgSlug(orgId: string): Promise<string | null>;
  /**
   * Sends import.finished (1701) for a validated import (no batch) or a committed batch, with the absolute link that
   * reviews it; the database counts the rows and picks the person.
   */
  notifyFinished(input: { jobId: string; batchId: string | null; url: string }): Promise<void>;
  /** Target lookups and writes. */
  lookups: TargetLookups;
}

export interface TargetLookups {
  counterpartyTypeExists(type: string): Promise<boolean>;
  jurisdictionExists(id: string): Promise<boolean>;
  vendorIdByName(orgId: string, name: string): Promise<string | null>;
  elementExists(id: string): Promise<boolean>;
  assetClassId(orgId: string, idOrName: string): Promise<string | null>;
  venueId(orgId: string, idOrName: string): Promise<string | null>;
  strongKeyMatch(
    orgId: string,
    targetCode: string,
    values: Readonly<Record<string, string>>,
  ): Promise<string | null>;
  create(orgId: string, targetCode: string, values: Row): Promise<string>;
  update(targetCode: string, id: string, values: Row): Promise<Row>;
}

export interface ImportJobResult {
  readonly kind: ImportJobKind;
  readonly jobId: string;
  readonly subjectId: string;
  readonly status: "Succeeded" | "Queued" | "Failed" | "Skipped";
  readonly error?: string;
  /** Why import.finished was not sent for a step that succeeded. */
  readonly noticeError?: string;
}

// Reading the spreadsheet ---------------------------------------------------------------------------------

/**
 * Every sheet of an upload, in workbook order: CSV as one sheet named after the file, .xlsx (and a saved Google
 * Sheets link, which the fetch step stores as .xlsx) through exceljs, loaded only here.
 */
export async function readWorkbook(
  source: string,
  filename: string,
  bytes: Uint8Array,
): Promise<Sheet[]> {
  if (source === "CSV") {
    return [{ name: filename, rows: parseCsv(new TextDecoder().decode(bytes)) }];
  }
  if (source === "XLSX" || source === "Google Sheets") {
    const { default: ExcelJS } = await import("exceljs");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    );
    return workbook.worksheets.map((sheet) => {
      const rows: string[][] = [];
      sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
        const cells: string[] = [];
        row.eachCell({ includeEmpty: true }, (cell, col) => {
          cells[col - 1] = cell.text ?? "";
        });
        rows[rowNumber - 1] = Array.from(cells, (c) => c ?? "");
      });
      return { name: sheet.name, rows: Array.from(rows, (r) => r ?? []) };
    });
  }
  throw new UnreadableUploadError(source);
}

/** The first sheet of an upload (an empty sheet named after the file when the workbook has none). */
export async function readSheet(
  source: string,
  filename: string,
  bytes: Uint8Array,
): Promise<Sheet> {
  return (await readWorkbook(source, filename, bytes))[0] ?? { name: filename, rows: [] };
}

/** The sheet an import reads: the named one, else the first with data rows, else the first. */
export function pickSheet(sheets: readonly Sheet[], name: string | null | undefined): Sheet | null {
  if (name) return sheets.find((s) => s.name === name) ?? null;
  return sheets.find((s) => dataRows(s).length > 0) ?? sheets[0] ?? null;
}

/** Writes a fetched Google Sheet as .xlsx, one worksheet per sheet, every cell as text. */
export async function writeWorkbook(workbook: Workbook): Promise<Uint8Array> {
  const { default: ExcelJS } = await import("exceljs");
  const book = new ExcelJS.Workbook();
  const used = new Set<string>();
  for (const sheet of workbook.sheets) {
    // Excel limits a worksheet name to 31 characters without []:*?/\; keep names unique after trimming.
    const base =
      sheet.name
        .replace(/[[\]:*?/\\]/g, " ")
        .slice(0, 31)
        .trim() || "Sheet";
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n += 1) name = `${base.slice(0, 27)} (${n})`;
    used.add(name.toLowerCase());
    const target = book.addWorksheet(name);
    for (const row of sheet.rows) target.addRow([...row]);
  }
  return new Uint8Array(await book.xlsx.writeBuffer());
}

export class UnreadableUploadError extends Error {
  constructor(source: string) {
    super(`${source} files are not read by the import worker; upload .csv or .xlsx.`);
    this.name = "UnreadableUploadError";
  }
}

// Validation ------------------------------------------------------------------------------------------------

const INTEGER = /^-?\d+$/;
const CURRENCY = /^[A-Z]{3}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

export interface Validated {
  readonly state: "Valid" | "Invalid";
  readonly issues: CellIssue[];
  /** Values ready to write, keyed by target column. */
  readonly values: Row;
  readonly strongKeys: Record<string, string>;
  readonly matchName: string | null;
  readonly matchAddress: string | null;
}

/** Checks one row against its target; cell issues name the column and an issue code from the catalogs. */
export async function validateRow(
  orgId: string,
  targetCode: string,
  fields: readonly { name: string; required: boolean; strongKey: boolean }[],
  columns: readonly MappedColumn[],
  row: DataRow,
  lookups: TargetLookups,
): Promise<Validated> {
  const issues: CellIssue[] = [];
  const raw: Record<string, { value: string; column: number }> = {};
  for (const c of columns) {
    if (c.fieldName) raw[c.fieldName] = { value: row.cells[c.index] ?? "", column: c.index };
  }
  const columnOf = (field: string) =>
    raw[field]?.column ?? columns.find((c) => c.fieldName === field)?.index ?? 0;
  for (const f of fields) {
    if (f.required && !(raw[f.name]?.value ?? ""))
      issues.push({ columnIndex: columnOf(f.name), issue: "required" });
  }
  const values: Row = {};
  const text = (field: string) => raw[field]?.value ?? "";
  const set = async (
    field: string,
    check: (v: string) => Promise<unknown> | unknown,
    issue: string,
    column = field,
  ) => {
    const v = text(field);
    if (!v) return;
    const out = await check(v);
    if (out === null || out === false || out === undefined)
      issues.push({ columnIndex: columnOf(field), issue });
    else values[column] = out === true ? v : out;
  };

  switch (targetCode) {
    case "counterparties":
      if (text("name")) values["name"] = text("name");
      await set(
        "counterparty_type",
        (v) => lookups.counterpartyTypeExists(v),
        "unknown_counterparty_type",
      );
      break;
    case "venues":
      for (const f of ["name", "street_address", "locality", "postal_code"])
        if (text(f)) values[f] = text(f);
      await set("jurisdiction_id", (v) => lookups.jurisdictionExists(v), "unknown_jurisdiction");
      await set("time_zone", (v) => isTimeZone(v), "unknown_time_zone");
      break;
    case "vendor_products":
      if (text("vendor_sku")) values["vendor_sku"] = text("vendor_sku");
      await set(
        "vendor_name",
        (v) => lookups.vendorIdByName(orgId, v),
        "unknown_vendor",
        "vendor_id",
      );
      await set("element_id", (v) => lookups.elementExists(v), "unknown_element");
      await set(
        "unit_price_minor",
        (v) => (INTEGER.test(v) && Number(v) >= 0 ? Number(v) : null),
        "invalid_amount",
      );
      await set(
        "currency_code",
        (v) => (CURRENCY.test(v.toUpperCase()) ? v.toUpperCase() : null),
        "invalid_currency",
      );
      await set(
        "lead_time_days",
        (v) => (INTEGER.test(v) && Number(v) >= 0 ? Number(v) : null),
        "invalid_number",
      );
      if (values["unit_price_minor"] !== undefined && values["currency_code"] === undefined) {
        issues.push({ columnIndex: columnOf("unit_price_minor"), issue: "currency_required" });
      }
      break;
    case "asset_units":
      if (text("asset_tag")) values["asset_tag"] = text("asset_tag");
      await set("asset_class_id", (v) => lookups.assetClassId(orgId, v), "unknown_asset_class");
      await set("home_venue_id", (v) => lookups.venueId(orgId, v), "unknown_venue");
      break;
    default:
      issues.push({ columnIndex: 0, issue: "target_not_importable" });
  }
  const strongKeys: Record<string, string> = {};
  for (const f of fields) if (f.strongKey && text(f.name)) strongKeys[f.name] = text(f.name);
  if (targetCode === "vendor_products" && typeof values["vendor_id"] === "string")
    strongKeys["vendor_id"] = values["vendor_id"];
  const fuzzy = targetCode === "venues" || targetCode === "counterparties";
  return {
    state: issues.length === 0 ? "Valid" : "Invalid",
    issues,
    values,
    strongKeys,
    matchName: fuzzy && text("name") ? text("name") : null,
    matchAddress:
      targetCode === "venues"
        ? [text("street_address"), text("locality"), text("postal_code")]
            .filter(Boolean)
            .join(" ") || null
        : null,
  };
}

// The jobs ---------------------------------------------------------------------------------------------------

/** The upload has not scanned Clean yet; the job goes back to the queue. */
export class UploadNotScannedError extends Error {
  constructor(status: string | null) {
    super(
      `The spreadsheet is not scanned yet (${status ?? "no scan"}); it is read once it scans Clean.`,
    );
    this.name = "UploadNotScannedError";
  }
}

/** The upload was Infected or refused by the scanner: it is never read. */
export class UploadRejectedError extends Error {
  constructor(status: string) {
    super(`The spreadsheet was not read: its virus scan is ${status}.`);
    this.name = "UploadRejectedError";
  }
}

/** Downloads the upload only once its scan is Clean. */
/** Downloads the upload only once its scan is Clean, and reads every sheet. */
async function readUploadWorkbook(store: ImportStore, job: ImportJobRecord): Promise<Sheet[]> {
  const status = await store.scanStatus(job.path);
  if (status === "Infected" || status === "Scan Failed") throw new UploadRejectedError(status);
  if (status !== "Clean") throw new UploadNotScannedError(status);
  return readWorkbook(job.source, job.filename, await store.download(job.path));
}

/** The sheet the import reads, once its upload is Clean. */
async function readUpload(store: ImportStore, job: ImportJobRecord): Promise<Sheet> {
  const sheet = pickSheet(await readUploadWorkbook(store, job), job.sheetName);
  if (sheet === null) throw new Error(`The sheet ${job.sheetName ?? ""} is no longer in the file.`);
  return sheet;
}

async function detect(store: ImportStore, jobId: string): Promise<StepNote> {
  const job = await store.job(jobId);
  if (!job || job.status !== "Uploaded") return;
  let sheets: Sheet[];
  try {
    sheets = await readUploadWorkbook(store, job);
  } catch (error) {
    if (!(error instanceof UploadRejectedError)) throw error;
    // Atlas tells the uploader why (app.my_upload_scan_status); nothing is retried.
    await store.setStatus(job.id, "Failed");
    return;
  }
  const sheet = pickSheet(sheets, job.sheetName) ?? { name: job.filename, rows: [] };
  const [targets, playbook] = await Promise.all([store.importTargets(), store.playbook()]);
  const fields = (await store.targetFields(job.targetCode)).map((f) => f.name);
  const profile = job.profileId
    ? await store.profileMapping(job.profileId)
    : new Map<string, string>();
  const heads = headers(sheet);
  const suggested = suggestWithSources(
    heads,
    fields,
    profile,
    playbookFieldMap(playbook.columns, job.targetCode, fields),
  );
  await store.setStatus(job.id, "Detected");
  // An import started from a detected sheet already names its sheet; the first import lists them all.
  if (job.sheetName === null || job.sheetName === undefined) {
    await store.insertSheets(
      job.id,
      sheets.slice(0, 1000).map((s, index) => {
        const proposal = proposeTarget(s, targets, playbook.sheets, playbook.columns);
        return {
          name: s.name.slice(0, 200) || `Sheet ${index + 1}`,
          index,
          ...sheetLayout(s),
          proposedTarget: proposal.targetCode,
          proposedFromPlaybook: proposal.fromPlaybook,
        };
      }),
    );
    await store.setSheet(job.id, sheet.name.slice(0, 200) || "Sheet 1");
  }
  await store.insertColumns(
    job.id,
    sheet.name,
    heads.map((header, i) => ({
      header: header.slice(0, 200),
      suggested: suggested[i]?.field ?? null,
      source: suggested[i]?.source ?? null,
    })),
  );
  await store.setStatus(job.id, "Mapped");
}

/** What the worker entry points pass: fetch for the Google Sheets reader, and Atlas's address for review links. */
export interface ImportWorkerOptions {
  readonly sheetsFetch?: SheetsFetch;
  /** Atlas's origin (XOS_APP_URL), such as https://atlas.example. Without it nobody is told an import finished. */
  readonly appUrl?: string;
}

/** Where an import is reviewed in Atlas: the import wizard opened at that import (`/{org}/import?import={id}`). */
export function importReviewUrl(appUrl: string, orgSlug: string, jobId: string): string {
  const url = new URL(`/${encodeURIComponent(orgSlug)}/import`, appUrl);
  url.searchParams.set("import", jobId);
  return url.toString();
}

/** What a step reports beyond succeeding: why the person was not told the import finished. */
type StepNote = { readonly noticeError: string } | undefined;

/**
 * Tells the person an import finished validating (no batch) or committing (import.finished). The step's own work is
 * done by then, so a notice that cannot be sent never fails or repeats it: the error comes back with the result.
 */
async function notifyFinished(
  store: ImportStore,
  job: ImportJobRecord,
  batchId: string | null,
  options: ImportWorkerOptions,
): Promise<StepNote> {
  if (!options.appUrl) return undefined;
  try {
    const slug = await store.orgSlug(job.orgId);
    if (slug === null) return { noticeError: `The org of import ${job.id} has no slug.` };
    await store.notifyFinished({
      jobId: job.id,
      batchId,
      url: importReviewUrl(options.appUrl, slug, job.id),
    });
    return undefined;
  } catch (error) {
    return { noticeError: error instanceof Error ? error.message : String(error) };
  }
}

/** import.fetch: reads a Google Sheets link through the org's Drive connection and saves it for scanning. */
async function fetchSheet(
  store: ImportStore,
  jobId: string,
  options: ImportWorkerOptions,
): Promise<StepNote> {
  const job = await store.job(jobId);
  if (!job || job.status !== "Uploaded" || job.source !== "Google Sheets" || !job.sourceUrl) return;
  // Already saved (a retried job): the scan verdict queues detection.
  if ((await store.scanStatus(job.path)) !== null) return;
  if (!options.sheetsFetch) throw new Error("The import worker has no Google Sheets reader.");
  const credential = await store.driveCredential(job.orgId);
  if (credential === null) {
    await store.failImport(job.id, "google_drive_not_connected");
    return;
  }
  let workbook: Workbook;
  try {
    workbook = await readGoogleSheet(
      options.sheetsFetch,
      driveAccessToken(credential),
      job.sourceUrl,
    );
  } catch (error) {
    if (error instanceof GoogleSheetError && !error.retryable) {
      await store.failImport(job.id, error.code);
      return;
    }
    throw error;
  }
  if (workbook.sheets.length === 0) {
    await store.failImport(job.id, "google_sheet_empty");
    return;
  }
  await store.saveUpload(job.path, await writeWorkbook(workbook));
}

async function validate(
  store: ImportStore,
  jobId: string,
  options: ImportWorkerOptions,
): Promise<StepNote> {
  const job = await store.job(jobId);
  if (!job || job.status !== "Mapped") return;
  const sheet = await readUpload(store, job);
  const fields = await store.targetFields(job.targetCode);
  const columns = await store.mappedColumns(job.id);
  for (const row of dataRows(sheet)) {
    const checked = await validateRow(
      job.orgId,
      job.targetCode,
      fields,
      columns,
      row,
      store.lookups,
    );
    const rowId = await store.recordRow({
      jobId: job.id,
      sheet: sheet.name,
      rowNumber: row.rowNumber,
      state: checked.state,
      reason: checked.state === "Invalid" ? checked.issues.map((i) => i.issue).join(", ") : null,
      matchName: checked.state === "Valid" ? checked.matchName : null,
      matchAddress: checked.state === "Valid" ? checked.matchAddress : null,
    });
    if (checked.issues.length > 0) await store.recordCellIssues(rowId, checked.issues);
    if (checked.state === "Valid" && Object.keys(checked.strongKeys).length > 0) {
      const match = await store.lookups.strongKeyMatch(
        job.orgId,
        job.targetCode,
        checked.strongKeys,
      );
      if (match) await store.recordMatch(rowId, match);
    }
  }
  await store.setStatus(job.id, "Validated");
  return notifyFinished(store, job, null, options);
}

async function commit(
  store: ImportStore,
  batchId: string,
  options: ImportWorkerOptions,
): Promise<StepNote> {
  const jobId = await store.batchJob(batchId);
  const job = jobId ? await store.job(jobId) : null;
  if (!job || job.status !== "Committing") return;
  const sheet = await readUpload(store, job);
  const fields = await store.targetFields(job.targetCode);
  const columns = await store.mappedColumns(job.id);
  const byNumber = new Map(dataRows(sheet).map((r) => [r.rowNumber, r]));
  for (const valid of await store.validRows(job.id)) {
    const row = byNumber.get(valid.rowNumber);
    if (!row) {
      await store.refuseRow(valid.id, "The row is no longer in the uploaded file.");
      continue;
    }
    const checked = await validateRow(
      job.orgId,
      job.targetCode,
      fields,
      columns,
      row,
      store.lookups,
    );
    if (checked.state !== "Valid") {
      await store.refuseRow(valid.id, checked.issues.map((i) => i.issue).join(", "));
      continue;
    }
    try {
      const target = valid.mergeInto?.id ?? valid.matchedId;
      if (target) {
        const changes = { ...checked.values };
        if (job.targetCode === "counterparties") delete changes["name"];
        const before = await store.lookups.update(job.targetCode, target, changes);
        await store.commitWrite({
          rowId: valid.id,
          batchId,
          targetId: target,
          action: valid.mergeInto ? "Merged" : "Updated",
          before,
        });
      } else {
        const id = await store.lookups.create(job.orgId, job.targetCode, checked.values);
        await store.commitWrite({
          rowId: valid.id,
          batchId,
          targetId: id,
          action: "Created",
          before: null,
        });
      }
    } catch (error) {
      if (!(error instanceof ImportWriteError)) throw error;
      await store.refuseRow(valid.id, error.message.slice(0, 1000));
    }
  }
  await store.finishBatch(batchId);
  return notifyFinished(store, job, batchId, options);
}

/** A row the database refused to write; the row is marked Refused with the reason and the batch goes on. */
export class ImportWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportWriteError";
  }
}

type Step = (
  store: ImportStore,
  subjectId: string,
  options: ImportWorkerOptions,
) => Promise<StepNote>;

const STEPS: Record<ImportJobKind, Step> = {
  "import.fetch": fetchSheet,
  "import.detect": detect,
  "import.validate": validate,
  "import.commit": commit,
};

/** One pass of the worker over every import job kind. */
export async function runImportJobs(
  store: ImportStore,
  worker: string,
  limit = 10,
  options: ImportWorkerOptions = {},
): Promise<ImportJobResult[]> {
  const results: ImportJobResult[] = [];
  for (const kind of IMPORT_JOB_KINDS) {
    for (const claimed of await store.claim(kind, worker, limit)) {
      try {
        const note = await STEPS[kind](store, claimed.subjectId, options);
        await store.finishJob(claimed.jobId, true, null);
        results.push({
          kind,
          jobId: claimed.jobId,
          subjectId: claimed.subjectId,
          status: "Succeeded",
          ...(note ? { noticeError: note.noticeError } : {}),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = await store.finishJob(claimed.jobId, false, message);
        if (status === "Failed") {
          const jobId =
            kind === "import.commit" ? await store.batchJob(claimed.subjectId) : claimed.subjectId;
          if (jobId && kind === "import.fetch") {
            await store.failImport(jobId, "google_sheet_unavailable");
          } else if (jobId) await store.setStatus(jobId, "Failed");
        }
        results.push({
          kind,
          jobId: claimed.jobId,
          subjectId: claimed.subjectId,
          status: status === "Failed" ? "Failed" : "Queued",
          error: message,
        });
      }
    }
  }
  return results;
}

/** Runs passes until no import job is left to claim, for local runs and tests; at most `passes` passes. */
export async function drainImportJobs(
  store: ImportStore,
  worker: string,
  passes = 5,
  options: ImportWorkerOptions = {},
): Promise<ImportJobResult[]> {
  const all: ImportJobResult[] = [];
  for (let i = 0; i < passes; i += 1) {
    const results = await runImportJobs(store, worker, 10, options);
    all.push(...results);
    if (results.length === 0) break;
  }
  return all;
}

// The service-role store ---------------------------------------------------------------------------------------

const TABLES: Readonly<Record<string, string>> = {
  venues: "venues",
  counterparties: "counterparties",
  vendor_products: "vendor_products",
  asset_units: "asset_units",
};

function text(row: Row | null | undefined, key: string): string {
  const v = row?.[key];
  if (typeof v !== "string") throw new Error(`Expected text in ${key} of the database response.`);
  return v;
}

/** ImportStore over a service-role Supabase client: A18's worker RPCs, the import tables and Storage. */
export function supabaseImportStore(client: SupabaseClient): ImportStore {
  const app = client.schema("app");
  const canon = client.schema("xpms");
  const call = async (fn: string, args: Row): Promise<unknown> => {
    const { data, error } = await app.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data;
  };
  const one = async (
    query: PromiseLike<{ data: unknown; error: { message: string } | null }>,
    what: string,
  ): Promise<Row | null> => {
    const { data, error } = await query;
    if (error) throw new Error(`${what}: ${error.message}`);
    const rows = (Array.isArray(data) ? data : data ? [data] : []) as Row[];
    return rows[0] ?? null;
  };
  const exec = async (query: PromiseLike<{ error: { message: string } | null }>, what: string) => {
    const { error } = await query;
    if (error) throw new Error(`${what}: ${error.message}`);
  };
  const lookups: TargetLookups = {
    async counterpartyTypeExists(type) {
      return (
        (await one(
          canon
            .from("dim_counterparty_type")
            .select("counterparty_type")
            .eq("counterparty_type", type)
            .limit(1),
          "counterparty types",
        )) !== null
      );
    },
    async jurisdictionExists(id) {
      return (
        (await one(
          canon.from("jurisdiction").select("jurisdiction_id").eq("jurisdiction_id", id).limit(1),
          "jurisdictions",
        )) !== null
      );
    },
    async vendorIdByName(orgId, name) {
      const { data, error } = await app
        .from("vendors")
        .select("id, counterparties!inner (counterparty_name)")
        .eq("org_id", orgId)
        .is("deleted_at", null);
      if (error) throw new Error(`vendors: ${error.message}`);
      const match = ((data as Row[] | null) ?? []).find((v) => {
        const cp = v["counterparties"] as Row | null;
        return (
          typeof cp?.["counterparty_name"] === "string" &&
          cp["counterparty_name"].toLowerCase() === name.toLowerCase()
        );
      });
      return match ? text(match, "id") : null;
    },
    async elementExists(id) {
      return (
        (await one(
          canon.from("elements").select("element_id").eq("element_id", id).limit(1),
          "elements",
        )) !== null
      );
    },
    async assetClassId(orgId, idOrName) {
      const query = app
        .from("asset_classes")
        .select("id")
        .eq("org_id", orgId)
        .is("deleted_at", null)
        .limit(1);
      const row = await one(
        UUID.test(idOrName) ? query.eq("id", idOrName) : query.ilike("name", idOrName),
        "asset classes",
      );
      return row ? text(row, "id") : null;
    },
    async venueId(orgId, idOrName) {
      const query = app
        .from("venues")
        .select("id")
        .eq("org_id", orgId)
        .is("deleted_at", null)
        .limit(1);
      const row = await one(
        UUID.test(idOrName) ? query.eq("id", idOrName) : query.ilike("name", idOrName),
        "venues",
      );
      return row ? text(row, "id") : null;
    },
    async strongKeyMatch(orgId, targetCode, values) {
      const table = TABLES[targetCode];
      if (!table || Object.keys(values).length === 0) return null;
      let query = app.from(table).select("id").eq("org_id", orgId).is("deleted_at", null).limit(1);
      for (const [k, v] of Object.entries(values)) query = query.eq(k, v);
      const row = await one(query, table);
      return row ? text(row, "id") : null;
    },
    async create(orgId, targetCode, values) {
      if (targetCode === "counterparties") {
        const name = String(values["name"]);
        const base =
          name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 36) || "org";
        const suffix = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) =>
          b.toString(16).padStart(2, "0"),
        ).join("");
        const org = await one(
          app
            .from("organizations")
            .insert({ name, slug: `${base.length < 2 ? "org" : base}-${suffix}` })
            .select("id"),
          "organizations",
        );
        const { data, error } = await app
          .from("counterparties")
          .insert({
            org_id: orgId,
            organization_id: text(org, "id"),
            counterparty_type: values["counterparty_type"] ?? null,
          })
          .select("id");
        if (error) throw new ImportWriteError(error.message);
        return text((data as Row[])[0], "id");
      }
      const table = TABLES[targetCode];
      if (!table) throw new ImportWriteError(`${targetCode} is not an import target.`);
      const { data, error } = await app
        .from(table)
        .insert({ org_id: orgId, ...values })
        .select("id");
      if (error) throw new ImportWriteError(error.message);
      return text((data as Row[])[0], "id");
    },
    async update(targetCode, id, values) {
      const table = TABLES[targetCode];
      if (!table) throw new ImportWriteError(`${targetCode} is not an import target.`);
      const columns = Object.keys(values);
      const before = await one(
        app
          .from(table)
          .select(columns.length > 0 ? columns.join(",") : "id")
          .eq("id", id),
        table,
      );
      if (!before) throw new ImportWriteError("The row to update no longer exists.");
      if (columns.length > 0) {
        const { error } = await app.from(table).update(values).eq("id", id);
        if (error) throw new ImportWriteError(error.message);
      }
      return before;
    },
  };
  return {
    lookups,
    async claim(kind, worker, limit) {
      const rows = (await call("claim_jobs", {
        p_worker: worker,
        p_job_kind: kind,
        p_limit: limit,
      })) as Row[] | null;
      return (rows ?? []).map((r) => ({ jobId: text(r, "id"), subjectId: text(r, "subject_id") }));
    },
    async finishJob(jobId, succeeded, error) {
      return String(
        await call("finish_job", { p_job_id: jobId, p_succeeded: succeeded, p_error: error }),
      );
    },
    async job(id) {
      const row = await one(
        app
          .from("import_jobs")
          .select(
            "id, org_id, target_code, source, storage_object_path, original_filename, import_status, import_mapping_profile_id, sheet_name, source_url",
          )
          .eq("id", id)
          .is("deleted_at", null),
        "import_jobs",
      );
      const optional = (key: string) => (typeof row?.[key] === "string" ? row[key] : null);
      return row
        ? {
            id: text(row, "id"),
            orgId: text(row, "org_id"),
            targetCode: text(row, "target_code"),
            source: text(row, "source"),
            path: text(row, "storage_object_path"),
            filename: text(row, "original_filename"),
            status: text(row, "import_status"),
            profileId: optional("import_mapping_profile_id"),
            sheetName: optional("sheet_name"),
            sourceUrl: optional("source_url"),
          }
        : null;
    },
    async insertSheets(jobId, sheets) {
      if (sheets.length === 0) return;
      await exec(
        app.from("import_job_sheets").insert(
          sheets.map((s) => ({
            import_job_id: jobId,
            sheet_name: s.name,
            sheet_index: s.index,
            header_row: s.headerRow,
            first_data_row: s.firstDataRow,
            last_row: s.lastRow,
            column_count: s.columnCount,
            data_row_count: s.dataRowCount,
            proposed_target_code: s.proposedTarget,
            proposed_from_playbook: s.proposedFromPlaybook,
          })),
        ),
        "import_job_sheets",
      );
    },
    async setSheet(jobId, sheetName) {
      await exec(
        app.from("import_jobs").update({ sheet_name: sheetName }).eq("id", jobId),
        "import_jobs",
      );
    },
    async playbook() {
      const [columns, sheets] = await Promise.all([
        canon
          .from("playbook_column")
          .select("sheet_name, header, target")
          .eq("disposition", "field")
          .not("header", "is", null),
        canon.from("playbook_sheet").select("sheet_name, entity"),
      ]);
      if (columns.error) throw new Error(`playbook_column: ${columns.error.message}`);
      if (sheets.error) throw new Error(`playbook_sheet: ${sheets.error.message}`);
      return {
        columns: ((columns.data as Row[] | null) ?? [])
          .filter((c) => typeof c["header"] === "string" && typeof c["target"] === "string")
          .map((c) => ({
            sheet: text(c, "sheet_name"),
            header: text(c, "header"),
            target: text(c, "target"),
          })),
        sheets: ((sheets.data as Row[] | null) ?? [])
          .filter((s) => typeof s["entity"] === "string")
          .map((s) => ({ sheet: text(s, "sheet_name"), entity: text(s, "entity") })),
      };
    },
    async importTargets() {
      const { data, error } = await app
        .from("import_target_fields")
        .select("target_code, field_name, required");
      if (error) throw new Error(`import_target_fields: ${error.message}`);
      const byTarget = new Map<string, { code: string; fields: string[]; required: string[] }>();
      for (const f of (data as Row[] | null) ?? []) {
        const code = text(f, "target_code");
        const entry = byTarget.get(code) ?? { code, fields: [], required: [] };
        entry.fields.push(text(f, "field_name"));
        if (f["required"] === true) entry.required.push(text(f, "field_name"));
        byTarget.set(code, entry);
      }
      return [...byTarget.values()].sort((a, b) => a.code.localeCompare(b.code));
    },
    async driveCredential(orgId) {
      const connection = await one(
        app
          .from("integration_connections")
          .select("id")
          .eq("org_id", orgId)
          .eq("provider_code", "google_drive")
          .eq("connection_state", "Connected")
          .is("deleted_at", null)
          .order("created_at")
          .limit(1),
        "integration_connections",
      );
      if (!connection) return null;
      const secret = await call("read_integration_credential", {
        p_connection_id: text(connection, "id"),
      });
      return typeof secret === "string" ? secret : null;
    },
    async saveUpload(path, bytes) {
      const { error } = await client.storage.from("imports").upload(path, bytes, {
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        upsert: false,
      });
      if (error) throw new Error(`imports ${path}: ${error.message}`);
    },
    async failImport(jobId, code) {
      await exec(
        app
          .from("import_jobs")
          .update({ import_status: "Failed", failure_code: code })
          .eq("id", jobId),
        "import_jobs",
      );
    },
    async batchJob(batchId) {
      const row = await one(
        app.from("import_batches").select("import_job_id").eq("id", batchId),
        "import_batches",
      );
      return row ? text(row, "import_job_id") : null;
    },
    async scanStatus(path) {
      const status = await call("object_scan_status", {
        p_bucket_id: "imports",
        p_object_name: path,
      });
      return typeof status === "string" ? status : null;
    },
    async download(path) {
      const { data, error } = await client.storage.from("imports").download(path);
      if (error || !data) throw new Error(`imports ${path}: ${error?.message ?? "no file"}`);
      return new Uint8Array(await data.arrayBuffer());
    },
    async targetFields(targetCode) {
      const { data, error } = await app
        .from("import_target_fields")
        .select("field_name, required, strong_key")
        .eq("target_code", targetCode);
      if (error) throw new Error(`import_target_fields: ${error.message}`);
      return ((data as Row[] | null) ?? []).map((f) => ({
        name: text(f, "field_name"),
        required: f["required"] === true,
        strongKey: f["strong_key"] === true,
      }));
    },
    async profileMapping(profileId) {
      const { data, error } = await app
        .from("import_mapping_profile_fields")
        .select("source_header, field_name")
        .eq("import_mapping_profile_id", profileId)
        .is("deleted_at", null);
      if (error) throw new Error(`import_mapping_profile_fields: ${error.message}`);
      return new Map(
        ((data as Row[] | null) ?? []).map((r) => [
          text(r, "source_header").toLowerCase(),
          text(r, "field_name"),
        ]),
      );
    },
    async setStatus(jobId, status) {
      await exec(
        app.from("import_jobs").update({ import_status: status }).eq("id", jobId),
        "import_jobs",
      );
    },
    async insertColumns(jobId, sheet, columns) {
      if (columns.length === 0) return;
      await exec(
        app.from("import_job_columns").insert(
          columns.map((c, i) => ({
            import_job_id: jobId,
            sheet_name: sheet,
            column_index: i,
            header: c.header,
            suggested_field_name: c.suggested,
            suggestion_source: c.suggested === null ? null : (c.source ?? null),
          })),
        ),
        "import_job_columns",
      );
    },
    async mappedColumns(jobId) {
      const { data, error } = await app
        .from("import_job_columns")
        .select("column_index, field_name")
        .eq("import_job_id", jobId)
        .is("deleted_at", null)
        .order("column_index");
      if (error) throw new Error(`import_job_columns: ${error.message}`);
      return ((data as Row[] | null) ?? []).map((c) => ({
        index: Number(c["column_index"]),
        fieldName: typeof c["field_name"] === "string" ? c["field_name"] : null,
      }));
    },
    async recordRow(input) {
      return String(
        await call("record_import_row", {
          p_import_job_id: input.jobId,
          p_sheet_name: input.sheet,
          p_row_number: input.rowNumber,
          p_row_state: input.state,
          p_reason: input.reason,
          p_match_name: input.matchName,
          p_match_address: input.matchAddress,
        }),
      );
    },
    async recordCellIssues(rowId, issues) {
      await exec(
        app.from("import_cell_issues").insert(
          issues.map((i) => ({
            import_row_result_id: rowId,
            column_index: i.columnIndex,
            issue_code: i.issue,
          })),
        ),
        "import_cell_issues",
      );
    },
    async recordMatch(rowId, targetId) {
      await exec(
        app.from("import_row_matches").insert({ import_row_result_id: rowId, target_id: targetId }),
        "import_row_matches",
      );
    },
    async validRows(jobId) {
      const { data, error } = await app
        .from("import_row_results")
        .select(
          "id, row_number, import_row_matches (target_id, deleted_at), merge_reviews (candidate_table, candidate_id, decision, deleted_at)",
        )
        .eq("import_job_id", jobId)
        .eq("row_state", "Valid")
        .is("deleted_at", null)
        .order("row_number");
      if (error) throw new Error(`import_row_results: ${error.message}`);
      return ((data as Row[] | null) ?? []).map((r) => {
        const match = ((r["import_row_matches"] as Row[] | null) ?? []).find(
          (m) => m["deleted_at"] === null,
        );
        const merged = ((r["merge_reviews"] as Row[] | null) ?? []).find(
          (m) => m["decision"] === "Merged" && m["deleted_at"] === null,
        );
        return {
          id: text(r, "id"),
          rowNumber: Number(r["row_number"]),
          matchedId: match ? text(match, "target_id") : null,
          mergeInto: merged
            ? { table: text(merged, "candidate_table"), id: text(merged, "candidate_id") }
            : null,
        };
      });
    },
    async commitWrite(input) {
      await call("commit_import_write", {
        p_import_row_result_id: input.rowId,
        p_import_batch_id: input.batchId,
        p_target_id: input.targetId,
        p_write_action: input.action,
        p_before_image: input.before,
      });
    },
    async refuseRow(rowId, reason) {
      await exec(
        app.from("import_row_results").update({ row_state: "Refused", reason }).eq("id", rowId),
        "import_row_results",
      );
    },
    async finishBatch(batchId) {
      await call("finish_import_batch", { p_import_batch_id: batchId });
    },
    async orgSlug(orgId) {
      const row = await one(
        app.from("organizations").select("slug").eq("id", orgId),
        "organizations",
      );
      return typeof row?.["slug"] === "string" ? row["slug"] : null;
    },
    async notifyFinished(input) {
      await call("notify_import_finished", {
        p_import_job_id: input.jobId,
        p_import_batch_id: input.batchId,
        p_review_url: input.url,
      });
    },
  };
}
