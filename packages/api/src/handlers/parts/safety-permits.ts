/**
 * The permit engine and inspections part of the Safety handlers (A09). handlers/safety.ts spreads
 * them beside A14's incident handlers. Every call runs as the caller; the RPCs of 0353, 0420 and 0421
 * decide and their refusals come back as 422 with the rule (an unpopulated jurisdiction is
 * `jurisdiction_no_answer`, never a pass). Canon permit facts (permit, authority, jurisdiction,
 * trigger, lead time) are read from xpms.dim_permit_rule and never stored or computed.
 */
import { conflict, notFound } from "../../problem.ts";
import type { RequestContext } from "../../runtime/context.ts";
import { created, ok, type HandlerSet } from "../../runtime/handler.ts";
import type { ListQuery } from "../../runtime/listing.ts";
import {
  from,
  handlersFor,
  rpc,
  run,
  tableHandlers,
  tableResource,
  type Row,
} from "../support/table.ts";

// Permit requirements -------------------------------------------------------------------------------

interface CanonRule {
  rule: string;
  permit: string;
  ahj: string;
  lead_time: string;
  trigger_type: string;
  jurisdiction_id: string;
}

const permitRequirements = tableResource("permitRequirements", {
  aliases: { rule: "permit_rule" },
  derived: ["jurisdiction_id", "permit", "ahj", "lead_time", "trigger_type", "permit_state"],
  extraColumns: ["permit_rule", "record_id"],
  sortable: ["project_id", "rule", "record_id", "created_at"],
  toContract: async (row, context) => {
    const ruleName = String(row["rule"] ?? row["permit_rule"]);
    const [canon, record] = await Promise.all([
      run<CanonRule | null>(
        from(context.db, "dim_permit_rule", "xpms")
          .select("rule, permit, ahj, lead_time, trigger_type, jurisdiction_id")
          .eq("rule", ruleName)
          .maybeSingle(),
      ),
      row["record_id"]
        ? run<{ record_state: string } | null>(
            from(context.db, "records")
              .select("record_state")
              .eq("id", row["record_id"])
              .maybeSingle(),
          )
        : Promise.resolve(null),
    ]);
    return {
      ...row,
      rule: ruleName,
      jurisdiction_id: canon?.jurisdiction_id ?? null,
      permit: canon?.permit ?? null,
      ahj: canon?.ahj ?? null,
      lead_time: canon?.lead_time ?? null,
      trigger_type: canon?.trigger_type ?? null,
      permit_state: record?.record_state ?? null,
    };
  },
});

async function requirementRecord(context: RequestContext, id: string): Promise<Row> {
  const current = await permitRequirements.read(context, id);
  return current;
}

// Inspections ------------------------------------------------------------------------------------------

const inspections = tableResource("inspections");
const inspectionResults = tableResource("inspectionResults");

async function recordResult(context: RequestContext, body: Row, current?: Row): Promise<string> {
  return run<string>(
    rpc(context.db, "record_inspection_result", {
      p_inspection_id: current?.["inspection_id"] ?? body["inspection_id"],
      p_item_id: current?.["inspection_item_id"] ?? body["inspection_item_id"],
      p_result_enum_id: body["result_enum_id"] ?? current?.["result_enum_id"],
      p_note: body["note"] === undefined ? (current?.["note"] ?? null) : body["note"],
      p_photo_uri: body["photo_uri"] ?? null,
    }),
  );
}

export const permitHandlers: HandlerSet<"Safety"> = {
  ...tableHandlers("Safety", "inspectionTemplates"),
  ...tableHandlers("Safety", "inspectionItems"),

  ...handlersFor("Safety", inspections),
  "inspections.create": async ({ body }, context) => {
    const id = await run<string>(
      rpc(context.db, "start_inspection", {
        p_project_id: body.project_id,
        p_template_id: body.inspection_template_id,
        p_inspected_at: (body as Row)["inspected_at"] ?? null,
      }),
    );
    const recordId = (body as Row)["record_id"];
    if (typeof recordId === "string") {
      await run(
        from(context.db, "inspections").update({ record_id: recordId }).eq("id", id).select("id"),
      );
    }
    return created((await inspections.read(context, id)) as never);
  },
  "inspections.signOff": async ({ params }, context) => {
    await inspections.read(context, String(params.id), ["id"]);
    await run(rpc(context.db, "sign_off_inspection", { p_inspection_id: params.id }));
    return ok((await inspections.read(context, String(params.id))) as never);
  },

  ...handlersFor("Safety", inspectionResults),
  "inspectionResults.create": async ({ body }, context) => {
    const id = await recordResult(context, body as Row);
    return created((await inspectionResults.read(context, id)) as never);
  },
  "inspectionResults.update": async ({ params, body }, context) => {
    const current = await inspectionResults.read(context, String(params.id));
    const id = await recordResult(context, body as Row, current);
    return ok((await inspectionResults.read(context, id)) as never);
  },

  ...handlersFor("Safety", permitRequirements),
  "permitRequirements.generate": async ({ body, query }, context) => {
    await run(rpc(context.db, "generate_permit_requirements", { p_project_id: body.project_id }));
    const page = await permitRequirements.list(context, {
      ...(query as ListQuery),
      filter: { ...((query as ListQuery).filter ?? {}), project_id: { eq: body.project_id } },
    } as ListQuery);
    return ok(page as never);
  },
  "permitRequirements.track": async ({ params, body }, context) => {
    await requirementRecord(context, String(params.id));
    await run(
      rpc(context.db, "track_permit_requirement", {
        p_requirement_id: params.id,
        p_title: (body as Row | undefined)?.["title"] ?? null,
      }),
    );
    return ok((await permitRequirements.read(context, String(params.id))) as never);
  },
  "permitRequirements.transition": async ({ params, body }, context) => {
    const current = await requirementRecord(context, String(params.id));
    if (current["record_id"] === null) {
      throw conflict("No Permit record tracks this requirement yet; track it first.");
    }
    if (current["permit_state"] !== body.expected_state) {
      throw conflict(
        `The permit is ${String(current["permit_state"])}, not ${body.expected_state}; read it again.`,
      );
    }
    await run(
      rpc(context.db, "transition_record", {
        p_record_id: current["record_id"],
        p_expected: body.expected_state,
        p_next: body.to_state,
        p_reason: body.reason ?? "",
      }),
    );
    const after = await permitRequirements.read(context, String(params.id));
    if (after["permit_state"] === null) throw notFound();
    return ok(after as never);
  },
};
