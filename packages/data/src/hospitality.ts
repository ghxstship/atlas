import type { Database, XosClient } from "./client.ts";
import { displayKey, type OperationsScope } from "./logistics.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

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

/** The fulfillment lifecycle of migration 0440, in lifecycle order. */
export type FulfillmentState = Database["app"]["Enums"]["fulfillment_state"];
export const FULFILLMENT_STATES: readonly FulfillmentState[] = [
  "Proposed",
  "Active",
  "Blocked",
  "Complete",
  "Canceled",
];

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
      currencyCode: null,
      unpricedCount,
      mixedCurrencies: currencies.size > 1,
    };
  }
  return {
    amountMinor: priced.reduce((sum, l) => sum + (lineAmount(l) ?? 0), 0),
    currencyCode: priced[0]?.currencyCode ?? null,
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
  /** Display key {projectKey}-{number} (Section 4.5.1). */
  readonly key: string;
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
  readonly state: FulfillmentState;
  /** Approved BEOs covering the fulfillment. */
  readonly approvedBeoCount: number;
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
  fulfillment_number: number;
  fulfillment_state: FulfillmentState;
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
  "id, fulfillment_number, fulfillment_state, project_id, fulfillment_kind, title, counterparty_id, starts_at, ends_at, created_at, updated_at, " +
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

function toFulfillment(row: FulfillmentRow): Fulfillment {
  const lines = row.fulfillment_lines.filter((l) => l.deleted_at === null).map(toLine);
  return {
    id: row.id,
    key: displayKey(row.project?.project_key, row.fulfillment_number),
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
    state: row.fulfillment_state,
    approvedBeoCount: row.beos.filter((b) => b.deleted_at === null && b.approved_at !== null)
      .length,
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

/** One entry of a fulfillment's state ledger. */
export interface FulfillmentTransition {
  readonly id: string;
  readonly fromState: FulfillmentState | null;
  readonly toState: FulfillmentState;
  readonly reason: string;
  readonly at: string;
  readonly byName: string | null;
}

/**
 * Moves a fulfillment to another state with a reason. The database checks the move against the
 * lifecycle rules, compare-and-sets on `expected` (a stale page gets fulfillment_state_conflict) and
 * writes the ledger; it needs hospitality.fulfillment.write on the project.
 */
export async function transitionFulfillment(
  db: XosClient,
  id: string,
  expected: FulfillmentState,
  next: FulfillmentState,
  reason: string,
): Promise<Result<null>> {
  const { error } = await db.rpc("transition_fulfillment", {
    p_fulfillment_id: id,
    p_expected: expected,
    p_next: next,
    p_reason: reason,
  });
  return error ? fail(toDataError(error)) : ok(null);
}

/** The moves the lifecycle allows from a state, read from the database rules. */
export async function listFulfillmentMoves(
  db: XosClient,
  from: FulfillmentState,
): Promise<Result<FulfillmentState[]>> {
  const { data, error } = await db
    .from("lifecycle_transition_rules")
    .select("to_state")
    .eq("lifecycle", "fulfillment")
    .eq("from_state", from);
  if (error) return fail(toDataError(error));
  const allowed = new Set(data.map((r) => r.to_state));
  return ok(FULFILLMENT_STATES.filter((s) => allowed.has(s)));
}

/** The state ledger of a fulfillment, newest first. */
export async function listFulfillmentTransitions(
  db: XosClient,
  id: string,
): Promise<Result<FulfillmentTransition[]>> {
  const { data, error } = await db
    .from("fulfillment_state_transitions")
    .select(
      "id, from_state, to_state, reason, created_at, author:people!fulfillment_state_transitions_created_by_fkey(full_name)",
    )
    .eq("fulfillment_id", id)
    .order("created_at", { ascending: false });
  if (error) return fail(toDataError(error));
  return ok(
    data.map((r) => ({
      id: r.id,
      fromState: r.from_state,
      toState: r.to_state,
      reason: r.reason,
      at: r.created_at,
      byName: r.author?.full_name ?? null,
    })),
  );
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
  /** Display key {projectKey}-{number} (Section 4.5.1). */
  readonly key: string;
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
  beo_number: number;
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
  "id, beo_number, project_id, fulfillment_id, event_at, guest_count, approved_at, created_by, created_at, " +
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
    key: displayKey(row.project?.project_key, row.beo_number),
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

/** An ISO 4217 currency and its minor unit exponent, from the one currency reference (ADR 0002). */
export interface CurrencyInfo {
  readonly code: string;
  readonly exponent: number;
}

/** Currencies a price may use, in code order (private.currencies through app.currencies). */
export async function listCurrencies(db: XosClient): Promise<Result<CurrencyInfo[]>> {
  const { data, error } = await db
    .from("currencies")
    .select("currency_code, minor_unit_exponent")
    .order("currency_code");
  if (error) return fail(toDataError(error));
  return ok(
    data.map((c) => ({ code: c.currency_code as string, exponent: c.minor_unit_exponent ?? 2 })),
  );
}

/** Minor units as a major amount for display: 18900 USD is 189, 500 JPY is 500. */
export function toMajor(minor: number, exponent: number): number {
  return minor / 10 ** exponent;
}

/**
 * A typed major amount ("189.00") as integer minor units in a currency's exponent: null when blank
 * (unpriced, never zero), undefined when it is not an amount with at most `exponent` decimals.
 */
export function parseMinor(raw: string, exponent: number): number | null | undefined {
  const text = raw.trim().replace(/,/g, "");
  if (text === "") return null;
  const pattern = exponent === 0 ? /^\d+$/ : new RegExp(`^\\d+(\\.\\d{1,${exponent}})?$`);
  if (!pattern.test(text)) return undefined;
  const [whole = "0", fraction = ""] = text.split(".");
  return Number(whole) * 10 ** exponent + Number(fraction.padEnd(exponent, "0") || "0");
}

/** A minor amount as the major text an edit field shows, or blank when unpriced. */
export function formatMajorInput(minor: number | null, exponent: number): string {
  return minor === null ? "" : toMajor(minor, exponent).toFixed(exponent);
}

// Accommodation blocks ------------------------------------------------------------------------------

export interface AccommodationAssignment {
  readonly id: string;
  readonly personId: string;
  readonly personName: string | null;
  readonly checkInOn: string;
  readonly checkOutOn: string;
}

/** Occupancy of a block, derived from its live assignments (Section 3.15). */
export interface BlockOccupancy {
  readonly nights: number;
  readonly roomNightsHeld: number;
  readonly roomNightsAssigned: number;
  /** Most rooms assigned on any one night. */
  readonly peakAssigned: number;
  /** Rooms assigned on each night, in date order. */
  readonly byNight: readonly { readonly night: string; readonly assigned: number }[];
}

export interface AccommodationBlock {
  readonly id: string;
  readonly key: string;
  readonly projectId: string;
  readonly projectKey: string;
  readonly projectName: string;
  readonly title: string;
  readonly hotelId: string | null;
  readonly hotelName: string | null;
  readonly checkInOn: string;
  readonly checkOutOn: string;
  readonly roomsHeld: number;
  readonly releaseOn: string | null;
  readonly nightlyRateMinor: number | null;
  readonly currencyCode: string | null;
  readonly updatedAt: string;
  readonly occupancy: BlockOccupancy;
  /** Nightly rate times room nights held; NULL when the rate is unpriced. */
  readonly contractTotal: MoneyTotal;
}

export interface AccommodationBlockDetail extends AccommodationBlock {
  readonly assignments: readonly AccommodationAssignment[];
}

const DAY_MS = 86_400_000;

function dayNumber(isoDate: string): number {
  return Math.round(Date.parse(`${isoDate}T00:00:00Z`) / DAY_MS);
}

function isoDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** Nightly occupancy of a block from check-in to the night before check-out. */
export function blockOccupancy(
  checkInOn: string,
  checkOutOn: string,
  roomsHeld: number,
  stays: readonly { readonly checkInOn: string; readonly checkOutOn: string }[],
): BlockOccupancy {
  const first = dayNumber(checkInOn);
  const nights = Math.max(0, dayNumber(checkOutOn) - first);
  const byNight = Array.from({ length: nights }, (_, i) => {
    const day = first + i;
    const assigned = stays.filter(
      (s) => dayNumber(s.checkInOn) <= day && day < dayNumber(s.checkOutOn),
    ).length;
    return { night: isoDay(day), assigned };
  });
  return {
    nights,
    roomNightsHeld: nights * roomsHeld,
    roomNightsAssigned: byNight.reduce((sum, n) => sum + n.assigned, 0),
    peakAssigned: byNight.reduce((max, n) => Math.max(max, n.assigned), 0),
    byNight,
  };
}

interface AssignmentRow {
  id: string;
  person_id: string;
  check_in_on: string;
  check_out_on: string;
  deleted_at: string | null;
  person: { full_name: string | null } | null;
}

interface BlockRow {
  id: string;
  block_number: number;
  project_id: string;
  title: string;
  counterparty_id: string | null;
  check_in_on: string;
  check_out_on: string;
  rooms_held: number;
  release_on: string | null;
  nightly_rate_minor: number | null;
  currency_code: string | null;
  updated_at: string;
  project: { project_key: string; name: string } | null;
  hotel: { counterparty_name: string | null } | null;
  accommodation_assignments: AssignmentRow[];
}

const BLOCK_COLUMNS =
  "id, block_number, project_id, title, counterparty_id, check_in_on, check_out_on, rooms_held, release_on, nightly_rate_minor, currency_code, updated_at, " +
  "project:projects!accommodation_blocks_project_id_fkey(project_key, name), " +
  "hotel:counterparties!accommodation_blocks_counterparty_id_fkey(counterparty_name), " +
  "accommodation_assignments(id, person_id, check_in_on, check_out_on, deleted_at, person:people!accommodation_assignments_person_id_fkey(full_name))";

function liveAssignments(row: BlockRow): AccommodationAssignment[] {
  return row.accommodation_assignments
    .filter((a) => a.deleted_at === null)
    .map((a) => ({
      id: a.id,
      personId: a.person_id,
      personName: a.person?.full_name ?? null,
      checkInOn: a.check_in_on,
      checkOutOn: a.check_out_on,
    }))
    .sort(
      (a, b) =>
        a.checkInOn.localeCompare(b.checkInOn) ||
        (a.personName ?? "").localeCompare(b.personName ?? ""),
    );
}

function toBlock(row: BlockRow): AccommodationBlock {
  const occupancy = blockOccupancy(
    row.check_in_on,
    row.check_out_on,
    row.rooms_held,
    liveAssignments(row),
  );
  return {
    id: row.id,
    key: displayKey(row.project?.project_key, row.block_number),
    projectId: row.project_id,
    projectKey: row.project?.project_key ?? "",
    projectName: row.project?.name ?? "",
    title: row.title,
    hotelId: row.counterparty_id,
    hotelName: row.hotel?.counterparty_name ?? null,
    checkInOn: row.check_in_on,
    checkOutOn: row.check_out_on,
    roomsHeld: row.rooms_held,
    releaseOn: row.release_on,
    nightlyRateMinor: row.nightly_rate_minor,
    currencyCode: row.currency_code,
    updatedAt: row.updated_at,
    occupancy,
    contractTotal: totalOf([
      {
        quantity: occupancy.roomNightsHeld,
        unitPriceMinor: row.nightly_rate_minor,
        currencyCode: row.currency_code,
      },
    ]),
  };
}

/** Live accommodation blocks, earliest check-in first. */
export async function listAccommodationBlocks(
  db: XosClient,
  scope: OperationsScope,
): Promise<Result<AccommodationBlock[]>> {
  let query = db
    .from("accommodation_blocks")
    .select(BLOCK_COLUMNS)
    .eq("org_id", scope.orgId)
    .is("deleted_at", null);
  if (scope.projectId) query = query.eq("project_id", scope.projectId);
  const { data, error } = await query.order("check_in_on").order("title");
  if (error) return fail(toDataError(error));
  return ok((data as unknown as BlockRow[]).map(toBlock));
}

export async function getAccommodationBlock(
  db: XosClient,
  id: string,
): Promise<Result<AccommodationBlockDetail>> {
  const { data, error } = await db
    .from("accommodation_blocks")
    .select(BLOCK_COLUMNS)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  const row = data as unknown as BlockRow;
  return ok({ ...toBlock(row), assignments: liveAssignments(row) });
}

export interface AccommodationBlockInput {
  readonly title: string;
  readonly hotelId: string | null;
  readonly checkInOn: string;
  readonly checkOutOn: string;
  readonly roomsHeld: number;
  readonly releaseOn: string | null;
  readonly nightlyRateMinor: number | null;
  readonly currencyCode: string | null;
}

function blockColumns(input: AccommodationBlockInput) {
  return {
    title: input.title,
    counterparty_id: input.hotelId,
    check_in_on: input.checkInOn,
    check_out_on: input.checkOutOn,
    rooms_held: input.roomsHeld,
    release_on: input.releaseOn,
    nightly_rate_minor: input.nightlyRateMinor,
    currency_code: input.currencyCode,
  };
}

/** Contracts a block. Needs hospitality.accommodation.write on the project. */
export async function createAccommodationBlock(
  db: XosClient,
  projectId: string,
  input: AccommodationBlockInput,
): Promise<Result<{ id: string }>> {
  const row: Derived<Tables["accommodation_blocks"]["Insert"]> = {
    project_id: projectId,
    ...blockColumns(input),
  };
  const { data, error } = await db
    .from("accommodation_blocks")
    .insert(row as Tables["accommodation_blocks"]["Insert"])
    .select("id");
  if (error) return fail(toDataError(error));
  return one(data);
}

/**
 * Edits a block. The database refuses a window that drops an assigned stay
 * (accommodation_block_excludes_stays) or fewer rooms than are assigned on some night
 * (accommodation_block_full); a stale `expectedUpdatedAt` is a conflict.
 */
export async function updateAccommodationBlock(
  db: XosClient,
  id: string,
  input: AccommodationBlockInput,
  expectedUpdatedAt?: string,
): Promise<Result<null>> {
  let query = db.from("accommodation_blocks").update(blockColumns(input)).eq("id", id);
  if (expectedUpdatedAt) query = query.eq("updated_at", expectedUpdatedAt);
  const { data, error } = await query.select("id");
  if (error) return fail(toDataError(error));
  if (data.length === 1) return ok(null);
  return expectedUpdatedAt
    ? fail({ kind: "conflict", message: "accommodation_block_changed" })
    : fail({ kind: "not-found" });
}

/** Moves a block to Trash, or restores it with `deleted` false (the Undo). */
export async function deleteAccommodationBlock(
  db: XosClient,
  id: string,
  deleted = true,
): Promise<Result<null>> {
  const { data, error } = await db
    .from("accommodation_blocks")
    .update({ deleted_at: deleted ? new Date().toISOString() : null })
    .eq("id", id)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 1 ? ok(null) : fail({ kind: "not-found" });
}

export interface AssignmentInput {
  readonly personId: string;
  readonly checkInOn: string;
  readonly checkOutOn: string;
}

/**
 * Assigns a guest a room. Refused with accommodation_block_full when every room is taken on one of
 * the nights, accommodation_assignment_outside_block outside the window and
 * accommodation_assignment_duplicate when the guest already has a room those nights.
 */
export async function assignRoom(
  db: XosClient,
  blockId: string,
  input: AssignmentInput,
): Promise<Result<{ id: string }>> {
  const row: Derived<Tables["accommodation_assignments"]["Insert"]> = {
    accommodation_block_id: blockId,
    person_id: input.personId,
    check_in_on: input.checkInOn,
    check_out_on: input.checkOutOn,
  };
  const { data, error } = await db
    .from("accommodation_assignments")
    .insert(row as Tables["accommodation_assignments"]["Insert"])
    .select("id");
  if (error) return fail(toDataError(error));
  return one(data);
}

export async function removeRoomAssignment(db: XosClient, id: string): Promise<Result<null>> {
  const { data, error } = await db
    .from("accommodation_assignments")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 1 ? ok(null) : fail({ kind: "not-found" });
}

// Travel ---------------------------------------------------------------------------------------------

export type TravelMode = Database["app"]["Enums"]["travel_mode"];
export const TRAVEL_MODES: readonly TravelMode[] = ["Flight", "Ground"];

/** One flight or ground transport segment of a traveler (migration 0442). */
export interface TravelSegment {
  readonly id: string;
  readonly projectId: string;
  readonly projectKey: string;
  readonly personId: string;
  readonly personName: string | null;
  readonly fulfillmentId: string | null;
  readonly mode: TravelMode;
  readonly operatorName: string | null;
  readonly serviceIdentifier: string | null;
  readonly confirmationIdentifier: string | null;
  readonly departsFrom: string;
  readonly departsAt: string;
  readonly departsTimeZone: string;
  readonly arrivesAtPlace: string;
  readonly arrivesAt: string | null;
  readonly arrivesTimeZone: string;
  readonly priceMinor: number | null;
  readonly currencyCode: string | null;
}

interface TravelRow {
  id: string;
  project_id: string;
  person_id: string;
  fulfillment_id: string | null;
  travel_mode: TravelMode;
  operator_name: string | null;
  service_identifier: string | null;
  confirmation_identifier: string | null;
  departs_from: string;
  departs_at: string;
  departs_time_zone: string;
  arrives_at_place: string;
  arrives_at: string | null;
  arrives_time_zone: string;
  price_minor: number | null;
  currency_code: string | null;
  project: { project_key: string } | null;
  person: { full_name: string | null } | null;
}

const TRAVEL_COLUMNS =
  "id, project_id, person_id, fulfillment_id, travel_mode, operator_name, service_identifier, confirmation_identifier, " +
  "departs_from, departs_at, departs_time_zone, arrives_at_place, arrives_at, arrives_time_zone, price_minor, currency_code, " +
  "project:projects!travel_segments_project_id_fkey(project_key), person:people!travel_segments_person_id_fkey(full_name)";

function toTravel(row: TravelRow): TravelSegment {
  return {
    id: row.id,
    projectId: row.project_id,
    projectKey: row.project?.project_key ?? "",
    personId: row.person_id,
    personName: row.person?.full_name ?? null,
    fulfillmentId: row.fulfillment_id,
    mode: row.travel_mode,
    operatorName: row.operator_name,
    serviceIdentifier: row.service_identifier,
    confirmationIdentifier: row.confirmation_identifier,
    departsFrom: row.departs_from,
    departsAt: row.departs_at,
    departsTimeZone: row.departs_time_zone,
    arrivesAtPlace: row.arrives_at_place,
    arrivesAt: row.arrives_at,
    arrivesTimeZone: row.arrives_time_zone,
    priceMinor: row.price_minor,
    currencyCode: row.currency_code,
  };
}

export interface TravelScope extends OperationsScope {
  readonly fulfillmentId?: string;
}

/** Live travel segments in departure order. An empty orgId means the scope is a fulfillment. */
export async function listTravelSegments(
  db: XosClient,
  scope: TravelScope,
): Promise<Result<TravelSegment[]>> {
  let query = db.from("travel_segments").select(TRAVEL_COLUMNS).is("deleted_at", null);
  if (scope.orgId) query = query.eq("org_id", scope.orgId);
  if (scope.projectId) query = query.eq("project_id", scope.projectId);
  if (scope.fulfillmentId) query = query.eq("fulfillment_id", scope.fulfillmentId);
  const { data, error } = await query.order("departs_at");
  if (error) return fail(toDataError(error));
  return ok((data as unknown as TravelRow[]).map(toTravel));
}

export interface TravelInput {
  readonly personId: string;
  /** Engagement the person travels under when they are not a member (migration 0971); null for members. */
  readonly engagementId?: string | null;
  readonly fulfillmentId: string | null;
  readonly mode: TravelMode;
  readonly operatorName: string | null;
  readonly serviceIdentifier: string | null;
  readonly confirmationIdentifier: string | null;
  readonly departsFrom: string;
  readonly departsAt: string;
  readonly departsTimeZone: string;
  readonly arrivesAtPlace: string;
  readonly arrivesAt: string | null;
  readonly arrivesTimeZone: string;
  readonly priceMinor: number | null;
  readonly currencyCode: string | null;
}

/**
 * Books a travel segment. A segment under a fulfillment must use a Travel fulfillment of the same
 * project (travel_fulfillment_kind); zones must be IANA zones.
 */
export async function createTravelSegment(
  db: XosClient,
  projectId: string,
  input: TravelInput,
): Promise<Result<{ id: string }>> {
  const row: Derived<Tables["travel_segments"]["Insert"]> = {
    project_id: projectId,
    person_id: input.personId,
    engagement_id: input.engagementId ?? null,
    fulfillment_id: input.fulfillmentId,
    travel_mode: input.mode,
    operator_name: input.operatorName,
    service_identifier: input.serviceIdentifier,
    confirmation_identifier: input.confirmationIdentifier,
    departs_from: input.departsFrom,
    departs_at: input.departsAt,
    departs_time_zone: input.departsTimeZone,
    arrives_at_place: input.arrivesAtPlace,
    arrives_at: input.arrivesAt,
    arrives_time_zone: input.arrivesTimeZone,
    price_minor: input.priceMinor,
    currency_code: input.currencyCode,
  };
  const { data, error } = await db
    .from("travel_segments")
    .insert(row as Tables["travel_segments"]["Insert"])
    .select("id");
  if (error) return fail(toDataError(error));
  return one(data);
}

/** Cancels a travel segment; it is retained and emits travel_segment.canceled. */
export async function cancelTravelSegment(db: XosClient, id: string): Promise<Result<null>> {
  const { data, error } = await db
    .from("travel_segments")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 1 ? ok(null) : fail({ kind: "not-found" });
}
