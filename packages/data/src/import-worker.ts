import type { SupabaseClient } from "@supabase/supabase-js";
import {
  dataRows,
  headers,
  parseCsv,
  suggestMapping,
  type DataRow,
  type Sheet,
} from "./import-parse.ts";

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
 * A failed attempt goes back to the queue while attempts remain, then the import is marked Failed.
 * Not exported from the package index: only the worker entry points load it, with its .xlsx reader.
 */

export const IMPORT_JOB_KINDS = ["import.detect", "import.validate", "import.commit"] as const;
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
  download(path: string): Promise<Uint8Array>;
  targetFields(
    targetCode: string,
  ): Promise<{ name: string; required: boolean; strongKey: boolean }[]>;
  profileMapping(profileId: string): Promise<Map<string, string>>;
  setStatus(jobId: string, status: string): Promise<void>;
  insertColumns(
    jobId: string,
    sheet: string,
    columns: { header: string; suggested: string | null }[],
  ): Promise<void>;
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
}

// Reading the spreadsheet ---------------------------------------------------------------------------------

/** The first sheet of an upload: CSV as text, .xlsx through exceljs (loaded only here). */
export async function readSheet(
  source: string,
  filename: string,
  bytes: Uint8Array,
): Promise<Sheet> {
  if (source === "CSV") {
    return { name: filename, rows: parseCsv(new TextDecoder().decode(bytes)) };
  }
  if (source === "XLSX") {
    const { default: ExcelJS } = await import("exceljs");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    );
    const sheet = workbook.worksheets[0];
    if (!sheet) return { name: filename, rows: [] };
    const rows: string[][] = [];
    sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        cells[col - 1] = cell.text ?? "";
      });
      rows[rowNumber - 1] = Array.from(cells, (c) => c ?? "");
    });
    return { name: sheet.name, rows: Array.from(rows, (r) => r ?? []) };
  }
  throw new UnreadableUploadError(source);
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

async function detect(store: ImportStore, jobId: string): Promise<void> {
  const job = await store.job(jobId);
  if (!job || job.status !== "Uploaded") return;
  const sheet = await readSheet(job.source, job.filename, await store.download(job.path));
  const fields = (await store.targetFields(job.targetCode)).map((f) => f.name);
  const profile = job.profileId
    ? await store.profileMapping(job.profileId)
    : new Map<string, string>();
  const heads = headers(sheet);
  const suggested = suggestMapping(heads, fields, profile);
  await store.setStatus(job.id, "Detected");
  await store.insertColumns(
    job.id,
    sheet.name,
    heads.map((header, i) => ({ header: header.slice(0, 200), suggested: suggested[i] ?? null })),
  );
  await store.setStatus(job.id, "Mapped");
}

async function validate(store: ImportStore, jobId: string): Promise<void> {
  const job = await store.job(jobId);
  if (!job || job.status !== "Mapped") return;
  const sheet = await readSheet(job.source, job.filename, await store.download(job.path));
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
}

async function commit(store: ImportStore, batchId: string): Promise<void> {
  const jobId = await store.batchJob(batchId);
  const job = jobId ? await store.job(jobId) : null;
  if (!job || job.status !== "Committing") return;
  const sheet = await readSheet(job.source, job.filename, await store.download(job.path));
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
}

/** A row the database refused to write; the row is marked Refused with the reason and the batch goes on. */
export class ImportWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportWriteError";
  }
}

const STEPS: Record<ImportJobKind, (store: ImportStore, subjectId: string) => Promise<void>> = {
  "import.detect": detect,
  "import.validate": validate,
  "import.commit": commit,
};

/** One pass of the worker over every import job kind. */
export async function runImportJobs(
  store: ImportStore,
  worker: string,
  limit = 10,
): Promise<ImportJobResult[]> {
  const results: ImportJobResult[] = [];
  for (const kind of IMPORT_JOB_KINDS) {
    for (const claimed of await store.claim(kind, worker, limit)) {
      try {
        await STEPS[kind](store, claimed.subjectId);
        await store.finishJob(claimed.jobId, true, null);
        results.push({
          kind,
          jobId: claimed.jobId,
          subjectId: claimed.subjectId,
          status: "Succeeded",
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = await store.finishJob(claimed.jobId, false, message);
        if (status === "Failed") {
          const jobId =
            kind === "import.commit" ? await store.batchJob(claimed.subjectId) : claimed.subjectId;
          if (jobId) await store.setStatus(jobId, "Failed");
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
): Promise<ImportJobResult[]> {
  const all: ImportJobResult[] = [];
  for (let i = 0; i < passes; i += 1) {
    const results = await runImportJobs(store, worker);
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
            "id, org_id, target_code, source, storage_object_path, original_filename, import_status, import_mapping_profile_id",
          )
          .eq("id", id)
          .is("deleted_at", null),
        "import_jobs",
      );
      return row
        ? {
            id: text(row, "id"),
            orgId: text(row, "org_id"),
            targetCode: text(row, "target_code"),
            source: text(row, "source"),
            path: text(row, "storage_object_path"),
            filename: text(row, "original_filename"),
            status: text(row, "import_status"),
            profileId:
              typeof row["import_mapping_profile_id"] === "string"
                ? row["import_mapping_profile_id"]
                : null,
          }
        : null;
    },
    async batchJob(batchId) {
      const row = await one(
        app.from("import_batches").select("import_job_id").eq("id", batchId),
        "import_batches",
      );
      return row ? text(row, "import_job_id") : null;
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
        app
          .from("import_job_columns")
          .insert(
            columns.map((c, i) => ({
              import_job_id: jobId,
              sheet_name: sheet,
              column_index: i,
              header: c.header,
              suggested_field_name: c.suggested,
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
        app
          .from("import_cell_issues")
          .insert(
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
  };
}
