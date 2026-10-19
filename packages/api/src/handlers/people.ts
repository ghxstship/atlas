/**
 * People handlers (A13 schema, A50 handlers). Role assignments, requisitions and agreements are the
 * People tables of migration 0361, read and written as the caller in the shapes corrected in
 * catalog/modules/people.ts (ADR 0023), so row level security and the guards decide every refusal:
 * a requisition's terms lock once it leaves Proposed and an agreement's text once it is sent.
 * Requisitions move through app.transition_requisition and app.approve_requisition (spend authority
 * and separation of duties, Section 8.1); an agreement is signed through app.sign_agreement by the
 * person it names. Offer handlers are a separate block owned by the offers agent.
 */
import { approveRequisition, transitionRequisition, type RequisitionState } from "@xos/data/people";
import { conflict, refused } from "../problem.ts";
import { defineHandlers, ok } from "../runtime/handler.ts";
import type { HandlerSet } from "../runtime/handler.ts";
import { offerHandlers } from "./people/offers.ts";
import { rpc, run, tableResource, unwrap } from "./support/table.ts";
import type { Row } from "./support/table.ts";

const roleAssignments = tableResource("roleAssignments");
const requisitions = tableResource("requisitions");
const agreements = tableResource("agreements");

function expectState(current: Row, column: string, expected: string, label: string): void {
  if (current[column] !== expected) {
    throw conflict(
      `The ${label} is ${String(current[column])}, not ${expected}; read it again before changing it.`,
    );
  }
}

const tables = {
  ...roleAssignments.handlers,
  ...requisitions.handlers,
  ...agreements.handlers,
} as unknown as HandlerSet<"People">;

export const handlers = defineHandlers("People", {
  ...tables,

  // Requisitions: compare-and-set transitions; approval under spend authority (two approvers above
  // the dual threshold leave it Proposed until the second approves).
  "requisitions.transition": async ({ params, body }, context) => {
    const current = await requisitions.read(context, params.id, ["id", "requisition_state"]);
    expectState(current, "requisition_state", body.expected_state, "requisition");
    unwrap(
      await transitionRequisition(
        context.db,
        params.id,
        body.expected_state as RequisitionState,
        body.to_state as RequisitionState,
        body.reason ?? "",
      ),
    );
    return ok((await requisitions.read(context, params.id)) as never);
  },

  "requisitions.approve": async ({ params }, context) => {
    await requisitions.read(context, params.id, ["id"]);
    unwrap(await approveRequisition(context.db, params.id, ""));
    return ok((await requisitions.read(context, params.id)) as never);
  },

  // Agreements: the named person signs with their typed name and the hash of the text they read.
  "agreements.sign": async ({ params, body }, context) => {
    await agreements.read(context, params.id, ["id"]);
    const signed = await run<boolean>(
      rpc(context.db, "sign_agreement", {
        p_agreement_id: params.id,
        p_signed_name: body.signed_name.trim(),
        p_body_sha256: body.body_sha256,
      }),
    );
    if (signed !== true) {
      throw refused(
        "REFUSE",
        "The agreement is not waiting for your signature, or its text changed since you read it.",
        "agreement_not_signable",
      );
    }
    return ok((await agreements.read(context, params.id)) as never);
  },

  // Offers (A04P): a separate block; see ./people/offers.ts.
  ...offerHandlers,
});
