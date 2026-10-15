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
import { minorUnits } from "@/lib/assets/money";

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
      console.error("assets action failed", error);
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
    console.error("element search failed", result.error);
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
  const result = await createAssetUnit(ctx.viewer.db, { orgId: ctx.org.id, ...parsed.data });
  if (!result.ok) return errorKey(result.error);
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
      membershipId: optionalId,
      venueId: optionalId,
      projectId: optionalId,
      note: optionalText(1000),
      quantity: z
        .union([z.coerce.number().positive(), z.literal("")])
        .optional()
        .transform((v) => (typeof v === "number" ? v : null)),
    })
    .safeParse(
      fields(form, [
        "eventId",
        "code",
        "action",
        "membershipId",
        "venueId",
        "projectId",
        "note",
        "quantity",
      ]),
    );
  if (!parsed.success) {
    return { error: "invalid", field: String(parsed.error.issues[0]?.path[0] ?? "code") };
  }
  const result = await applyAssetScanEvent(ctx.viewer.db, { orgId: ctx.org.id, ...parsed.data });
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
