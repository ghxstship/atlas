/**
 * Automation handlers (A91, RRR-136; migrations 1480 and 1481; ADR 0047). Every call runs as the caller: the
 * definition RPCs check org.automations.write and the automations plan feature, row level security decides what the
 * runs ledger shows, and refusals come back as 422 with the rule. An automation's read shape carries its conditions
 * and actions documents, read for a whole page at once from their rows. handlers/platform.ts spreads them.
 */
import { postComment } from "@xos/data/comments";
import { requireOrg, type RequestContext } from "../../runtime/context.ts";
import { assertIfMatch } from "../../runtime/etag.ts";
import type { ErasedHandler } from "../../runtime/handler.ts";
import { created, noContent, ok } from "../../runtime/handler.ts";
import { from, keysOf, rpc, run, tableResource, unwrap, type Row } from "../support/table.ts";

interface ConditionRow {
  readonly id: string;
  readonly automation_id: string;
  readonly parent_condition_id: string | null;
  readonly position: number;
  readonly group_match: string | null;
  readonly field: string | null;
  readonly operator: string | null;
  readonly value_text: string | null;
}

interface ActionRow {
  readonly automation_id: string;
  readonly position: number;
  readonly action_type: string;
  readonly title_template: string | null;
  readonly body_template: string | null;
  readonly project_id: string | null;
  readonly phase_code: string | null;
  readonly xyz: string | null;
  readonly due_in_days: number | null;
  readonly to_state: string | null;
  readonly assignee_person_id: string | null;
  readonly recipient_person_id: string | null;
  readonly webhook_endpoint_id: string | null;
}

const byPosition = (a: { position: number }, b: { position: number }) => a.position - b.position;

/** Drops null members, as the database's jsonb_strip_nulls does for the documents. */
function present(entries: Record<string, unknown>): Row {
  return Object.fromEntries(
    Object.entries(entries).filter(([, v]) => v !== null && v !== undefined),
  );
}

function conditionJson(c: ConditionRow): Row {
  return present({ field: c.field, operator: c.operator, value: c.value_text });
}

/** An automation's conditions document from its rows (the TypeScript side of private.automation_conditions_doc). */
export function conditionsDocument(match: string, rows: readonly ConditionRow[]): Row {
  const top = rows.filter((r) => r.parent_condition_id === null).sort(byPosition);
  return {
    [match]: top.map((c) =>
      c.group_match === null
        ? conditionJson(c)
        : {
            [c.group_match]: rows
              .filter((k) => k.parent_condition_id === c.id)
              .sort(byPosition)
              .map(conditionJson),
          },
    ),
  };
}

/** An automation's actions document from its rows (the TypeScript side of private.automation_actions_doc). */
export function actionsDocument(rows: readonly ActionRow[]): Row[] {
  return [...rows].sort(byPosition).map((a) => {
    switch (a.action_type) {
      case "create_task":
        return present({
          type: a.action_type,
          title: a.title_template,
          project_id: a.project_id,
          phase_code: a.phase_code,
          xyz: a.xyz,
          due_in_days: a.due_in_days,
        });
      case "update_status":
        return present({ type: a.action_type, to_state: a.to_state, note: a.body_template });
      case "assign":
        return present({ type: a.action_type, assignee_person_id: a.assignee_person_id });
      case "add_comment":
        return present({ type: a.action_type, body: a.body_template });
      case "notify":
        return present({
          type: a.action_type,
          recipient_person_id: a.recipient_person_id,
          title: a.title_template,
          body: a.body_template,
        });
      default:
        return present({ type: a.action_type, webhook_endpoint_id: a.webhook_endpoint_id });
    }
  });
}

/** Adds the conditions and actions documents to a page of automations, two reads per page. */
async function withDefinitions(rows: Row[], context: RequestContext): Promise<Row[]> {
  const ids = keysOf(rows, "id");
  if (ids.length === 0) return rows;
  const [conditions, actions] = await Promise.all([
    run<ConditionRow[]>(
      from(context.db, "automation_conditions")
        .select(
          "id, automation_id, parent_condition_id, position, group_match, field, operator, value_text",
        )
        .in("automation_id", ids)
        .is("deleted_at", null),
    ),
    run<ActionRow[]>(
      from(context.db, "automation_actions")
        .select(
          "automation_id, position, action_type, title_template, body_template, project_id, phase_code, xyz, due_in_days, to_state, assignee_person_id, recipient_person_id, webhook_endpoint_id",
        )
        .in("automation_id", ids)
        .is("deleted_at", null),
    ),
  ]);
  return rows.map((row) => ({
    ...row,
    conditions: conditionsDocument(
      String(row["condition_match"] ?? "all"),
      (conditions ?? []).filter((c) => c.automation_id === row["id"]),
    ),
    actions: actionsDocument((actions ?? []).filter((a) => a.automation_id === row["id"])),
  }));
}

const automations = tableResource("automations", {
  derived: ["conditions", "actions"],
  extraColumns: ["condition_match"],
  enrich: withDefinitions,
});
const automationRuns = tableResource("automationRuns", { verbs: ["list", "get"] });
const automationRunSteps = tableResource("automationRunSteps", { verbs: ["list", "get"] });
const comments = tableResource("comments", { verbs: ["get"] });

/** null keeps a stored value in app.save_automation; an empty description clears it. */
const keep = (value: unknown) => (value === undefined ? null : value);

export const automationHandlers: Readonly<Record<string, ErasedHandler>> = {
  ...automations.handlers,
  "automations.create": async (request, context) => {
    const body = (request.body ?? {}) as Row;
    const id = await run<string>(
      rpc(context.db, "save_automation", {
        p_org_id: requireOrg(context).id,
        p_automation_id: null,
        p_name: body["name"],
        p_description: body["description"] ?? "",
        p_trigger_event_type: body["trigger_event_type"],
        p_conditions: body["conditions"],
        p_actions: body["actions"],
        p_enabled: body["enabled"] ?? false,
      }),
    );
    return created(await automations.read(context, id));
  },
  "automations.update": async (request, context) => {
    const id = String(request.params["id"]);
    const body = (request.body ?? {}) as Row;
    const current = await automations.read(context, id);
    assertIfMatch(request.ifMatch ?? "*", current);
    await run(
      rpc(context.db, "save_automation", {
        p_org_id: requireOrg(context).id,
        p_automation_id: id,
        p_name: keep(body["name"]),
        p_description: body["description"] === undefined ? null : (body["description"] ?? ""),
        p_trigger_event_type: keep(body["trigger_event_type"]),
        p_conditions: keep(body["conditions"]),
        p_actions: keep(body["actions"]),
        p_enabled: keep(body["enabled"]),
        p_expected_updated_at: current["updated_at"],
      }),
    );
    return ok(await automations.read(context, id));
  },
  "automations.delete": async (request, context) => {
    const id = String(request.params["id"]);
    await automations.read(context, id, ["id"]);
    await run(rpc(context.db, "delete_automation", { p_automation_id: id }));
    return noContent();
  },
  "automations.test": async (request, context) => {
    const id = String(request.params["id"]);
    await automations.read(context, id, ["id"]);
    const body = (request.body ?? {}) as Row;
    return ok(
      await run(
        rpc(context.db, "test_automation", { p_automation_id: id, p_event: body["event"] }),
      ),
    );
  },

  ...automationRuns.handlers,
  "automationRuns.notify": async (request, context) => {
    const body = (request.body ?? {}) as Row;
    const id = await run<string | null>(
      rpc(context.db, "send_automation_notice", {
        p_run_id: String(request.params["id"]),
        p_recipient_person_id: body["recipient_person_id"],
        p_title: body["title"],
        p_body: body["body"] ?? null,
      }),
    );
    return created({ notification_id: id });
  },
  "automationRuns.deliverWebhook": async (request, context) => {
    const body = (request.body ?? {}) as Row;
    const id = await run<string>(
      rpc(context.db, "queue_automation_webhook", {
        p_run_id: String(request.params["id"]),
        p_webhook_endpoint_id: body["webhook_endpoint_id"],
      }),
    );
    return created({ webhook_delivery_id: id });
  },
  "automationRuns.retry": async (request, context) => {
    const id = String(request.params["id"]);
    await automationRuns.read(context, id, ["id"]);
    await run(rpc(context.db, "retry_automation_run", { p_run_id: id }));
    return ok(await automationRuns.read(context, id));
  },

  ...automationRunSteps.handlers,

  // Comments by subject: app.post_comment opens the main thread (or an anchor's) on first use.
  "comments.postOnSubject": async (request, context) => {
    const body = (request.body ?? {}) as Row;
    const id = unwrap(
      await postComment(context.db, {
        subject: { table: `app.${String(body["subject_table"])}`, id: String(body["subject_id"]) },
        body: String(body["body"]),
        ...(typeof body["anchor"] === "string" ? { anchor: body["anchor"] } : {}),
      }),
    );
    return created(await comments.read(context, id));
  },
};
