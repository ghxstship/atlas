import type { XosClient } from "./client.ts";
import { callRpc, writeResult } from "./places.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * The signage register (G-24, migrations 2904 and 2905, ADR 0140 D6 and D7). A sign records what it says, its size
 * and material, where it goes (a pin on a site plan of its project, or words), its printer, artwork and an optional
 * purchase order line. Its production state is computed in app.sign_production from the sign's own marks and
 * procurement's rows, never stored; the marks change only through app.mark_sign_step. Signs read with places.venue.read
 * and write with places.site_plan.write; order lines are listed only to procurement readers, through their own policy.
 */

export type SignType =
  | "Directional"
  | "Identification"
  | "Regulatory"
  | "Informational"
  | "Sponsor"
  | "Menu"
  | "Digital";

export const SIGN_TYPES: readonly SignType[] = [
  "Directional",
  "Identification",
  "Regulatory",
  "Informational",
  "Sponsor",
  "Menu",
  "Digital",
];

export type SignStep = "Ordered" | "Printed" | "Placed";
export type SignProductionState = "To Order" | "Ordered" | "Printed" | "Placed";

export const SIGN_PRODUCTION_STATES: readonly SignProductionState[] = [
  "To Order",
  "Ordered",
  "Printed",
  "Placed",
];

/** The signage categories of canon a sign may key to (signs_urid_signage). */
export type SignUrid = "4000.05.01" | "4000.05.02" | "9000.09.01";

/** The category a new sign takes from its type (ADR 0140): Digital Signage, Directional Signage, else Signage Panels. */
export function defaultSignUrid(type: SignType): SignUrid {
  if (type === "Digital") return "9000.09.01";
  if (type === "Directional") return "4000.05.02";
  return "4000.05.01";
}

export interface Sign {
  readonly id: string;
  readonly projectId: string;
  /** {project_key}-SGN-{n}. */
  readonly key: string;
  readonly number: number;
  readonly title: string;
  readonly type: SignType;
  readonly urid: string | null;
  readonly message: string | null;
  readonly quantity: number;
  readonly widthIn: number | null;
  readonly heightIn: number | null;
  readonly substrate: string | null;
  readonly doubleSided: boolean;
  readonly sitePlanPinId: string | null;
  readonly locationText: string | null;
  readonly printerVendorId: string | null;
  readonly poLineId: string | null;
  readonly artworkVersionId: string | null;
  readonly neededBy: string | null;
  readonly orderedAt: string | null;
  readonly printedAt: string | null;
  readonly placedAt: string | null;
  readonly placedBy: string | null;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  /** Computed (app.sign_production); To Order when the view has no row, for example in Trash. */
  readonly state: SignProductionState;
  readonly orderedViaPo: boolean;
  readonly received: boolean;
  readonly located: boolean;
  readonly overdue: boolean;
}

interface SignRow {
  id: string;
  project_id: string;
  sign_number: number;
  title: string;
  sign_type: SignType;
  urid: string | null;
  message: string | null;
  quantity: number;
  width_in: number | string | null;
  height_in: number | string | null;
  substrate: string | null;
  double_sided: boolean;
  site_plan_pin_id: string | null;
  location_text: string | null;
  printer_vendor_id: string | null;
  po_line_id: string | null;
  artwork_version_id: string | null;
  needed_by: string | null;
  ordered_at: string | null;
  printed_at: string | null;
  placed_at: string | null;
  placed_by: string | null;
  updated_at: string;
  deleted_at: string | null;
  project: { project_key: string } | null;
}

interface ProductionRow {
  sign_id: string;
  production_state: SignProductionState;
  ordered_via_po: boolean;
  received: boolean;
  located: boolean;
  overdue: boolean;
}

const SIGN_COLUMNS =
  "id, project_id, sign_number, title, sign_type, urid, message, quantity, width_in, height_in, substrate, double_sided, site_plan_pin_id, location_text, printer_vendor_id, po_line_id, artwork_version_id, needed_by, ordered_at, printed_at, placed_at, placed_by, updated_at, deleted_at, project:projects(project_key)";

const num = (v: number | string | null): number | null => (v === null ? null : Number(v));

function toSign(row: SignRow, production: ProductionRow | undefined): Sign {
  return {
    id: row.id,
    projectId: row.project_id,
    key: `${row.project?.project_key ?? ""}-SGN-${row.sign_number}`,
    number: row.sign_number,
    title: row.title,
    type: row.sign_type,
    urid: row.urid,
    message: row.message,
    quantity: row.quantity,
    widthIn: num(row.width_in),
    heightIn: num(row.height_in),
    substrate: row.substrate,
    doubleSided: row.double_sided,
    sitePlanPinId: row.site_plan_pin_id,
    locationText: row.location_text,
    printerVendorId: row.printer_vendor_id,
    poLineId: row.po_line_id,
    artworkVersionId: row.artwork_version_id,
    neededBy: row.needed_by,
    orderedAt: row.ordered_at,
    printedAt: row.printed_at,
    placedAt: row.placed_at,
    placedBy: row.placed_by,
    updatedAt: row.updated_at,
    archivedAt: row.deleted_at,
    state: production?.production_state ?? "To Order",
    orderedViaPo: production?.ordered_via_po ?? row.po_line_id !== null,
    received: production?.received ?? false,
    located: production?.located ?? false,
    overdue: production?.overdue ?? false,
  };
}

async function withProduction(db: XosClient, rows: readonly SignRow[]): Promise<Result<Sign[]>> {
  if (rows.length === 0) return ok([]);
  const { data, error } = await db
    .from("sign_production")
    .select("sign_id, production_state, ordered_via_po, received, located, overdue")
    .in(
      "sign_id",
      rows.map((r) => r.id),
    );
  if (error) return fail(toDataError(error));
  const byId = new Map((data as unknown as ProductionRow[]).map((p) => [p.sign_id, p]));
  return ok(rows.map((r) => toSign(r, byId.get(r.id))));
}

/** Signs the caller can read, of one project or all, by key. Trash holds deleted signs. */
export async function listSigns(
  db: XosClient,
  filter: { readonly orgId: string; readonly projectId?: string },
): Promise<Result<Sign[]>> {
  let query = db
    .from("signs")
    .select(SIGN_COLUMNS)
    .eq("org_id", filter.orgId)
    .is("deleted_at", null);
  if (filter.projectId) query = query.eq("project_id", filter.projectId);
  const { data, error } = await query.order("project_id").order("sign_number");
  if (error) return fail(toDataError(error));
  return withProduction(db, data as unknown as SignRow[]);
}

export async function getSign(db: XosClient, id: string): Promise<Result<Sign>> {
  const { data, error } = await db.from("signs").select(SIGN_COLUMNS).eq("id", id).maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  const out = await withProduction(db, [data as unknown as SignRow]);
  return out.ok ? ok(out.data[0] as Sign) : out;
}

export interface SignInput {
  readonly projectId: string;
  readonly title: string;
  readonly type: SignType;
  readonly urid?: SignUrid | null;
  readonly message?: string | null;
  readonly quantity?: number;
  readonly widthIn?: number | null;
  readonly heightIn?: number | null;
  readonly substrate?: string | null;
  readonly doubleSided?: boolean;
  readonly sitePlanPinId?: string | null;
  readonly locationText?: string | null;
  readonly printerVendorId?: string | null;
  /** Set only by a procurement reader; omitted keeps the sign's line as it is. */
  readonly poLineId?: string | null;
  readonly neededBy?: string | null;
}

const blankToNull = (v: string | null | undefined) => {
  const t = v?.trim();
  return t ? t : null;
};

function signValues(input: Omit<SignInput, "projectId">): Record<string, unknown> {
  return {
    title: input.title.trim(),
    sign_type: input.type,
    urid: input.urid ?? defaultSignUrid(input.type),
    message: input.message?.trim() ? input.message : null,
    quantity: input.quantity ?? 1,
    width_in: input.widthIn ?? null,
    height_in: input.heightIn ?? null,
    substrate: blankToNull(input.substrate),
    double_sided: input.doubleSided ?? false,
    site_plan_pin_id: input.sitePlanPinId ?? null,
    location_text: blankToNull(input.locationText),
    // With an order line, the printer is the order's vendor (ADR 0140 D6), so the sign names none.
    printer_vendor_id: input.poLineId ? null : (input.printerVendorId ?? null),
    ...(input.poLineId === undefined ? {} : { po_line_id: input.poLineId }),
    needed_by: input.neededBy ?? null,
  };
}

export async function createSign(db: XosClient, input: SignInput): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("signs")
    .insert({ project_id: input.projectId, ...signValues(input) } as never)
    .select("id");
  return writeResult(data, error);
}

export async function updateSign(
  db: XosClient,
  id: string,
  input: Omit<SignInput, "projectId">,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("signs")
    .update(signValues(input) as never)
    .eq("id", id)
    .select("id");
  return writeResult(data, error);
}

/** Sets a sign's artwork to a Clean version of a file attached to the sign, or clears it. */
export async function setSignArtwork(
  db: XosClient,
  id: string,
  versionId: string | null,
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("signs")
    .update({ artwork_version_id: versionId } as never)
    .eq("id", id)
    .select("id");
  return writeResult(data, error);
}

/** Marks a production step with the database time, or undoes it (done false). */
export async function markSignStep(
  db: XosClient,
  input: { readonly id: string; readonly step: SignStep; readonly done?: boolean },
): Promise<Result<string>> {
  return callRpc<string>(db, "mark_sign_step", {
    p_sign_id: input.id,
    p_step: input.step,
    p_done: input.done ?? true,
  });
}

/** The step a sign's card offers next: the furthest step not reached, or none once placed. */
export function nextSignStep(sign: Pick<Sign, "state" | "orderedViaPo">): SignStep | null {
  if (sign.state === "Placed") return null;
  if (sign.state === "Printed") return "Placed";
  if (sign.state === "Ordered") return "Printed";
  return sign.orderedViaPo ? "Printed" : "Ordered";
}

export interface SignageSummary {
  readonly projectId: string;
  readonly toOrder: number;
  readonly ordered: number;
  readonly printed: number;
  readonly placed: number;
  readonly unplaced: number;
  readonly unlocated: number;
  readonly overdue: number;
}

/** Signage counts per project (app.project_signage_summary). */
export async function signageSummary(
  db: XosClient,
  filter: { readonly orgId: string; readonly projectId?: string },
): Promise<Result<SignageSummary[]>> {
  let query = db
    .from("project_signage_summary")
    .select("project_id, to_order, ordered, printed, placed, unplaced, unlocated, overdue")
    .eq("org_id", filter.orgId);
  if (filter.projectId) query = query.eq("project_id", filter.projectId);
  const { data, error } = await query;
  if (error) return fail(toDataError(error));
  return ok(
    (data as unknown as Record<string, string | number>[]).map((r) => ({
      projectId: String(r["project_id"]),
      toOrder: Number(r["to_order"]),
      ordered: Number(r["ordered"]),
      printed: Number(r["printed"]),
      placed: Number(r["placed"]),
      unplaced: Number(r["unplaced"]),
      unlocated: Number(r["unlocated"]),
      overdue: Number(r["overdue"]),
    })),
  );
}

/** One order line a procurement reader may link a sign to. */
export interface PoLineOption {
  readonly id: string;
  readonly purchaseOrderId: string;
  readonly poNumber: string;
  readonly lineNumber: number;
  readonly description: string;
  readonly vendorName: string | null;
}

/**
 * Lines of the project's orders that are not canceled, under procurement's own policy: a reader without
 * procurement.po.read gets none, so the picker never shows.
 */
export async function listPoLineOptions(
  db: XosClient,
  projectId: string,
): Promise<Result<PoLineOption[]>> {
  const { data, error } = await db
    .from("po_lines")
    .select(
      "id, purchase_order_id, line_number, description, order:purchase_orders!inner(po_number, po_state, project_id, deleted_at, vendor:vendors(counterparty:counterparties(counterparty_name)))",
    )
    .eq("order.project_id", projectId)
    .neq("order.po_state", "Canceled")
    .is("order.deleted_at", null)
    .is("deleted_at", null)
    .order("line_number");
  if (error) return fail(toDataError(error));
  type Row = {
    id: string;
    purchase_order_id: string;
    line_number: number;
    description: string;
    order: {
      po_number: string;
      vendor: { counterparty: { counterparty_name: string } | null } | null;
    } | null;
  };
  return ok(
    (data as unknown as Row[])
      .map((r) => ({
        id: r.id,
        purchaseOrderId: r.purchase_order_id,
        poNumber: r.order?.po_number ?? "",
        lineNumber: r.line_number,
        description: r.description,
        vendorName: r.order?.vendor?.counterparty?.counterparty_name ?? null,
      }))
      .sort((a, b) => a.poNumber.localeCompare(b.poNumber) || a.lineNumber - b.lineNumber),
  );
}
