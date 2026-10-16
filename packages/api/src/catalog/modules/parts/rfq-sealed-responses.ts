/**
 * Sealed RFQ responses (A33): `rfqResponses.create` records a response and its quoted lines through
 * app.record_rfq_response (A16, 0493), because a sealed response cannot be read back by the buyer who
 * records it until the RFQ closes. catalog/modules/procurement.ts spreads the correction into the
 * Procurement additions.
 */
import { z } from "@hono/zod-openapi";
import { fields } from "@xos/schemas";
import { all, editShape, putActions, removeVerbs } from "../../correct.ts";
import type { CorrectionInput } from "../../corrections.ts";
import { collectionAction } from "../../define.ts";
import type { ResourceSpec } from "../../types.ts";

const QuotedLine = z
  .object({
    description: fields.text("Line description.", "Line array, 12 boxes per side"),
    element_id: fields.code("Catalog element quoted.", "0000.01.01-XOS-001").optional(),
    quantity: fields.quantity("Quantity; 1 when omitted.", 2).optional(),
    unit_price_minor: fields.money("Unit price quoted.", 1800000),
  })
  .meta({ id: "RfqResponseQuotedLine", description: "A line quoted in an RFQ response." });

export const RfqResponseReceipt = z
  .object({
    rfq_response_id: fields.ref("recorded response"),
    rfq_id: fields.ref("RFQ"),
    vendor_id: fields.ref("responding vendor"),
    line_count: fields.int("Lines recorded.", 3, 1),
    sealed: fields.bool(
      "True while the RFQ is not Closed: the response stays unreadable until it closes.",
      true,
    ),
  })
  .meta({
    id: "RfqResponseReceipt",
    description: "A recorded RFQ response. The response itself stays sealed until the RFQ closes.",
  });

const createSealed = (spec: ResourceSpec): ResourceSpec => {
  const body = spec.def.create;
  if (body === undefined) throw new Error(`${spec.op} has no create body.`);
  return putActions([
    collectionAction("create", {
      segment: "",
      summary: "Record an RFQ response",
      description:
        "Records a sealed response and its quoted lines in one call (app.record_rfq_response) for a holder of procurement.rfq.write on the project. Only an invited vendor responds while the RFQ is Issued (rfq_not_invited, 422) and a response quotes at least one line (rfq_response_lines_required, 422). Answers 201 with a receipt: the response stays unreadable until the RFQ closes.",
      body,
      response: RfqResponseReceipt,
      rpc: "app.record_rfq_response",
      status: 201,
    }),
  ])(removeVerbs("create")(spec));
};

export const rfqSealedResponseCorrections: readonly CorrectionInput[] = [
  {
    id: "rfq-response-record-sealed",
    since: "1.0.0-draft.2",
    resources: ["rfqResponses"],
    components: ["schemas/RfqResponseReceipt", "schemas/RfqResponseQuotedLine"],
    change:
      "RfqResponseCreate takes the write-only `currency_code` and `lines` (at least one RfqResponseQuotedLine); `rfqResponses.create` answers 201 with RfqResponseReceipt instead of the RfqResponse read shape.",
    reason:
      "Responses stay unreadable until the RFQ is Closed (0331), so the buyer recording a quote cannot read the new row back and the line policy refuses its lines; app.record_rfq_response (0493) records the response and its lines atomically and returns only the id.",
    apply: all(
      editShape({
        add: {
          currency_code: {
            schema: fields.currency("ISO 4217 currency of every quoted line."),
            create: "required",
            update: false,
            read: false,
          },
          lines: {
            schema: z.array(QuotedLine).min(1).meta({ description: "Lines quoted, at least one." }),
            create: "required",
            update: false,
            read: false,
          },
        },
      }),
      createSealed,
    ),
  },
];
