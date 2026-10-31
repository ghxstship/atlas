/**
 * Scanning (Section 4.3 item 7, Section 11.13 Scan, Section 13 Scanning).
 *
 * Formats: EAN-13, UPC-A, GTIN-14 (ITF-14 and GS1-128), Code 128, QR, Data Matrix and NFC NDEF. GTIN
 * checksums are validated on device. A code that resolves to nothing goes to the intake queue for a person
 * to resolve; it is never mapped automatically.
 */
import { uuidv7, type MutationInput } from "@xos/sync";

export type Symbology =
  "ean13" | "upc_a" | "ean8" | "itf14" | "gs1_128" | "code128" | "qr" | "datamatrix" | "nfc";

/** expo-camera barcode type names mapped to symbologies. */
const CAMERA_TYPES: Readonly<Record<string, Symbology>> = {
  ean13: "ean13",
  upc_a: "upc_a",
  upc_e: "upc_a",
  ean8: "ean8",
  itf14: "itf14",
  code128: "code128",
  qr: "qr",
  datamatrix: "datamatrix",
};

export const SUPPORTED_CAMERA_TYPES = Object.keys(CAMERA_TYPES);

export function symbologyOf(cameraType: string): Symbology | null {
  return CAMERA_TYPES[cameraType] ?? null;
}

/** GS1 mod-10 check digit validation for GTIN-8, GTIN-12, GTIN-13 and GTIN-14. */
export function validGtin(digits: string): boolean {
  if (!/^\d{8}$|^\d{12,14}$/.test(digits)) return false;
  const body = digits.slice(0, -1);
  let sum = 0;
  for (let i = 0; i < body.length; i += 1) {
    const d = Number(body[body.length - 1 - i]);
    sum += i % 2 === 0 ? d * 3 : d;
  }
  return (10 - (sum % 10)) % 10 === Number(digits.at(-1));
}

/** GTIN normalized to 14 digits, the form asset identifiers store (scheme gtin14). */
export function gtin14(digits: string): string {
  return digits.padStart(14, "0");
}

const GS = String.fromCharCode(29);

/** Fixed-length GS1 application identifiers we read; others are variable length up to a separator. */
const FIXED_AI: Readonly<Record<string, number>> = {
  "00": 18,
  "01": 14,
  "02": 14,
  "11": 6,
  "13": 6,
  "15": 6,
  "17": 6,
};
const KNOWN_AI = ["00", "01", "02", "10", "11", "13", "15", "17", "21", "37", "400"];

export interface Gs1Data {
  readonly gtin?: string;
  readonly batch?: string;
  readonly serial?: string;
  readonly expiry?: string;
  readonly other: Readonly<Record<string, string>>;
}

/** Parses GS1 element strings in raw form (FNC1 as GS, with or without a symbology prefix) or with (AI) brackets. */
export function parseGs1(raw: string): Gs1Data | null {
  const text = raw.replace(/^\]C1|^\]d2|^\]Q3/, "");
  const fields: Record<string, string> = {};
  if (text.startsWith("(")) {
    const re = /\((\d{2,4})\)([^(]*)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text))) fields[match[1] ?? ""] = match[2] ?? "";
  } else {
    let rest = text;
    while (rest.length > 0) {
      if (rest.startsWith(GS)) {
        rest = rest.slice(1);
        continue;
      }
      const ai = KNOWN_AI.find((a) => rest.startsWith(a));
      if (!ai) return null;
      rest = rest.slice(ai.length);
      const fixed = FIXED_AI[ai];
      if (fixed !== undefined) {
        fields[ai] = rest.slice(0, fixed);
        rest = rest.slice(fixed);
      } else {
        const end = rest.indexOf(GS);
        fields[ai] = end === -1 ? rest : rest.slice(0, end);
        rest = end === -1 ? "" : rest.slice(end + 1);
      }
    }
  }
  if (Object.keys(fields).length === 0) return null;
  const { "01": gtin, "10": batch, "21": serial, "17": expiry, ...other } = fields;
  return {
    ...(gtin !== undefined ? { gtin } : {}),
    ...(batch !== undefined ? { batch } : {}),
    ...(serial !== undefined ? { serial } : {}),
    ...(expiry !== undefined ? { expiry } : {}),
    other,
  };
}

export type ScanCode =
  | {
      readonly kind: "gtin";
      readonly gtin14: string;
      readonly serial?: string;
      readonly batch?: string;
    }
  | { readonly kind: "credential"; readonly credentialNumber: string }
  | { readonly kind: "lot"; readonly lotId: string }
  | { readonly kind: "code"; readonly value: string }
  | { readonly kind: "invalid"; readonly reason: "checksum" | "empty" | "unsupported" };

/** Credential QR: the printed number (CR-000123) or the wallet form XOSCR1:<number>. */
const CREDENTIAL = /^(?:XOSCR1:)?(CR-\d{6,})$/;
const LOT = /^LOT:([0-9a-f-]{36})$/i;

export function classify(raw: string, symbology: Symbology | null): ScanCode {
  const value = raw.trim();
  if (value.length === 0) return { kind: "invalid", reason: "empty" };
  if (symbology === null) return { kind: "invalid", reason: "unsupported" };
  const credential = CREDENTIAL.exec(value);
  if (credential?.[1]) return { kind: "credential", credentialNumber: credential[1] };
  const lot = LOT.exec(value);
  if (lot?.[1]) return { kind: "lot", lotId: lot[1].toLowerCase() };
  if (
    symbology === "ean13" ||
    symbology === "upc_a" ||
    symbology === "ean8" ||
    symbology === "itf14"
  ) {
    return validGtin(value)
      ? { kind: "gtin", gtin14: gtin14(value) }
      : { kind: "invalid", reason: "checksum" };
  }
  if (
    symbology === "gs1_128" ||
    symbology === "datamatrix" ||
    symbology === "code128" ||
    symbology === "qr"
  ) {
    const gs1 =
      value.includes(GS) || value.startsWith("(01)") || /^\](C1|d2|Q3)/.test(value)
        ? parseGs1(value)
        : null;
    if (gs1?.gtin !== undefined) {
      if (!validGtin(gs1.gtin)) return { kind: "invalid", reason: "checksum" };
      return {
        kind: "gtin",
        gtin14: gtin14(gs1.gtin),
        ...(gs1.serial !== undefined ? { serial: gs1.serial } : {}),
        ...(gs1.batch !== undefined ? { batch: gs1.batch } : {}),
      };
    }
  }
  return { kind: "code", value };
}

/** Decodes an NFC NDEF text or URI record payload to the code it carries. */
export function ndefText(payload: readonly number[]): string | null {
  if (payload.length === 0) return null;
  const status = payload[0] ?? 0;
  const langLength = status & 0x3f;
  const bytes = payload.slice(1 + langLength);
  if (bytes.length === 0) return null;
  return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
}

// Credential checks at access points ----------------------------------------------------------------------

export interface CredentialRow {
  readonly id: string;
  readonly credential_number: string;
  readonly credential_category_id: string;
  readonly holder_person_id: string;
  readonly holder_name?: string | null;
  readonly valid_from: string;
  readonly valid_to: string | null;
  readonly revoked_at: string | null;
}

export interface AccessGridRow {
  readonly credential_category_id: string;
  readonly zone_id: string;
  readonly window_starts_at: string;
  readonly window_ends_at: string;
  readonly deleted_at?: string | null;
}

export type GateDecision =
  | { readonly result: "Granted"; readonly credential: CredentialRow }
  | {
      readonly result: "Denied";
      readonly reason:
        "unknown" | "revoked" | "not-yet-valid" | "expired" | "no-zone-access" | "outside-window";
      readonly credential: CredentialRow | null;
    };

/**
 * The device's decision at the gate, from the synced credentials and access grid. It mirrors
 * private.decide_access_scan; the server re-decides on upload and the two are compared.
 */
export function decideGate(
  credentialNumber: string,
  zoneId: string,
  credentials: readonly CredentialRow[],
  grid: readonly AccessGridRow[],
  nowMs: number,
): GateDecision {
  const credential = credentials.find((c) => c.credential_number === credentialNumber) ?? null;
  if (!credential) return { result: "Denied", reason: "unknown", credential: null };
  if (credential.revoked_at !== null) return { result: "Denied", reason: "revoked", credential };
  if (Date.parse(credential.valid_from) > nowMs)
    return { result: "Denied", reason: "not-yet-valid", credential };
  if (credential.valid_to !== null && Date.parse(credential.valid_to) <= nowMs) {
    return { result: "Denied", reason: "expired", credential };
  }
  const rows = grid.filter(
    (g) =>
      !g.deleted_at &&
      g.credential_category_id === credential.credential_category_id &&
      g.zone_id === zoneId,
  );
  if (rows.length === 0) return { result: "Denied", reason: "no-zone-access", credential };
  const open = rows.some(
    (g) => Date.parse(g.window_starts_at) <= nowMs && Date.parse(g.window_ends_at) > nowMs,
  );
  return open
    ? { result: "Granted", credential }
    : { result: "Denied", reason: "outside-window", credential };
}

export function buildAccessScan(
  credential: CredentialRow,
  zoneId: string,
  decision: GateDecision,
  deviceAt: string,
  nowMs: number,
  newId: (ms: number) => string = uuidv7,
): MutationInput {
  const id = newId(nowMs);
  const row = {
    id,
    credential_id: credential.id,
    zone_id: zoneId,
    device_scanned_at: deviceAt,
    offline_result: decision.result,
  };
  // app.record_scan (A14): the database decides the result; p_id makes a replay return the first answer.
  return {
    op: "rpc",
    target: "record_scan",
    table: "access_scans",
    rowId: id,
    payload: {
      p_zone_id: zoneId,
      p_credential_id: credential.id,
      p_id: id,
      p_device_scanned_at: deviceAt,
      p_offline_result: decision.result,
    },
    policy: "append",
    optimistic: row,
  };
}

// Continuous mode ------------------------------------------------------------------------------------------

export interface BatchItem {
  readonly code: string;
  readonly symbology: Symbology;
  readonly count: number;
  readonly firstAt: number;
}

/** Bulk receiving: a running count with a haptic per accepted scan, then a batch review (Section 11.13). */
export class ContinuousScan {
  readonly #items = new Map<string, BatchItem>();
  readonly #repeatWindowMs: number;
  #lastCode: string | null = null;
  #lastAt = 0;
  #total = 0;

  constructor(repeatWindowMs = 1_500) {
    this.#repeatWindowMs = repeatWindowMs;
  }

  /**
   * Adds a scan. The camera reports the same code many times while it stays in frame; repeats inside the
   * window are ignored. Returns true when the scan counted, which is when the haptic fires.
   */
  add(code: string, symbology: Symbology, atMs: number): boolean {
    if (code === this.#lastCode && atMs - this.#lastAt < this.#repeatWindowMs) {
      this.#lastAt = atMs;
      return false;
    }
    this.#lastCode = code;
    this.#lastAt = atMs;
    const existing = this.#items.get(code);
    this.#items.set(
      code,
      existing
        ? { ...existing, count: existing.count + 1 }
        : { code, symbology, count: 1, firstAt: atMs },
    );
    this.#total += 1;
    return true;
  }

  /** Removes one counted unit, from the batch review. */
  decrement(code: string): void {
    const item = this.#items.get(code);
    if (!item) return;
    this.#total -= 1;
    if (item.count <= 1) this.#items.delete(code);
    else this.#items.set(code, { ...item, count: item.count - 1 });
  }

  get total(): number {
    return this.#total;
  }

  items(): BatchItem[] {
    return [...this.#items.values()].sort((a, b) => a.firstAt - b.firstAt);
  }
}

// Intake --------------------------------------------------------------------------------------------------

export interface IntakeContext {
  readonly orgId: string;
  readonly projectId: string;
  readonly mode: "asset" | "receiving" | "credential" | "lookup";
  readonly deviceAt: string;
}

/** app.scan_symbology labels for each device symbology. GS1-128 is a Code 128 symbol. */
const SERVER_SYMBOLOGY: Readonly<Record<Symbology, string>> = {
  ean13: "EAN-13",
  upc_a: "UPC-A",
  ean8: "EAN-8",
  itf14: "ITF-14",
  gs1_128: "Code 128",
  code128: "Code 128",
  qr: "QR Code",
  datamatrix: "Data Matrix",
  nfc: "NFC",
};

/** app.scan_mode labels for the Compass scan modes; receiving logs against shipments. */
const SERVER_MODE = {
  asset: "Asset",
  receiving: "Shipment",
  credential: "Credential",
  lookup: "Lookup",
} as const;

export function serverSymbology(symbology: Symbology): string {
  return SERVER_SYMBOLOGY[symbology];
}

/** Queues an unknown code for human resolution (app.scan_intake). Never maps it automatically. */
export function buildIntake(
  code: string,
  symbology: Symbology,
  ctx: IntakeContext,
  nowMs: number,
  newId: (ms: number) => string = uuidv7,
): MutationInput {
  const label = serverSymbology(symbology);
  const id = newId(nowMs);
  const row = {
    id,
    org_id: ctx.orgId,
    project_id: ctx.projectId,
    scanned_value: code,
    symbology: label,
    scan_mode: SERVER_MODE[ctx.mode],
    device_scanned_at: ctx.deviceAt,
  };
  return {
    op: "insert",
    table: "scan_intake",
    rowId: id,
    payload: row,
    policy: "append",
    optimistic: row,
  };
}

// Asset custody --------------------------------------------------------------------------------------------

export interface AssetUnitRow {
  readonly id: string;
  readonly asset_tag: string;
  readonly asset_state: string;
  /** When the server last changed the unit; a custody row newer than this decides its state. */
  readonly updated_at?: string | null;
}

/**
 * The unit's state as the device knows it now. A scan writes its custody row on the device at once, but
 * the unit row only changes at the next download; until then a newer custody row decides: a custodian
 * means Deployed, none means returned (Available). On the simulator a check-out followed by an
 * immediate return was sent as a second check-out and refused.
 */
export function effectiveAssetState(unit: AssetUnitRow, custody: CustodyRow | null): string {
  const custodyAt = custody?.created_at ? Date.parse(custody.created_at) : Number.NaN;
  const unitAt = unit.updated_at ? Date.parse(unit.updated_at) : Number.NaN;
  if (!custody || Number.isNaN(custodyAt) || Number.isNaN(unitAt) || custodyAt <= unitAt) {
    return unit.asset_state;
  }
  if (
    unit.asset_state !== "Available" &&
    unit.asset_state !== "Reserved" &&
    unit.asset_state !== "Deployed"
  ) {
    return unit.asset_state;
  }
  const held =
    custody.custodian_membership_id !== null || (custody.custodian_engagement_id ?? null) !== null;
  return held ? "Deployed" : "Available";
}

export interface AssetIdentifierRow {
  readonly asset_unit_id: string;
  readonly scheme: string;
  readonly value: string;
}

export interface CustodyRow {
  readonly id: string;
  readonly asset_unit_id: string;
  readonly custodian_membership_id: string | null;
  readonly custodian_engagement_id?: string | null;
  readonly venue_id: string | null;
  readonly created_at?: string;
}

export type AssetResolution =
  | { readonly kind: "unit"; readonly unit: AssetUnitRow; readonly custody: CustodyRow | null }
  | { readonly kind: "unknown" }
  | { readonly kind: "ambiguous"; readonly units: readonly AssetUnitRow[] };

/**
 * Resolves a scan to an asset unit on device: asset tag first, then an identifier (GTIN normalized to 14
 * digits, serial, other schemes), then the latest custody row. Mirrors the server lookup order (A12).
 */
export function resolveAsset(
  code: ScanCode,
  units: readonly AssetUnitRow[],
  identifiers: readonly AssetIdentifierRow[],
  custody: readonly CustodyRow[],
): AssetResolution {
  const byId = new Map(units.map((u) => [u.id, u]));
  let matches: AssetUnitRow[] = [];
  if (code.kind === "code") {
    const tag = code.value.toUpperCase();
    matches = units.filter((u) => u.asset_tag === tag);
    if (matches.length === 0) {
      matches = identifiers
        .filter((i) => i.value === code.value)
        .flatMap((i) => byId.get(i.asset_unit_id) ?? []);
    }
  } else if (code.kind === "gtin") {
    const ids = identifiers.filter(
      (i) =>
        (i.scheme === "gtin14" && i.value === code.gtin14) ||
        (code.serial !== undefined && i.scheme === "serial" && i.value === code.serial),
    );
    const units14 = [...new Set(ids.map((i) => i.asset_unit_id))].flatMap(
      (id) => byId.get(id) ?? [],
    );
    const serialMatch =
      code.serial === undefined
        ? []
        : ids.filter((i) => i.scheme === "serial").flatMap((i) => byId.get(i.asset_unit_id) ?? []);
    matches = serialMatch.length > 0 ? serialMatch : units14;
  }
  const unique = [...new Map(matches.map((u) => [u.id, u])).values()];
  if (unique.length === 0) return { kind: "unknown" };
  if (unique.length > 1) return { kind: "ambiguous", units: unique };
  const unit = unique[0] as AssetUnitRow;
  const latest =
    custody
      .filter((c) => c.asset_unit_id === unit.id)
      .sort((a, b) => (b.created_at ?? b.id).localeCompare(a.created_at ?? a.id))[0] ?? null;
  return { kind: "unit", unit, custody: latest };
}

/** Units in these states cannot change hands from the field. */
const UNAVAILABLE_STATES = new Set(["Proposed", "In Maintenance", "Damaged", "Lost", "Retired"]);

export function custodyBlocked(unit: AssetUnitRow): boolean {
  return UNAVAILABLE_STATES.has(unit.asset_state);
}

export type AssetScanAction = "check-out" | "check-in" | "transfer";

/**
 * What a scan does to a unit: a unit the person already holds goes back (check-in), a unit someone
 * else holds moves to the person (transfer), and anything else is checked out to them.
 */
export function assetScanAction(
  unit: AssetUnitRow,
  custody: CustodyRow | null,
  me: { membershipId: string | null; engagementIds: readonly string[] },
): AssetScanAction {
  const mine =
    custody !== null &&
    ((me.membershipId !== null && custody.custodian_membership_id === me.membershipId) ||
      (typeof custody.custodian_engagement_id === "string" &&
        me.engagementIds.includes(custody.custodian_engagement_id)));
  if (effectiveAssetState(unit, custody) === "Deployed") return mine ? "check-in" : "transfer";
  return "check-out";
}

export interface AssetScan {
  readonly orgId: string;
  /** The code the server resolves: the unit's asset tag. */
  readonly code: string;
  readonly unitId: string;
  readonly action: AssetScanAction;
  readonly custodianMembershipId: string | null;
  readonly custodianEngagementId: string | null;
  readonly venueId: string | null;
  readonly projectId: string | null;
  readonly note: string | null;
}

/**
 * Queues one scan event for app.apply_asset_scan (A12 0975), replayed through app.apply_sync_mutation:
 * the server resolves the code, writes the custody row under the device-minted event id and moves the
 * unit state in one transaction, so a replay answers duplicate and never hands the unit over twice.
 * Check-in returns the unit to a place, so it names no custodian.
 */
export function buildAssetScan(
  scan: AssetScan,
  nowMs: number,
  newId: (ms: number) => string = uuidv7,
): MutationInput {
  const id = newId(nowMs);
  const returning = scan.action === "check-in";
  const membership = returning ? null : scan.custodianMembershipId;
  const engagement = returning ? null : scan.custodianEngagementId;
  return {
    op: "rpc",
    target: "app.apply_asset_scan",
    table: "asset_custody",
    rowId: id,
    payload: {
      p_event_id: id,
      p_org_id: scan.orgId,
      p_code: scan.code,
      p_action: scan.action,
      p_custodian_membership_id: membership,
      p_custodian_engagement_id: engagement,
      p_venue_id: scan.venueId,
      p_project_id: returning ? null : scan.projectId,
      p_note: scan.note,
    },
    policy: "append",
    optimistic: {
      id,
      org_id: scan.orgId,
      asset_unit_id: scan.unitId,
      custodian_membership_id: membership,
      custodian_engagement_id: engagement,
      venue_id: scan.venueId,
      project_id: returning ? null : scan.projectId,
      created_at: new Date(nowMs).toISOString(),
    },
  };
}

/** Crew and staff scan only gear assigned to them (sitemap scope "assigned"). */
export function custodyAllowed(
  scope: "all" | "assigned",
  currentCustodian: { membershipId: string | null; engagementId: string | null } | null,
  me: { membershipId: string | null; engagementIds: readonly string[] },
): boolean {
  if (scope === "all") return true;
  if (!currentCustodian) return false;
  return (
    (currentCustodian.membershipId !== null && currentCustodian.membershipId === me.membershipId) ||
    (currentCustodian.engagementId !== null &&
      me.engagementIds.includes(currentCustodian.engagementId))
  );
}

/**
 * The headline of a gate scan: the verdict, then what names it (the badge holder, or why it was denied)
 * after a middle dot. A badge with no holder name reads as the verdict alone, never "Access granted ·"
 * with nothing after the dot (A68, A66).
 */
export function gateScanTitle(verdict: string, detail: string | null | undefined): string {
  const named = detail?.trim();
  return named ? `${verdict} · ${named}` : verdict;
}

// Receiving against an order (R7a) -------------------------------------------------------------------------

/** An open line of an Approved or Sent order, as the Receive against an order sheet lists it. */
export interface ReceivableLine {
  readonly poLineId: string;
  readonly lineNumber: number;
  readonly description: string;
  /** Ordered less received (app.po_line_supply); the sheet never offers more. */
  readonly open: number;
  /** The ordered element has an asset class: scanned codes become the units' asset tags. */
  readonly serialized: boolean;
}

export interface ReceivableOrder {
  readonly purchaseOrderId: string;
  readonly poNumber: number;
  readonly vendorName: string | null;
  readonly lines: readonly ReceivableLine[];
}

/** What the sheet has counted so far: tags per serialized line, quantities for the rest. */
export interface ReceiveSheet {
  readonly order: ReceivableOrder;
  /** The serialized line scanned codes go to. */
  readonly activeLineId: string | null;
  readonly tags: Readonly<Record<string, readonly string[]>>;
  readonly quantities: Readonly<Record<string, number>>;
}

/** The orders the sheet offers, from REST rows read online under RLS: open lines only, orders with one or more. */
export function receivableOrders(
  orders: readonly {
    id: string;
    po_number: number;
    po_state: string;
    vendor_name: string | null;
  }[],
  lines: readonly {
    id: string;
    purchase_order_id: string;
    line_number: number;
    description: string;
    element_id: string | null;
  }[],
  supply: readonly { po_line_id: string; quantity_ordered: number; quantity_received: number }[],
  classElements: readonly string[],
): ReceivableOrder[] {
  const progress = new Map(supply.map((s) => [s.po_line_id, s]));
  const stocked = new Set(classElements);
  return orders
    .filter((o) => o.po_state === "Approved" || o.po_state === "Sent")
    .map((o) => ({
      purchaseOrderId: o.id,
      poNumber: o.po_number,
      vendorName: o.vendor_name,
      lines: lines
        .filter((l) => l.purchase_order_id === o.id)
        .map((l) => {
          const s = progress.get(l.id);
          return {
            poLineId: l.id,
            lineNumber: l.line_number,
            description: l.description,
            open: s ? Math.max(0, s.quantity_ordered - s.quantity_received) : 0,
            serialized: l.element_id !== null && stocked.has(l.element_id),
          };
        })
        .filter((l) => l.open > 0)
        .sort((a, b) => a.lineNumber - b.lineNumber),
    }))
    .filter((o) => o.lines.length > 0)
    .sort((a, b) => a.poNumber - b.poNumber);
}

export function startReceiveSheet(order: ReceivableOrder): ReceiveSheet {
  return {
    order,
    activeLineId: order.lines.find((l) => l.serialized)?.poLineId ?? null,
    tags: {},
    quantities: {},
  };
}

/**
 * A scanned code fills the tag list of the chosen serialized line: once per code, never past the line's open
 * quantity. Returns the same sheet when the code is a repeat, no serialized line is chosen or the line is full.
 */
export function addScannedTag(sheet: ReceiveSheet, raw: string): ReceiveSheet {
  const line = sheet.order.lines.find((l) => l.poLineId === sheet.activeLineId);
  const tag = raw.trim().toUpperCase();
  if (!line?.serialized || tag === "") return sheet;
  const taken = Object.values(sheet.tags).some((tags) => tags.includes(tag));
  const current = sheet.tags[line.poLineId] ?? [];
  if (taken || current.length >= line.open) return sheet;
  return { ...sheet, tags: { ...sheet.tags, [line.poLineId]: [...current, tag] } };
}

export function removeScannedTag(sheet: ReceiveSheet, poLineId: string, tag: string): ReceiveSheet {
  const current = sheet.tags[poLineId] ?? [];
  return { ...sheet, tags: { ...sheet.tags, [poLineId]: current.filter((t) => t !== tag) } };
}

/** A stepper sets the quantity of a line that is not serialized, between 0 and its open quantity. */
export function setReceiveQuantity(
  sheet: ReceiveSheet,
  poLineId: string,
  quantity: number,
): ReceiveSheet {
  const line = sheet.order.lines.find((l) => l.poLineId === poLineId);
  if (!line || line.serialized) return sheet;
  const next = Math.min(Math.max(0, Math.round(quantity)), line.open);
  return { ...sheet, quantities: { ...sheet.quantities, [poLineId]: next } };
}

/** The lines the sheet would receive: tags of serialized lines, quantities of the rest; empty lines left out. */
export function receiveSheetLines(
  sheet: ReceiveSheet,
): { po_line_id: string; quantity: number; asset_tags?: string[] }[] {
  return sheet.order.lines.flatMap((l) => {
    if (l.serialized) {
      const tags = [...(sheet.tags[l.poLineId] ?? [])];
      return tags.length > 0
        ? [{ po_line_id: l.poLineId, quantity: tags.length, asset_tags: tags }]
        : [];
    }
    const quantity = sheet.quantities[l.poLineId] ?? 0;
    return quantity > 0 ? [{ po_line_id: l.poLineId, quantity }] : [];
  });
}

/**
 * Queues the sheet as one receipt event for app.receive_goods (R7a 2681), replayed through
 * app.apply_sync_mutation: the mutation id is the event id, so a replay after a reconnect answers duplicate and
 * records nothing twice. Null when the sheet counted nothing.
 */
export function buildOrderReceipt(
  sheet: ReceiveSheet,
  note: string | null,
  nowMs: number,
  newId: (ms: number) => string = uuidv7,
): MutationInput | null {
  const lines = receiveSheetLines(sheet);
  if (lines.length === 0) return null;
  const id = newId(nowMs);
  return {
    op: "rpc",
    target: "app.receive_goods",
    table: "goods_receipts",
    rowId: id,
    payload: {
      p_event_id: id,
      p_purchase_order_id: sheet.order.purchaseOrderId,
      p_lines: lines,
      p_note: note?.trim() ? note.trim() : null,
    },
    policy: "append",
  };
}
