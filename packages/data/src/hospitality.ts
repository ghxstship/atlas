import type { Database, XosClient } from "./client";
import type { OperationsScope } from "./logistics";
import { fail, ok, toDataError, type Result } from "./result";

/**
 * Hospitality repository (Section 4.2, RRR-23): lodging, catering, travel and amenity
 * fulfillments with their lines, and banquet event orders (BEOs) with theirs, from migration 0351.
 * Reads need hospitality.fulfillment.read; fulfillments need hospitality.fulfillment.write and
 * BEOs hospitality.beo.write. Approving a BEO needs hospitality.beo.approve, is never done by its
 * author (sod_approval_requester) and is stamped once by the database. A NULL unit price is
 * unpriced, never zero (Section 3.7).
 */

type Tables = Database["app"]["Tables"];
type Derived<T> = Omit<T, "org_id">;

export type FulfillmentKind = Database["app"]["Enums"]["fulfillment_kind"];
export const FULFILLMENT_KINDS: readonly FulfillmentKind[] = [
  "Lodging",
  "Catering",
  "Travel",
  "Amenity",
];

/**
 * Where a fulfillment stands, derived from its lines and BEOs, never stored (Section 3.15):
 * Requested with no lines, Assigned once lines exist, Confirmed once an approved BEO covers it.
 */
export const FULFILLMENT_PROGRESS = ["requested", "assigned", "confirmed"] as const;
export type FulfillmentProgress = (typeof FULFILLMENT_PROGRESS)[number];

// Money -------------------------------------------------------------------------------------------

/** A priced or unpriced line: quantity times unit price in minor units. */
export interface PricedLine {
  readonly quantity: number;
  readonly unitPriceMinor: number | null;
  readonly currencyCode: string | null;
}

/**
 * A NULL-aware total (ADR 0002): the sum of priced lines in one currency, NULL when no line is
 * priced or the lines mix currencies, with the count of unpriced lines beside it.
 */
export interface MoneyTotal {
  readonly amountMinor: number | null;
  readonly currencyCode: string | null;
  readonly unpricedCount: number;
  readonly mixedCurrencies: boolean;
}

/** A line's extended amount in minor units, or null when it is unpriced. */
export function lineAmount(line: PricedLine): number | null {
  return line.unitPriceMinor === null ? null : Math.round(line.quantity * line.unitPriceMinor);
}

export function totalOf(lines: readonly PricedLine[]): MoneyTotal {
  const priced = lines.filter((l) => l.unitPriceMinor !== null);
  const currencies = new Set(priced.map((l) => l.currencyCode));
  const unpricedCount = lines.length - priced.length;
  if (priced.length === 0 || currencies.size > 1) {
    return {
      amountMinor: null,
      currencyCode: currencies.size === 1 ? [...currencies][0]! : null,
      unpricedCount,
      mixedCurrencies: currencies.size > 1,
    };
  }
  return {
    amountMinor: priced.reduce((sum, l) => sum + (lineAmount(l) ?? 0), 0),
    currencyCode: priced[0]!.currencyCode,
    unpricedCount,
    mixedCurrencies: false,
  };
}

/** Rows a write affected: none means the row is missing or the viewer may not write it. */
function one<T>(data: T[] | null): Result<T> {
  const row = data?.[0];
  return row === undefined ? fail({ kind: "not-found" }) : ok(row);
}

async function softDelete(
  db: XosClient,
  table: "fulfillments" | "fulfillment_lines" | "beos" | "beo_lines",
  id: string,
  deleted: boolean,
): Promise<Result<null>> {
  const { data, error } = await db
    .from(table)
    .update({ deleted_at: deleted ? new Date().toISOString() : null })
    .eq("id", id)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 1 ? ok(null) : fail({ kind: "not-found" });
}

// Fulfillments ------------------------------------------------------------------------------------

export interface Fulfillment {
  readonly id: string;
  readonly projectId: string;
  readonly projectKey: string;
  readonly projectName: string;
  readonly timeZone: string;
  readonly kind: FulfillmentKind;
  readonly title: string;
  readonly supplierId: string | null;
  readonly supplierName: string | null;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly progress: FulfillmentProgress;
  readonly guestCount: number;
  readonly lineCount: number;
  readonly total: MoneyTotal;
}

export interface FulfillmentLine extends PricedLine {
  readonly id: string;
  readonly description: string;
  readonly personId: string | null;
  readonly personName: string | null;
  readonly amountMinor: number | null;
}

export interface FulfillmentDetail extends Fulfillment {
  readonly lines: readonly FulfillmentLine[];
  readonly beos: readonly Beo[];
}

interface LineRow {
  id: string;
  description: string;
  person_id: string | null;
  quantity: number | string;
  unit_price_minor: number | null;
  currency_code: string | null;
  deleted_at: string | null;
  person?: { full_name: string | null } | null;
}

interface FulfillmentRow {
  id: string;
  project_id: string;
  fulfillment_kind: FulfillmentKind;
  title: string;
  counterparty_id: string | null;
  starts_at: string | null;
  ends_at: string | null;
  created_at: string;
  updated_at: string;
  project: { project_key: string; name: string; time_zone: string } | null;
  supplier: { counterparty_name: string | null } | null;
  fulfillment_lines: LineRow[];
  beos: { approved_at: string | null; deleted_at: string | null }[];
}

const FULFILLMENT_COLUMNS =
  "id, project_id, fulfillment_kind, title, counterparty_id, starts_at, ends_at, created_at, updated_at, " +
  "project:projects!fulfillments_project_id_fkey(project_key, name, time_zone), " +
  "supplier:counterparties!fulfillments_counterparty_id_fkey(counterparty_name), " +
  "fulfillment_lines(id, description, person_id, quantity, unit_price_minor, currency_code, deleted_at, person:people!fulfillment_lines_person_id_fkey(full_name)), " +
  "beos(approved_at, deleted_at)";

function toLine(row: LineRow): FulfillmentLine {
  const priced: PricedLine = {
    quantity: Number(row.quantity),
    unitPriceMinor: row.unit_price_minor,
    currencyCode: row.currency_code,
  };
  return {
    id: row.id,
    description: row.description,
    personId: row.person_id,
    personName: row.person?.full_name ?? null,
    ...priced,
    amountMinor: lineAmount(priced),
  };
}

export function fulfillmentProgress(
  lineCount: number,
  beos: readonly { approved_at: string | null; deleted_at: string | null }[],
): FulfillmentProgress {
  if (beos.some((b) => b.deleted_at === null && b.approved_at !== null)) return "confirmed";
  return lineCount > 0 ? "assigned" : "requested";
}

function toFulfillment(row: FulfillmentRow): Fulfillment {
  const lines = row.fulfillment_lines.filter((l) => l.deleted_at === null).map(toLine);
  return {
    id: row.id,
    projectId: row.project_id,
    projectKey: row.project?.project_key ?? "",
    projectName: row.project?.name ?? "",
    timeZone: row.project?.time_zone ?? "UTC",
    kind: row.fulfillment_kind,
    title: row.title,
    supplierId: row.counterparty_id,
    supplierName: row.supplier?.counterparty_name ?? null,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    progress: fulfillmentProgress(lines.length, row.beos),
    guestCount: new Set(lines.flatMap((l) => (l.personId ? [l.personId] : []))).size,
    lineCount: lines.length,
    total: totalOf(lines),
  };
}

export interface FulfillmentScope extends OperationsScope {
  readonly kind?: FulfillmentKind | undefined;
}

/** Live fulfillments, soonest start first; undated ones follow, newest first. */
export async function listFulfillments(
  db: XosClient,
  scope: FulfillmentScope,
): Promise<Result<Fulfillment[]>> {
  let query = db
    .from("fulfillments")
    .select(FULFILLMENT_COLUMNS)
    .eq("org_id", scope.orgId)
    .is("deleted_at", null);
  if (scope.projectId) query = query.eq("project_id", scope.projectId);
  if (scope.kind) query = query.eq("fulfillment_kind", scope.kind);
  const { data, error } = await query
    .order("starts_at", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false });
  if (error) return fail(toDataError(error));
  return ok((data as unknown as FulfillmentRow[]).map(toFulfillment));
}

/** One fulfillment with its lines and BEOs, or not-found. */
export async function getFulfillment(
  db: XosClient,
  id: string,
): Promise<Result<FulfillmentDetail>> {
  const { data, error } = await db
    .from("fulfillments")
    .select(FULFILLMENT_COLUMNS)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  const row = data as unknown as FulfillmentRow;
  const beos = await listBeos(db, { orgId: "", fulfillmentId: id });
  if (!beos.ok) return beos;
  return ok({
    ...toFulfillment(row),
    lines: row.fulfillment_lines.filter((l) => l.deleted_at === null).map(toLine),
    beos: beos.data,
  });
}

export interface FulfillmentInput {
  readonly kind: FulfillmentKind;
  readonly title: string;
  readonly supplierId: string | null;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
}

function fulfillmentColumns(input: FulfillmentInput) {
  return {
    fulfillment_kind: input.kind,
    title: input.title,
    counterparty_id: input.supplierId,
    starts_at: input.startsAt,
    ends_at: input.endsAt,
  };
}

export async function createFulfillment(
  db: XosClient,
  projectId: string,
  input: FulfillmentInput,
): Promise<Result<{ id: string }>> {
  const row: Derived<Tables["fulfillments"]["Insert"]> = {
    project_id: projectId,
    ...fulfillmentColumns(input),
  };
  const { data, error } = await db
    .from("fulfillments")
    .insert(row as Tables["fulfillments"]["Insert"])
    .select("id");
  if (error) return fail(toDataError(error));
  return one(data);
}

/** Edits a fulfillment, refusing with a conflict when it changed since `expectedUpdatedAt`. */
export async function updateFulfillment(
  db: XosClient,
  id: string,
  input: FulfillmentInput,
  expectedUpdatedAt?: string,
): Promise<Result<null>> {
  let query = db.from("fulfillments").update(fulfillmentColumns(input)).eq("id", id);
  if (expectedUpdatedAt) query = query.eq("updated_at", expectedUpdatedAt);
  const { data, error } = await query.select("id");
  if (error) return fail(toDataError(error));
  if (data.length === 1) return ok(null);
  return expectedUpdatedAt
    ? fail({ kind: "conflict", message: "fulfillment_changed" })
    : fail({ kind: "not-found" });
}

export function deleteFulfillment(db: XosClient, id: string): Promise<Result<null>> {
  return softDelete(db, "fulfillments", id, true);
}

export function restoreFulfillment(db: XosClient, id: string): Promise<Result<null>> {
  return softDelete(db, "fulfillments", id, false);
}

export interface FulfillmentLineInput {
  readonly description: string;
  readonly personId: string | null;
  readonly quantity: number;
  readonly unitPriceMinor: number | null;
  readonly currencyCode: string | null;
}

/** Adds a line, such as a room night for one guest. A price needs its currency (database check). */
export async function addFulfillmentLine(
  db: XosClient,
  fulfillmentId: string,
  input: FulfillmentLineInput,
): Promise<Result<{ id: string }>> {
  const row: Derived<Tables["fulfillment_lines"]["Insert"]> = {
    fulfillment_id: fulfillmentId,
    description: input.description,
    person_id: input.personId,
    quantity: input.quantity,
    unit_price_minor: input.unitPriceMinor,
    currency_code: input.currencyCode,
  };
  const { data, error } = await db
    .from("fulfillment_lines")
    .insert(row as Tables["fulfillment_lines"]["Insert"])
    .select("id");
  if (error) return fail(toDataError(error));
  return one(data);
}

export function removeFulfillmentLine(db: XosClient, id: string): Promise<Result<null>> {
  return softDelete(db, "fulfillment_lines", id, true);
}

// BEOs ---------------------------------------------------------------------------------------------

export interface BeoLine extends PricedLine {
  readonly id: string;
  readonly description: string;
  readonly amountMinor: number | null;
}

export interface Beo {
  readonly id: string;
  readonly projectId: string;
  readonly projectKey: string;
  readonly timeZone: string;
  readonly fulfillmentId: string | null;
  readonly fulfillmentTitle: string | null;
  readonly eventAt: string;
  readonly guestCount: number | null;
  readonly approvedAt: string | null;
  readonly approvedByName: string | null;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly lineCount: number;
  readonly total: MoneyTotal;
}

export interface BeoDetail extends Beo {
  readonly lines: readonly BeoLine[];
}

interface BeoLineRow {
  id: string;
  description: string;
  quantity: number | string;
  unit_price_minor: number | null;
  currency_code: string | null;
  deleted_at: string | null;
}

interface BeoRow {
  id: string;
  project_id: string;
  fulfillment_id: string | null;
  event_at: string;
  guest_count: number | null;
  approved_at: string | null;
  created_by: string | null;
  created_at: string;
  project: { project_key: string; time_zone: string } | null;
  fulfillment: { title: string } | null;
  approver: { full_name: string | null } | null;
  beo_lines: BeoLineRow[];
}

const BEO_COLUMNS =
  "id, project_id, fulfillment_id, event_at, guest_count, approved_at, created_by, created_at, " +
  "project:projects!beos_project_id_fkey(project_key, time_zone), fulfillment:fulfillments!beos_fulfillment_id_fkey(title), " +
  "approver:people!beos_approved_by_fkey(full_name), " +
  "beo_lines(id, description, quantity, unit_price_minor, currency_code, deleted_at)";

function toBeoLine(row: BeoLineRow): BeoLine {
  const priced: PricedLine = {
    quantity: Number(row.quantity),
    unitPriceMinor: row.unit_price_minor,
    currencyCode: row.currency_code,
  };
  return { id: row.id, description: row.description, ...priced, amountMinor: lineAmount(priced) };
}

function liveBeoLines(row: BeoRow): BeoLine[] {
  return row.beo_lines.filter((l) => l.deleted_at === null).map(toBeoLine);
}

function toBeo(row: BeoRow): Beo {
  const lines = liveBeoLines(row);
  return {
    id: row.id,
    projectId: row.project_id,
    projectKey: row.project?.project_key ?? "",
    timeZone: row.project?.time_zone ?? "UTC",
    fulfillmentId: row.fulfillment_id,
    fulfillmentTitle: row.fulfillment?.title ?? null,
    eventAt: row.event_at,
    guestCount: row.guest_count,
    approvedAt: row.approved_at,
    approvedByName: row.approver?.full_name ?? null,
    createdBy: row.created_by,
    createdAt: row.created_at,
    lineCount: lines.length,
    total: totalOf(lines),
  };
}

export interface BeoScope extends OperationsScope {
  readonly fulfillmentId?: string;
}

/** Live BEOs in service order. An empty orgId means the scope is a fulfillment. */
export async function listBeos(db: XosClient, scope: BeoScope): Promise<Result<Beo[]>> {
  let query = db.from("beos").select(BEO_COLUMNS).is("deleted_at", null);
  if (scope.orgId) query = query.eq("org_id", scope.orgId);
  if (scope.projectId) query = query.eq("project_id", scope.projectId);
  if (scope.fulfillmentId) query = query.eq("fulfillment_id", scope.fulfillmentId);
  const { data, error } = await query.order("event_at");
  if (error) return fail(toDataError(error));
  return ok((data as unknown as BeoRow[]).map(toBeo));
}

export async function getBeo(db: XosClient, id: string): Promise<Result<BeoDetail>> {
  const { data, error } = await db
    .from("beos")
    .select(BEO_COLUMNS)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  const row = data as unknown as BeoRow;
  return ok({ ...toBeo(row), lines: liveBeoLines(row) });
}

export interface BeoInput {
  readonly fulfillmentId: string | null;
  readonly eventAt: string;
  readonly guestCount: number | null;
}

/** Generates a BEO, usually from a catering fulfillment of the same project. */
export async function createBeo(
  db: XosClient,
  projectId: string,
  input: BeoInput,
): Promise<Result<{ id: string }>> {
  const row: Derived<Tables["beos"]["Insert"]> = {
    project_id: projectId,
    fulfillment_id: input.fulfillmentId,
    event_at: input.eventAt,
    guest_count: input.guestCount,
  };
  const { data, error } = await db
    .from("beos")
    .insert(row as Tables["beos"]["Insert"])
    .select("id");
  if (error) return fail(toDataError(error));
  return one(data);
}

export async function updateBeo(db: XosClient, id: string, input: BeoInput): Promise<Result<null>> {
  const { data, error } = await db
    .from("beos")
    .update({
      fulfillment_id: input.fulfillmentId,
      event_at: input.eventAt,
      guest_count: input.guestCount,
    })
    .eq("id", id)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 1 ? ok(null) : fail({ kind: "not-found" });
}

/**
 * Approves (confirms) a BEO. The database needs hospitality.beo.approve, refuses the author with
 * sod_approval_requester and stamps the approval once with its own time and the session person.
 */
export async function approveBeo(db: XosClient, id: string): Promise<Result<null>> {
  const { data, error } = await db
    .from("beos")
    .update({ approved_at: new Date().toISOString() })
    .eq("id", id)
    .is("approved_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 1 ? ok(null) : fail({ kind: "not-found" });
}

export function deleteBeo(db: XosClient, id: string): Promise<Result<null>> {
  return softDelete(db, "beos", id, true);
}

export function restoreBeo(db: XosClient, id: string): Promise<Result<null>> {
  return softDelete(db, "beos", id, false);
}

export interface BeoLineInput {
  readonly description: string;
  readonly quantity: number;
  readonly unitPriceMinor: number | null;
  readonly currencyCode: string | null;
}

export async function addBeoLine(
  db: XosClient,
  beoId: string,
  input: BeoLineInput,
): Promise<Result<{ id: string }>> {
  const row: Derived<Tables["beo_lines"]["Insert"]> = {
    beo_id: beoId,
    description: input.description,
    quantity: input.quantity,
    unit_price_minor: input.unitPriceMinor,
    currency_code: input.currencyCode,
  };
  const { data, error } = await db
    .from("beo_lines")
    .insert(row as Tables["beo_lines"]["Insert"])
    .select("id");
  if (error) return fail(toDataError(error));
  return one(data);
}

export function removeBeoLine(db: XosClient, id: string): Promise<Result<null>> {
  return softDelete(db, "beo_lines", id, true);
}

/** Currencies a price may use, in code order (private.currencies through app.currencies). */
export async function listCurrencyCodes(db: XosClient): Promise<Result<string[]>> {
  const { data, error } = await db.from("currencies").select("currency_code").order("currency_code");
  if (error) return fail(toDataError(error));
  return ok(data.map((c) => c.currency_code as string));
}
