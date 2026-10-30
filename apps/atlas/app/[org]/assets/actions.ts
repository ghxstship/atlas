"use server";

import type { DataError } from "@xos/data";
import {
  addAssetIdentifier,
  archiveAssetClass,
  countAssetLot,
  createAssetClass,
  createAssetLot,
  createAssetUnit,
  applyAssetScanEvent,
  isAssetState,
  recordAssetMaintenance,
  removeAssetIdentifier,
  renameAssetClass,
  reportAssetDamage,
  resolveAssetScan,
  SCAN_ACTIONS,
  searchAssetElements,
  transitionAssetUnit,
  updateAssetUnit,
  type ElementOption,
  type ScanAction,
  type ScannedLot,
  type ScannedUnit,
} from "@xos/data/assets";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getOrgContext, getViewer } from "@/lib/shell/context";
import { customFieldsOf } from "@/lib/custom-fields/form";
import { minorUnits } from "@/lib/assets/money";
import { observability } from "@/lib/observability";

/**
 * Assets actions (Section 4.2 Assets). Each resolves the viewer's org context again (404 when it is
 * gone), validates the form, and calls the assets repository; row level security, the transition
 * RPC and the guards of migrations 0352, 0450 and 0975 decide every write. Errors come back as
 * catalog keys under `assets.errors`, so every refusal names its rule in the viewer's language.
 */

export interface AssetActionState {
  readonly error?: string;
  readonly field?: string;
  readonly ok?: boolean;
  /** A created unit's tag, so the form can open it. */
  readonly assetTag?: string;
}

/** Refusal rules with their own copy in `assets.errors`; anything else reads as unexpected. */
const KNOWN_RULES = new Set([
  "asset_class_in_use",
  "asset_lot_count_negative",
  "asset_lot_insufficient",
  "asset_lot_quantity_ledger",
  "asset_state_conflict",
  "asset_tag_immutable",
  "asset_transition_not_allowed",
  "cross_org_reference",
  "enumeration_domain",
  "transition_reason_required",
]);

function errorKey(error: DataError): AssetActionState {
  switch (error.kind) {
    case "refusal":
      return { error: KNOWN_RULES.has(error.rule) ? error.rule : "refused" };
    case "not-found":
      return { error: "notFound" };
    case "conflict":
      return { error: "conflict" };
    case "invalid":
      return { error: "invalid", field: error.message };
    default:
      observability.logger.error("assets action failed", { error: error });
      return { error: "unexpected" };
  }
}

async function contextFor(form: FormData) {
  const slug = form.get("org");
  const ctx = typeof slug === "string" ? await getOrgContext(slug) : null;
  if (!ctx) notFound();
  return ctx;
}

const optionalId = z
  .union([z.uuid(), z.literal("")])
  .optional()
  .transform((v) => (v ? v : null));
const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : null));

function done(slug: string): AssetActionState {
  revalidatePath(`/${slug}/assets`, "layout");
  revalidatePath(`/${slug}/p`, "layout");
  return { ok: true };
}

function fields(form: FormData, names: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(names.map((n) => [n, form.get(n) ?? undefined]));
}

// Classes ------------------------------------------------------------------------------------------

/** Canon elements for the new class form; reading canon needs only a signed-in viewer. */
export async function searchElementsAction(query: string): Promise<ElementOption[]> {
  const parsed = z.string().max(100).safeParse(query);
  if (!parsed.success) return [];
  const viewer = await getViewer();
  if (!viewer) return [];
  const result = await searchAssetElements(viewer.db, parsed.data);
  if (!result.ok) {
    observability.logger.error("element search failed", { error: result.error });
    return [];
  }
  return result.data;
}

export async function createClassAction(
  _: AssetActionState,
  form: FormData,
): Promise<AssetActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({ elementId: text(64), name: text(200) })
    .safeParse(fields(form, ["elementId", "name"]));
  if (!parsed.success) {
    return { error: "invalid", field: String(parsed.error.issues[0]?.path[0] ?? "name") };
  }
  const result = await createAssetClass(ctx.viewer.db, { orgId: ctx.org.id, ...parsed.data });
  return result.ok ? done(ctx.org.slug) : errorKey(result.error);
}

export async function renameClassAction(
  _: AssetActionState,
  form: FormData,
): Promise<AssetActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({ classId: z.uuid(), name: text(200) })
    .safeParse(fields(form, ["classId", "name"]));
  if (!parsed.success) return { error: "invalid", field: "name" };
  const result = await renameAssetClass(ctx.viewer.db, parsed.data.classId, parsed.data.name);
  return result.ok ? done(ctx.org.slug) : errorKey(result.error);
}

export async function archiveClassAction(
  _: AssetActionState,
  form: FormData,
): Promise<AssetActionState> {
  const ctx = await contextFor(form);
  const id = z.uuid().safeParse(form.get("classId"));
  if (!id.success) return { error: "notFound" };
  const result = await archiveAssetClass(ctx.viewer.db, id.data);
  return result.ok ? done(ctx.org.slug) : errorKey(result.error);
}

// Units --------------------------------------------------------------------------------------------

export async function createUnitAction(
  _: AssetActionState,
  form: FormData,
): Promise<AssetActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({
      classId: z.uuid(),
      assetTag: text(32),
      conditionEnumId: optionalText(32),
      homeVenueId: optionalId,
    })
    .safeParse(fields(form, ["classId", "assetTag", "conditionEnumId", "homeVenueId"]));
  if (!parsed.success) {
    return { error: "invalid", field: String(parsed.error.issues[0]?.path[0] ?? "assetTag") };
  }
  const custom = await customFieldsOf(ctx, "app.asset_units", form);
  const problem = Object.keys(custom.fieldErrors ?? {})[0];
  if (problem) return { error: "invalid", field: problem };
  const result = await createAssetUnit(ctx.viewer.db, { orgId: ctx.org.id, ...parsed.data });
  if (!result.ok) return errorKey(result.error);
  await custom.save(result.data.id);
  return { ...done(ctx.org.slug), assetTag: result.data.assetTag };
}

export async function updateUnitAction(
  _: AssetActionState,
  form: FormData,
): Promise<AssetActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({ unitId: z.uuid(), conditionEnumId: optionalText(32), homeVenueId: optionalId })
    .safeParse(fields(form, ["unitId", "conditionEnumId", "homeVenueId"]));
  if (!parsed.success) return { error: "invalid" };
  const { unitId, ...rest } = parsed.data;
  const result = await updateAssetUnit(ctx.viewer.db, unitId, rest);
  return result.ok ? done(ctx.org.slug) : errorKey(result.error);
}

export async function transitionUnitAction(
  _: AssetActionState,
  form: FormData,
): Promise<AssetActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({
      unitId: z.uuid(),
      expected: z.string().refine(isAssetState),
      next: z.string().refine(isAssetState),
      reason: text(500),
    })
    .safeParse(fields(form, ["unitId", "expected", "next", "reason"]));
  if (!parsed.success) {
    return { error: "invalid", field: String(parsed.error.issues[0]?.path[0] ?? "reason") };
  }
  const { unitId, expected, next, reason } = parsed.data;
  if (!isAssetState(expected) || !isAssetState(next)) return { error: "invalid" };
  const result = await transitionAssetUnit(ctx.viewer.db, { unitId, expected, next, reason });
  return result.ok ? done(ctx.org.slug) : errorKey(result.error);
}

export async function addIdentifierAction(
  _: AssetActionState,
  form: FormData,
): Promise<AssetActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({ unitId: z.uuid(), scheme: text(32), value: text(100) })
    .safeParse(fields(form, ["unitId", "scheme", "value"]));
  if (!parsed.success) {
    return { error: "invalid", field: String(parsed.error.issues[0]?.path[0] ?? "value") };
  }
  const result = await addAssetIdentifier(ctx.viewer.db, { orgId: ctx.org.id, ...parsed.data });
  return result.ok ? done(ctx.org.slug) : errorKey(result.error);
}

export async function removeIdentifierAction(
  _: AssetActionState,
  form: FormData,
): Promise<AssetActionState> {
  const ctx = await contextFor(form);
  const id = z.uuid().safeParse(form.get("identifierId"));
  if (!id.success) return { error: "notFound" };
  const result = await removeAssetIdentifier(ctx.viewer.db, id.data);
  return result.ok ? done(ctx.org.slug) : errorKey(result.error);
}

// Lots ---------------------------------------------------------------------------------------------

export async function createLotAction(
  _: AssetActionState,
  form: FormData,
): Promise<AssetActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({ classId: z.uuid(), venueId: z.uuid(), quantity: z.coerce.number().min(0) })
    .safeParse(fields(form, ["classId", "venueId", "quantity"]));
  if (!parsed.success) {
    return { error: "invalid", field: String(parsed.error.issues[0]?.path[0] ?? "quantity") };
  }
  const result = await createAssetLot(ctx.viewer.db, { orgId: ctx.org.id, ...parsed.data });
  return result.ok ? done(ctx.org.slug) : errorKey(result.error);
}

export async function countLotAction(
  _: AssetActionState,
  form: FormData,
): Promise<AssetActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({ lotId: z.uuid(), counted: z.coerce.number().min(0), note: optionalText(1000) })
    .safeParse(fields(form, ["lotId", "counted", "note"]));
  if (!parsed.success) return { error: "invalid", field: "counted" };
  const result = await countAssetLot(ctx.viewer.db, parsed.data);
  return result.ok ? done(ctx.org.slug) : errorKey(result.error);
}

// Custody and scans --------------------------------------------------------------------------------

export type ScanLookup =
  | { readonly kind: "unit"; readonly unit: ScannedUnit; readonly actions: readonly ScanAction[] }
  | { readonly kind: "lot"; readonly lot: ScannedLot }
  | { readonly kind: "refused"; readonly error: string };

/** Looks up a typed or scanned code (app.resolve_asset_code) for the custody desk. */
export async function resolveCodeAction(org: string, code: string): Promise<ScanLookup> {
  const ctx = await getOrgContext(org);
  if (!ctx) notFound();
  const parsed = z.string().trim().min(1).max(200).safeParse(code);
  if (!parsed.success) return { kind: "refused", error: "asset_code_unknown" };
  const result = await resolveAssetScan(ctx.viewer.db, { orgId: ctx.org.id, code: parsed.data });
  if (result.ok) return result.data;
  if (result.error.kind === "refusal" && result.error.message === "NO_ANSWER") {
    return {
      kind: "refused",
      error:
        result.error.rule === "asset_code_ambiguous" ? result.error.rule : "asset_code_unknown",
    };
  }
  const state = errorKey(result.error);
  return { kind: "refused", error: state.error ?? "unexpected" };
}

const SCAN_RULES = new Set([
  "asset_code_ambiguous",
  "asset_code_unknown",
  "asset_scan_custodian_required",
  "asset_scan_lot_transfer",
  "asset_scan_place_required",
  "asset_scan_quantity_required",
  "asset_scan_state_conflict",
  "asset_scan_unavailable",
  "asset_scan_event_reused",
  "asset_scan_engagement_closed",
  "asset_scan_engagement_project",
  // R7: holder rules of a hand-over (2692).
  "asset_reserved_for_other",
  "asset_class_held_for_reservations",
  "custody_not_reserved_holder",
  "custody_reservation_exhausted",
  "custody_reservation_window",
  "custody_roster_engagement",
  "custody_roster_entry_not_live",
  "lot_held_for_reservations",
  "lot_reservation_mismatch",
]);

/**
 * Checks a unit or lot out, in, or across by its code (app.apply_asset_scan), the same RPC Compass
 * calls. The form mints the event id when it opens, so a double submit is applied once.
 */
export async function custodyScanAction(
  _: AssetActionState,
  form: FormData,
): Promise<AssetActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({
      eventId: z.uuid(),
      code: text(200),
      action: z.enum(SCAN_ACTIONS),
      // The Custodian select sends m:<membership id> or e:<engagement id>.
      custodian: z
        .union([z.string().regex(/^[me]:[0-9a-f-]{36}$/), z.literal("")])
        .optional()
        .transform((v) => (v ? v : null)),
      venueId: optionalId,
      projectId: optionalId,
      note: optionalText(1000),
      quantity: z
        .union([z.coerce.number().positive(), z.literal("")])
        .optional()
        .transform((v) => (typeof v === "number" ? v : null)),
      // R7: an allocation hold as <reservation id>|<roster entry id or empty>.
      hold: z
        .union([z.string().regex(/^[0-9a-f-]{36}\|([0-9a-f-]{36})?$/), z.literal("")])
        .optional()
        .transform((v) => (v ? v : null)),
    })
    .safeParse(
      fields(form, [
        "eventId",
        "code",
        "action",
        "custodian",
        "venueId",
        "projectId",
        "note",
        "quantity",
        "hold",
      ]),
    );
  if (!parsed.success) {
    return { error: "invalid", field: String(parsed.error.issues[0]?.path[0] ?? "code") };
  }
  const { custodian, hold, ...scan } = parsed.data;
  const [reservationId, rosterEntryId] = hold ? hold.split("|") : [null, null];
  const result = await applyAssetScanEvent(ctx.viewer.db, {
    orgId: ctx.org.id,
    ...scan,
    membershipId: custodian?.startsWith("m:") ? custodian.slice(2) : null,
    engagementId: custodian?.startsWith("e:") ? custodian.slice(2) : null,
    reservationId: reservationId || null,
    rosterEntryId: rosterEntryId || null,
  });
  if (!result.ok) {
    if (result.error.kind === "refusal" && SCAN_RULES.has(result.error.rule)) {
      return { error: result.error.rule };
    }
    return errorKey(result.error);
  }
  return done(ctx.org.slug);
}

// Maintenance and damage ---------------------------------------------------------------------------

export async function recordMaintenanceAction(
  _: AssetActionState,
  form: FormData,
): Promise<AssetActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({
      unitId: z.uuid(),
      performedOn: z.iso.date(),
      description: text(2000),
      cost: z.string().trim().optional(),
      currencyCode: z.string().regex(/^[A-Z]{3}$/),
    })
    .safeParse(fields(form, ["unitId", "performedOn", "description", "cost", "currencyCode"]));
  if (!parsed.success) {
    return { error: "invalid", field: String(parsed.error.issues[0]?.path[0] ?? "description") };
  }
  const { cost, currencyCode, ...rest } = parsed.data;
  const costMinor = cost ? minorUnits(cost, currencyCode) : null;
  if (cost && costMinor === null) return { error: "invalid", field: "cost" };
  const result = await recordAssetMaintenance(ctx.viewer.db, {
    orgId: ctx.org.id,
    ...rest,
    costMinor,
    currencyCode: costMinor === null ? null : currencyCode,
  });
  return result.ok ? done(ctx.org.slug) : errorKey(result.error);
}

export async function reportDamageAction(
  _: AssetActionState,
  form: FormData,
): Promise<AssetActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({ unitId: z.uuid(), projectId: optionalId, description: text(2000) })
    .safeParse(fields(form, ["unitId", "projectId", "description"]));
  if (!parsed.success) {
    return { error: "invalid", field: String(parsed.error.issues[0]?.path[0] ?? "description") };
  }
  const result = await reportAssetDamage(ctx.viewer.db, { orgId: ctx.org.id, ...parsed.data });
  return result.ok ? done(ctx.org.slug) : errorKey(result.error);
}

/** One allocation hold a unit may be checked out against, for the check-out dialog's Allocation select (R7). */
export interface AllocationHoldOption {
  readonly value: string;
  readonly label: string;
}

/**
 * The live holds of Approved allocations of a unit's class with units left, read when the check-out dialog opens:
 * the unit's own pin and the class-stock and order-line holds. Picking one sends the hold and its person to the scan,
 * so the custody row names them and the holder guards apply.
 */
export async function allocationHoldsAction(
  org: string,
  code: string,
): Promise<readonly AllocationHoldOption[]> {
  const ctx = await getOrgContext(org);
  if (!ctx) return [];
  const db = ctx.viewer.db;
  const unit = await db
    .from("asset_units")
    .select("id, asset_class_id")
    .eq("org_id", ctx.org.id)
    .eq("asset_tag", code.trim().toUpperCase())
    .is("deleted_at", null)
    .maybeSingle();
  if (!unit.data) return [];
  const holds = await db
    .from("asset_reservations")
    .select("id, asset_unit_id, asset_lot_id, quantity, advance_allocation_id")
    .is("released_at", null)
    .is("deleted_at", null)
    .is("asset_lot_id", null)
    .limit(200);
  const statuses = await db
    .from("advance_allocation_status")
    .select(
      "allocation_id, roster_entry_id, holder_engagement_id, item_name, quantity, issued_quantity, allocation_state",
    )
    .eq("org_id", ctx.org.id)
    .eq("allocation_state", "Approved")
    .eq("kind", "Asset");
  const classOf = await db
    .from("advance_allocations")
    .select("id, asset_class_id")
    .eq("asset_class_id", unit.data.asset_class_id);
  const ofClass = new Set((classOf.data ?? []).map((a) => a.id));
  const holders = await db
    .from("allocation_holders")
    .select("roster_entry_id, engagement_id, holder_kind, holder_name, party_name");
  const byAllocation = new Map((statuses.data ?? []).map((s) => [s.allocation_id, s]));
  return (holds.data ?? []).flatMap((h) => {
    const a = byAllocation.get(h.advance_allocation_id);
    if (!a || !ofClass.has(h.advance_allocation_id)) return [];
    if (h.asset_unit_id !== null && h.asset_unit_id !== unit.data?.id) return [];
    if (Number(a.issued_quantity ?? 0) >= Number(a.quantity ?? 0)) return [];
    const holder = (holders.data ?? []).find((x) =>
      a.roster_entry_id
        ? x.roster_entry_id === a.roster_entry_id
        : x.holder_kind === "Pool" && x.engagement_id === a.holder_engagement_id,
    );
    return [
      {
        value: `${h.id}|${a.roster_entry_id ?? ""}`,
        label: `${holder?.holder_name ?? holder?.party_name ?? ""} · ${a.item_name ?? ""} (${a.issued_quantity ?? 0}/${a.quantity ?? 0})`,
      },
    ];
  });
}
