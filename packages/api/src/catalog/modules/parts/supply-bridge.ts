/**
 * The supply bridge in the public API (R7a, RRR-183; migrations 2681 to 2683, ADR 0104). Procurement already owns
 * Ordered, Confirmed and Received; these operations add the links between them and stock, additively (v1 is frozen,
 * Section 10.1):
 *
 *   * `purchaseOrders.receive` records one receipt event through app.receive_goods: receipt lines and, per line,
 *     units by asset tag or a quantity into a lot at a venue. `purchaseOrders.returnGoods` records one return to the
 *     vendor through app.return_goods. Each request's `Idempotency-Key` replays the stored response; the handler mints
 *     a fresh event id on the first request.
 *   * `goodsReturns` and `returnLines` read what went back, as goods receipts read.
 *   * `poLineHireWarnings` and `poLines.hireWindowWarnings` read the delivery and return window warnings of rental
 *     lines (G-99); `assetUnitHire` reads which units are hired in and when they go back (G-96).
 *
 * The acquisition kind and hire period of an order line and a unit's receipt line enter the frozen `poLines` and
 * `assetUnits` through correction entries in the module files.
 */
import { z } from "@hono/zod-openapi";
import { defineResource, fields } from "@xos/schemas";
import { orNull } from "../../correct.ts";
import { collectionQuery, itemAction, resource } from "../../define.ts";
import type { ResourceSpec } from "../../types.ts";

const ACQUISITION_KINDS = ["Purchase", "Rental"] as const;
const RETURN_REASONS = ["Off Hire", "Defective", "Wrong Item", "Over Delivery"] as const;
export const HIRE_WARNINGS = [
  "Delivery After Load In",
  "Return Before Load Out",
  "Hire Beyond Site Window",
  "Delivery Docks Full",
  "Return Docks Full",
] as const;

export const acquisitionKind = (description: string) =>
  z.enum(ACQUISITION_KINDS).meta({ description, example: "Rental" });

const hireWarning = z
  .enum(HIRE_WARNINGS)
  .meta({ description: "The window rule the hire breaks.", example: "Delivery After Load In" });

const ids = (description: string) =>
  z.array(z.uuid()).meta({ description, example: ["0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f"] });

const outcome = z.enum(["applied", "duplicate"]).meta({
  description: "applied for a new event; duplicate when the event was already recorded.",
  example: "applied",
});

const note = (example: string) =>
  z.string().min(1).max(1000).nullable().optional().meta({ description: "Note.", example });

// Receiving ---------------------------------------------------------------------------------------------------------

const ReceiveLine = z
  .object({
    po_line_id: fields.ref("order line received"),
    quantity: z.number().positive().meta({ description: "Quantity received.", example: 2 }),
    asset_tags: z
      .array(z.string().min(1).max(100))
      .min(1)
      .optional()
      .meta({
        description:
          "One asset tag per unit received, for an element with an asset class: each unit comes in Received. Needs assets.asset.write.",
        example: ["NWL-RAD-101", "NWL-RAD-102"],
      }),
    venue_id: orNull(
      fields.ref("venue whose lot takes the quantity into stock; needs assets.asset.write"),
    ).optional(),
    condition_enum_id: orNull(
      fields.code(
        "Condition of the units: a row of the canon Asset Condition enumeration.",
        "ENM-017",
      ),
    ).optional(),
  })
  .meta({
    id: "PurchaseOrderReceiveLine",
    description: "One order line received: by asset tags, into a lot at a venue, or neither.",
  });

const ReceiveRequest = z
  .object({
    lines: z.array(ReceiveLine).min(1).meta({ description: "Lines received." }),
    note: note("Two cases dented."),
  })
  .meta({ id: "PurchaseOrderReceiveRequest", description: "One receipt event against an order." });

const ReceiveResult = z
  .object({
    outcome,
    goods_receipt_id: fields.uuid("The goods receipt recorded."),
    receipt_line_ids: ids("Its receipt lines."),
    asset_unit_ids: ids("Units that came in on them."),
    lot_movement_ids: ids("Receipt movements into lots."),
  })
  .meta({ id: "PurchaseOrderReceiveResult", description: "What one receipt event recorded." });

// Returning ---------------------------------------------------------------------------------------------------------

const ReturnLine = z
  .object({
    receipt_line_id: fields.ref("receipt line of the same order that brought the goods in"),
    quantity: z.number().positive().meta({ description: "Quantity returned.", example: 1 }),
    asset_unit_ids: ids(
      "The serialized units going back, one per unit, each received on that receipt line.",
    ).optional(),
    venue_id: orNull(fields.ref("venue whose lot the quantity leaves")).optional(),
  })
  .meta({
    id: "PurchaseOrderReturnLine",
    description:
      "Goods of one receipt line going back: units, a quantity out of a lot, or a quantity.",
  });

const ReturnRequest = z
  .object({
    reason: z.enum(RETURN_REASONS).meta({
      description: "Why the goods go back. Off Hire applies only to rental lines.",
      example: "Off Hire",
    }),
    lines: z.array(ReturnLine).min(1).meta({ description: "Lines returned." }),
    note: note("Collected by the vendor's driver."),
  })
  .meta({ id: "PurchaseOrderReturnRequest", description: "One return to the vendor." });

const ReturnResult = z
  .object({
    outcome,
    goods_return_id: fields.uuid("The goods return recorded."),
    return_line_ids: ids("Its return lines."),
  })
  .meta({ id: "PurchaseOrderReturnResult", description: "What one return event recorded." });

export const purchaseOrderSupplyActions = [
  itemAction("receive", {
    summary: "Receive goods against a purchase order",
    description:
      "Records one receipt event in one transaction (app.receive_goods): the goods receipt, a receipt line per entry and, for an element with an asset class, Received units by asset tag or a Receipt movement into the lot at a venue. Needs procurement.receipt.write on the project, and assets.asset.write to bring stock in. The order must be Approved or Sent, and receipts never exceed the quantity ordered (422 receipt_order_state, receipt_exceeds_order). A replay with the same Idempotency-Key returns the original response.",
    body: ReceiveRequest,
    response: ReceiveResult,
    rpc: "app.receive_goods",
  }),
  itemAction("returnGoods", {
    segment: "returns",
    summary: "Return goods to the vendor",
    description:
      "Records one return event in one transaction (app.return_goods): return lines against the receipt lines that brought the goods in, never more than they received (422 return_exceeds_receipt). Serialized units must be Available, Damaged or In Maintenance and checked in; they become Returned. A quantity out of a lot writes a Vendor Return movement. Off Hire applies only to rental lines (422 return_off_hire_not_rental). Needs procurement.receipt.write on the project. A replay with the same Idempotency-Key returns the original response.",
    body: ReturnRequest,
    response: ReturnResult,
    rpc: "app.return_goods",
  }),
];

// Window warnings for a hire being entered ----------------------------------------------------------------------------

export const poLineHireWindowQuery = collectionQuery("hireWindowWarnings", {
  summary: "Window warnings for a hire",
  description:
    "The delivery and return window warnings a rental line with this hire would raise on the project before it is saved (app.hire_window_warnings, G-99): the same rules as `poLineHireWarnings`. Warnings never refuse a line. Needs procurement.po.read on the project; a hire that does not end after it starts is refused (422 hire_period_order).",
  query: z.object({
    project_id: fields.ref("project the order is for"),
    from: fields.instant("When the hire starts."),
    to: fields.instant("When the hire ends."),
  }),
  response: z
    .object({ data: z.array(hireWarning).meta({ description: "Warnings, in rule order." }) })
    .meta({ id: "HireWindowWarnings", description: "Window warnings for a hire." }),
  rpc: "app.hire_window_warnings",
});

// Read-only resources -----------------------------------------------------------------------------------------------

const GoodsReturn = defineResource({
  name: "GoodsReturn",
  table: "app.goods_returns",
  description:
    "Goods sent back to the vendor against a purchase order: a rental at off-hire, or bought goods that were defective, the wrong item or more than ordered. Recorded by `purchaseOrders.returnGoods`.",
  fields: {
    purchase_order_id: fields.ref("purchase order the goods were received on"),
    returned_at: fields.instant("When the goods went back."),
    returned_by: orNull(fields.ref("person who returned the goods")),
    return_reason: z
      .enum(RETURN_REASONS)
      .meta({ description: "Why the goods went back.", example: "Off Hire" }),
    note: orNull(fields.longText("Condition or carrier noted at the return.", "Collected.")),
  },
});

const ReturnLineRow = defineResource({
  name: "ReturnLine",
  table: "app.return_lines",
  description:
    "What went back in a goods return, per receipt line: one row per serialized unit, or a quantity.",
  fields: {
    goods_return_id: fields.ref("goods return"),
    receipt_line_id: fields.ref("receipt line that brought the goods in"),
    asset_unit_id: orNull(fields.ref("serialized unit returned")),
    quantity_returned: fields.quantity("Quantity returned; 1 for a unit.", 1),
  },
});

const PoLineHireWarning = defineResource({
  name: "PoLineHireWarning",
  table: "app.po_line_hire_warnings",
  base: "view",
  description:
    "A delivery or return window conflict of a live rental line (G-99), one row per warning: the hire against the project's site window (its Build and Strike records, else its dates) and its docks. Computed, never stored; warnings never refuse a line.",
  fields: {
    po_line_id: fields.ref("rental order line"),
    project_id: fields.ref("project of the order"),
    purchase_order_id: fields.ref("purchase order"),
    hire_starts_at: fields.instant("When the hire starts."),
    hire_ends_at: fields.instant("When the hire ends."),
    site_opens_at: orNull(fields.instant("When the site window opens; null when nothing sets it.")),
    site_closes_at: orNull(
      fields.instant("When the site window closes; null when nothing sets it."),
    ),
    warning: hireWarning,
  },
});

const AssetUnitHire = defineResource({
  name: "AssetUnitHire",
  table: "app.asset_unit_hire",
  base: "view",
  description:
    "Whether a unit is hired in and when it goes back (G-96). Readable with assets.asset.read alone: it carries no vendor, cost or order.",
  fields: {
    asset_unit_id: fields.ref("asset unit"),
    acquisition_kind: acquisitionKind(
      "Rental when the unit arrived on a rental order line; Purchase otherwise.",
    ),
    hire_ends_at: orNull(fields.instant("Rental units: when the hire ends.")),
    off_hire_due: fields.bool(
      "True for a rental unit whose hire has ended and which has not been Returned.",
      false,
    ),
  },
});

export const procurementSupplyResources: readonly ResourceSpec[] = [
  resource("Procurement", "/goods-returns", GoodsReturn, {
    verbs: ["list", "get"],
    order: { by: ["returned_at"], numeric: false, descending: true },
  }),
  resource("Procurement", "/return-lines", ReturnLineRow, { verbs: ["list", "get"] }),
  resource("Procurement", "/po-line-hire-warnings", PoLineHireWarning, {
    verbs: ["list"],
    label: "hire warning",
    order: { by: ["po_line_id"], numeric: false },
  }),
];

export const assetSupplyResources: readonly ResourceSpec[] = [
  resource("Assets", "/asset-unit-hire", AssetUnitHire, {
    verbs: ["list"],
    op: "assetUnitHire",
    label: "unit hire",
    order: { by: ["asset_unit_id"], numeric: false },
  }),
];
