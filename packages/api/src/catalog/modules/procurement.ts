/**
 * Procurement operations beyond the frozen v1 catalog (additive only, Section 10.1), and the
 * corrections of frozen Procurement resources to the A03 and A16 schema (ADR 0023): migrations 0331
 * (RFQs, purchase orders, receipts, matches, catalog), 0491 (match results) and 0492 (submittals).
 */
import { z } from "@hono/zod-openapi";
import { fields } from "@xos/schemas";
import { defineAdditions } from "../additions.ts";
import { all, editShape, orNull, putActions, removeActions } from "../correct.ts";
import { itemAction, transition } from "../define.ts";
import { rfqSealedResponseCorrections } from "./parts/rfq-sealed-responses.ts";
import { procurementFieldHomes } from "./parts/playbook-field-homes.ts";

const SINCE = "1.0.0-draft.2";

const label = (values: readonly [string, ...string[]], description: string) =>
  z.enum(values).meta({ description, example: values[0] });

const reasonBody = (id: string, what: string) =>
  z
    .object({
      reason: z
        .string()
        .min(1)
        .max(500)
        .meta({ description: `Why ${what}.`, example: "Within budget." }),
    })
    .meta({ id, description: `Request to ${what}.` });

export const additions = defineAdditions("Procurement", {
  corrections: [
    {
      id: "rfq-number-and-deadline",
      since: SINCE,
      resources: ["rfqs"],
      change:
        "Adds the server-issued `rfq_number`; `deadline_at` becomes the optional `responses_due_at`; removes `urid`. `rfq_state` is Proposed, Issued, Closed, Awarded or Canceled and the transition example becomes Issued to Closed.",
      reason:
        "app.rfqs (0331) numbers RFQs from the project's display key sequence, names the deadline `responses_due_at` (nullable) and carries no URID; app.transition_rfq moves the enum app.rfq_state, closing unseals responses.",
      apply: all(
        editShape({
          remove: ["urid", "deadline_at"],
          add: {
            rfq_number: {
              schema: fields.int("Number from the project's display key sequence.", 3, 1),
            },
            responses_due_at: {
              schema: orNull(
                fields.instant("Deadline for responses; responses unseal when the RFQ closes."),
              ),
              create: "optional",
            },
            rfq_state: {
              schema: label(["Proposed", "Issued", "Closed", "Awarded", "Canceled"], "RFQ state."),
            },
          },
        }),
        putActions([transition("RFQ", ["Issued", "Closed"])]),
      ),
    },
    {
      id: "rfq-invitation-vendor",
      since: SINCE,
      resources: ["rfqInvitations"],
      change: "The invitee is `vendor_id` (a vendor of the same org), replacing `organization_id`.",
      reason: "app.rfq_invitations (0331) invites a vendor (NOT NULL), not an organization.",
      apply: editShape({
        remove: ["organization_id"],
        add: {
          vendor_id: {
            schema: fields.ref("invited vendor of the same org"),
            create: "required",
            update: false,
          },
        },
      }),
    },
    {
      id: "rfq-response-vendor-validity",
      since: SINCE,
      resources: ["rfqResponses"],
      change:
        "The responder is `vendor_id`, replacing `organization_id`; adds `valid_until`; removes `total` (sum the lines) and `rfqResponses.submit` (a response is submitted when it is created).",
      reason:
        "app.rfq_responses (0331) belongs to an invited vendor, is stamped `submitted_at` by the database on insert while the RFQ is Issued, and stores no total; responses are unreadable until the RFQ is Closed (sealed bids).",
      apply: all(
        editShape({
          remove: ["organization_id", "total"],
          add: {
            vendor_id: {
              schema: fields.ref("responding vendor; must have been invited"),
              create: "required",
              update: false,
            },
            valid_until: {
              schema: orNull(fields.date("Last day the quoted prices hold.")),
              create: "optional",
            },
          },
        }),
        removeActions("submit"),
      ),
    },
    {
      id: "rfq-response-line-currency-code",
      since: SINCE,
      resources: ["rfqResponseLines"],
      change:
        "`currency` becomes the required `currency_code`; adds the optional canon `element_id`.",
      reason:
        "app.rfq_response_lines (0331) names the column `currency_code` (NOT NULL) and may name a catalog element.",
      apply: editShape({
        rename: { currency: "currency_code" },
        requireOnCreate: ["currency_code"],
        add: {
          element_id: {
            schema: orNull(fields.code("Catalog element quoted.", "0000.01.01-XOS-001")),
            create: "optional",
          },
        },
      }),
    },
    {
      id: "purchase-order-columns",
      since: SINCE,
      resources: ["purchaseOrders"],
      change:
        "`currency` becomes the required, fixed `currency_code`; `po_number` is the integer from the project sequence; adds `rfq_response_id`; removes `total` (read app.purchase_order_totals) and `required_on`. Only `rfq_response_id` is updatable (project, vendor and currency are fixed; lines change through `poLines`). `po_state` is Proposed, Approved, Sent, Closed or Canceled, the transition example becomes Approved to Sent, and `purchaseOrders.approve` takes a reason.",
      reason:
        "app.purchase_orders (0331) stores `currency_code` NOT NULL and fixed, numbers orders as bigint from next_sequence, may come from an awarded RFQ response, and derives totals in a NULL-aware view; it has no required date. guard_purchase_order refuses any change to project, vendor or currency.",
      apply: all(
        editShape({
          rename: { currency: "currency_code" },
          remove: ["total", "required_on"],
          requireOnCreate: ["currency_code"],
          immutable: ["currency_code", "vendor_id"],
          add: {
            po_number: {
              schema: fields.int("Number from the project's display key sequence.", 7, 1),
            },
            rfq_response_id: {
              schema: orNull(fields.ref("awarded RFQ response the order comes from")),
              create: "optional",
            },
            po_state: {
              schema: label(
                ["Proposed", "Approved", "Sent", "Closed", "Canceled"],
                "Purchase order state.",
              ),
            },
          },
        }),
        putActions([
          transition("Purchase Order", ["Approved", "Sent"]),
          itemAction("approve", {
            summary: "Approve a purchase order",
            description:
              "Records an approval through app.approve_purchase_order: finance.po.approve on the project, never by the order's creator (sod_po_creator), fully priced, within spend authority. Above the dual threshold the order stays Proposed until a second approver approves; a refusal returns 422 and names the rule.",
            body: reasonBody("PurchaseOrderApproveRequest", "approve the order"),
          }),
        ]),
      ),
    },
    {
      id: "po-line-columns",
      since: SINCE,
      resources: ["poLines"],
      change:
        "`unit` becomes the nullable `unit_basis`; `budget_line_id` becomes nullable; adds `line_number` (assigned after the last line when omitted); removes `currency` (the order's `currency_code` applies).",
      reason:
        "app.po_lines (0331) names the unit column `unit_basis` (a canon unit alias, nullable), draws on a budget line only optionally, orders lines by `line_number` (NOT NULL) and prices in the order's currency.",
      apply: editShape({
        rename: { unit: "unit_basis" },
        remove: ["currency"],
        nullable: ["budget_line_id", "unit_basis"],
        add: {
          line_number: {
            schema: fields.int("Order of the line within the purchase order.", 1, 1),
            create: "optional",
          },
        },
      }),
    },
    {
      id: "po-change-order-columns",
      since: SINCE,
      resources: ["poChangeOrders"],
      change:
        "`amount_minor` becomes `amount_delta_minor` and `po_change_state` becomes `po_change_order_state` (Proposed, Approved, Rejected or Canceled); removes `currency` (the order's applies). Adds `poChangeOrders.reject`.",
      reason:
        "app.po_change_orders (0331) stores the signed delta (NULL while unpriced) in the order's currency; app.decide_po_change_order approves or rejects, never by the requester.",
      apply: all(
        editShape({
          rename: { amount_minor: "amount_delta_minor", po_change_state: "po_change_order_state" },
          remove: ["currency"],
          add: {
            po_change_order_state: {
              schema: label(
                ["Proposed", "Approved", "Rejected", "Canceled"],
                "PO change order state.",
              ),
            },
          },
        }),
        putActions(
          [
            itemAction("approve", {
              summary: "Approve a PO change order",
              description:
                "Approves a priced, Proposed PO change order through app.decide_po_change_order under spend authority. Its requester cannot approve it; a refusal returns 422 and names the rule.",
              body: reasonBody("PoChangeOrderApproveRequest", "approve the change"),
            }),
            itemAction("reject", {
              summary: "Reject a PO change order",
              description:
                "Rejects a Proposed PO change order through app.decide_po_change_order. Its requester cannot decide it; a refusal returns 422 and names the rule.",
              body: reasonBody("PoChangeOrderRejectRequest", "reject the change"),
            }),
          ],
          { reject: "finance.po.approve" },
        ),
      ),
    },
    {
      id: "goods-receipt-columns",
      since: SINCE,
      resources: ["goodsReceipts"],
      change:
        "`received_at` is optional on create (the database stamps now); `received_by` is set from the session and nullable; adds `note`; removes `dock_slot_id`.",
      reason:
        "app.goods_receipts (0331) defaults `received_at`, stamps the receiver from the session (nullable for platform rows), records a note and has no dock slot column.",
      apply: editShape({
        remove: ["dock_slot_id"],
        optionalOnCreate: ["received_at"],
        serverSet: ["received_by"],
        nullable: ["received_by"],
        add: {
          note: {
            schema: orNull(fields.longText("Condition or exceptions noted.", "Two cases dented.")),
            create: "optional",
          },
        },
      }),
    },
    {
      id: "invoice-match-results",
      since: SINCE,
      resources: ["invoiceMatches"],
      change:
        "`variance` becomes `variance_minor` (derived, null when either side is unpriced) beside the derived `matched`; adds `resolution_note`, `resolved_by` and `resolved_at`, and `invoiceMatches.resolve` to accept a mismatch.",
      reason:
        "app.invoice_matches (0331) stores the three references and the resolution; the variance and agreement are derived by app.invoice_match_results (0491). A mismatch is accepted only with a note by someone other than the matcher.",
      apply: all(
        editShape({
          remove: ["variance"],
          add: {
            variance_minor: {
              schema: fields.money("Invoice total minus value received at order prices.", 2000),
            },
            resolution_note: {
              schema: orNull(
                fields.longText("Why a mismatch was accepted.", "Freight surcharge agreed."),
              ),
            },
            resolved_by: { schema: orNull(fields.ref("person who accepted the mismatch")) },
            resolved_at: { schema: orNull(fields.instant("When the mismatch was accepted.")) },
          },
        }),
        putActions(
          [
            itemAction("resolve", {
              summary: "Accept an invoice mismatch",
              description:
                "Records why a mismatch is accepted. Only someone other than the person who recorded the match may accept it, once; a refusal returns 422 and names the rule.",
              body: z
                .object({
                  resolution_note: z.string().min(1).max(1000).meta({
                    description: "Why the difference is accepted.",
                    example: "Freight surcharge agreed by phone.",
                  }),
                })
                .meta({
                  id: "InvoiceMatchResolveRequest",
                  description: "Request to accept a mismatch.",
                }),
            }),
          ],
          { resolve: "procurement.invoice_match.write" },
        ),
      ),
    },
    {
      id: "catalog-binding-columns",
      since: SINCE,
      resources: ["catalogBindings"],
      change:
        "Adds the server-issued `item_id`, the required `name`, `unit_basis`, `default_unit_price_minor` and `currency_code`; removes `tenant_item_code` and `confirmed_by`. `element_id` is fixed after create.",
      reason:
        "app.catalog_bindings (0331) issues {URID}-{ORG}-{SEQ} item IDs, requires a name, carries a default price (NULL is unpriced) with its currency, and records no confirmer.",
      apply: editShape({
        remove: ["tenant_item_code", "confirmed_by"],
        immutable: ["element_id"],
        add: {
          item_id: {
            schema: fields.code(
              "Item ID {URID}-{ORG}-{SEQ}, issued by the database.",
              "0000.01.01-NORTHW-001",
            ),
          },
          name: {
            schema: fields.text("Name the org uses for the item.", "4x8 Stage Deck"),
            create: "required",
          },
          unit_basis: {
            schema: orNull(fields.code("Unit the item is bought in.", "ea")),
            create: "optional",
          },
          default_unit_price_minor: {
            schema: fields.money("Default unit price.", 4500),
            create: "optional",
          },
          currency_code: {
            schema: orNull(fields.currency("ISO 4217 currency of the default price.")),
            create: "optional",
          },
        },
      }),
    },
    {
      id: "vendor-product-columns",
      since: SINCE,
      resources: ["vendorProducts"],
      change:
        "Adds the required `vendor_sku`, `catalog_binding_id` and `lead_time_days`; `currency` becomes the nullable `currency_code`; removes `name`.",
      reason:
        "app.vendor_products (0331) identifies a product by the vendor's SKU (NOT NULL), may fulfill a catalog item, records lead time, and names the price currency `currency_code` (required only with a price).",
      apply: editShape({
        rename: { currency: "currency_code" },
        remove: ["name"],
        nullable: ["currency_code"],
        add: {
          vendor_sku: {
            schema: fields.text("The vendor's product identifier.", "DSS-DECK-0408", 100),
            create: "required",
          },
          catalog_binding_id: {
            schema: orNull(fields.ref("catalog item the product fulfills")),
            create: "optional",
          },
          lead_time_days: {
            schema: orNull(fields.int("Days from order to delivery.", 14)),
            create: "optional",
          },
        },
      }),
    },
    ...rfqSealedResponseCorrections,
    ...procurementFieldHomes,
  ],
});
