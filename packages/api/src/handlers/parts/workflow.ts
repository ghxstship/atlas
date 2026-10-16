/**
 * Platform workflow handlers (A33, migrations 1030 to 1034): approval policies and their steps,
 * approvals and their decisions, Trash, templates with their versions, items and applications, and
 * org state labels. handlers/platform.ts spreads them. Every call runs as the caller: row level
 * security and the RPCs decide, and refusals come back as 422 with the rule. Shapes follow the
 * corrections in catalog/modules/parts/workflow.ts (ADR 0023).
 */
import { refused } from "../../problem.ts";
import { requireOrg } from "../../runtime/context.ts";
import type { ErasedHandler } from "../../runtime/handler.ts";
import { created, ok } from "../../runtime/handler.ts";
import { rpc, run, tableResource, type Row } from "../support/table.ts";

const approvalPolicies = tableResource("approvalPolicies");
const approvalSteps = tableResource("approvalSteps", { orgColumn: false });
const approvalInstances = tableResource("approvalInstances", { verbs: ["list", "get"] });
const approvalDecisions = tableResource("approvalDecisions", {
  verbs: ["list", "get"],
  softDelete: false,
});
const trashItems = tableResource("trashItems", { softDelete: false, key: "subject_urn" });
const templates = tableResource("templates");
const templateVersions = tableResource("templateVersions", { orgColumn: false });
const templateItems = tableResource("templateItems", { orgColumn: false });
const templateApplications = tableResource("templateApplications", {
  verbs: ["list", "get"],
  softDelete: false,
});
const orgStateLabels = tableResource("orgStateLabels");

const URN =
  /^urn:xpms:([a-z][a-z0-9_]*):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** Splits urn:xpms:{table}:{id}, refusing anything else. */
export function parseTrashUrn(urn: unknown): { table: string; id: string } {
  const match = typeof urn === "string" ? URN.exec(urn) : null;
  if (match === null) {
    throw refused(
      "REFUSE",
      "A Trash item is named urn:xpms:{table}:{id}, as trashItems.list returns it.",
      "trash_urn_format",
    );
  }
  return { table: match[1] as string, id: match[2] as string };
}

export const workflowHandlers: Readonly<Record<string, ErasedHandler>> = {
  ...approvalPolicies.handlers,
  "approvalPolicies.transition": async (request, context) => {
    const id = String(request.params["id"]);
    const body = (request.body ?? {}) as Row;
    await approvalPolicies.read(context, id, ["id"]);
    await run(
      rpc(context.db, "transition_approval_policy", {
        p_approval_policy_id: id,
        p_expected: body["expected_state"],
        p_next: body["to_state"],
        p_reason: body["reason"] ?? `Moved to ${String(body["to_state"])} through the API.`,
      }),
    );
    return ok(await approvalPolicies.read(context, id));
  },
  ...approvalSteps.handlers,

  ...approvalInstances.handlers,
  // The amount, currency, project and policy come from the document (app.request_approval).
  "approvalInstances.create": async (request, context) => {
    const body = (request.body ?? {}) as Row;
    const id = await run<string>(
      rpc(context.db, "request_approval", {
        p_document_type: body["document_type"],
        p_document_id: body["document_id"],
      }),
    );
    return created(await approvalInstances.read(context, id));
  },
  "approvalInstances.cancel": async (request, context) => {
    const id = String(request.params["id"]);
    const body = (request.body ?? {}) as Row;
    await approvalInstances.read(context, id, ["id"]);
    await run(
      rpc(context.db, "cancel_approval", { p_approval_instance_id: id, p_reason: body["reason"] }),
    );
    return ok(await approvalInstances.read(context, id));
  },

  ...approvalDecisions.handlers,
  "approvalDecisions.create": async (request, context) => {
    const body = (request.body ?? {}) as Row;
    const id = await run<string>(
      rpc(context.db, "decide_approval", {
        p_approval_instance_id: body["approval_instance_id"],
        p_approved: body["approved"],
        p_comment: body["comment"] ?? null,
      }),
    );
    return created(await approvalDecisions.read(context, id));
  },

  ...trashItems.handlers,
  "trashItems.restore": async (request, context) => {
    const body = (request.body ?? {}) as Row;
    const { table, id } = parseTrashUrn(body["subject_urn"]);
    const restored = await run<number>(
      rpc(context.db, "restore_trash_item", { p_subject_table: table, p_subject_id: id }),
    );
    return ok({
      subject_urn: `urn:xpms:${table}:${id}`,
      subject_table: table,
      subject_id: id,
      rows_restored: restored,
    });
  },

  ...templates.handlers,
  "templates.createFromProject": async (request, context) => {
    const body = (request.body ?? {}) as Row;
    const id = await run<string>(
      rpc(context.db, "create_template_from_project", {
        p_project_id: body["project_id"],
        p_name: body["name"],
        p_description: body["description"] ?? null,
      }),
    );
    return created(await templates.read(context, id));
  },
  ...templateVersions.handlers,
  "templateVersions.publish": async (request, context) => {
    const id = String(request.params["id"]);
    await templateVersions.read(context, id, ["id"]);
    await run(rpc(context.db, "publish_template_version", { p_template_version_id: id }));
    return ok(await templateVersions.read(context, id));
  },
  ...templateItems.handlers,
  ...templateApplications.handlers,
  // Creates the project from the template's current version, as the caller (app.apply_template).
  "templateApplications.create": async (request, context) => {
    requireOrg(context);
    const body = (request.body ?? {}) as Row;
    const id = await run<string>(
      rpc(context.db, "apply_template", {
        p_template_id: body["template_id"],
        p_project_key: body["project_key"],
        p_name: body["name"],
        p_time_zone: body["time_zone"] ?? null,
        p_starts_on: body["starts_on"] ?? null,
        p_venue_id: body["venue_id"] ?? null,
      }),
    );
    return created(await templateApplications.read(context, id));
  },

  ...orgStateLabels.handlers,
};
