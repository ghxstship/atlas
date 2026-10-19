/**
 * Projects handlers (A07, A04P): projects, the scope tree, gate readiness and passage, the gate
 * history and gate evidence. Every read runs as the caller, so row level security decides
 * (invariant 2); every state change goes through the lifecycle and gate RPCs, whose refusals come
 * back as 422 with the rule. Projects are archived, never deleted (ADR 0023,
 * project-archive-not-delete); evidence is withdrawn by soft delete and never edited.
 */
import type { DataError, XosClient } from "@xos/data";
import {
  createProject,
  createScopeNode,
  passGate,
  removeScopeNode,
  setProjectArchived,
  transitionProject,
} from "@xos/data/projects";
import type { Components } from "../contract/operations.generated.ts";
import { conflict, notFound, preconditionFailed, refused } from "../problem.ts";
import { versionFromIfMatch } from "../runtime/etag.ts";
import { created, defineHandlers, noContent, ok } from "../runtime/handler.ts";
import { listPage } from "../runtime/listing.ts";
import { selectColumns } from "../runtime/pagination.ts";
import { requireOrg } from "../runtime/context.ts";
import { tableHandlers } from "./support/table.ts";

type Project = Components["Project"];
type ScopeNode = Components["ScopeNode"];
type PhaseTransition = Components["ProjectPhaseTransition"];

const BASE = ["id", "org_id", "created_at", "created_by", "updated_at", "updated_by"] as const;

export const PROJECT_COLUMNS = [
  ...BASE,
  "project_key",
  "name",
  "description",
  "workspace_id",
  "jurisdiction_id",
  "region_code",
  "tier_code",
  "current_phase_code",
  "project_state",
  "currency",
  "starts_on",
  "ends_on",
  "time_zone",
  "venue_id",
  "client_counterparty_id",
  "production_state",
  "archived_at",
  "anchor_on",
  "budget_envelope_minor",
] as const;

const SCOPE_NODE_COLUMNS = [
  ...BASE,
  "project_id",
  "parent_id",
  "scope_code",
  "name",
  "node_kind",
  "path",
] as const;

const PHASE_TRANSITION_COLUMNS = [
  ...BASE,
  "project_id",
  "from_phase_code",
  "to_phase_code",
  "transitioned_at",
  "transitioned_by",
] as const;

// Support ------------------------------------------------------------------------------------------

type Builder = Record<string, unknown>;

/** Filter and order methods whose first argument names a column. */
const COLUMN_METHODS = new Set([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "like",
  "ilike",
  "is",
  "in",
  "not",
  "order",
]);

/**
 * A list source whose contract field names differ from the table's columns. `select` asks
 * PostgREST for `field:column`, and every filter, order and keyset `or` the listing applies is
 * rewritten to the column, so `listPage` works in contract names end to end.
 */
export function aliasedSource(
  start: () => { select(columns: string): unknown },
  aliases: Readonly<Record<string, string>>,
): { select(columns: string): unknown } {
  const column = (field: string) => aliases[field] ?? field;
  const rewriteOr = (filter: string) =>
    filter.replace(
      /(^|[(,])([a-z_]+)\./g,
      (_, lead: string, field: string) => `${lead}${column(field)}.`,
    );
  const wrap = (builder: unknown): unknown =>
    new Proxy(builder as Builder, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (typeof value !== "function") return value;
        if (prop === "then") return (value as (...a: unknown[]) => unknown).bind(target);
        return (...args: unknown[]) => {
          if (typeof prop === "string" && COLUMN_METHODS.has(prop) && typeof args[0] === "string") {
            args[0] = column(args[0]);
          } else if (prop === "or" && typeof args[0] === "string") {
            args[0] = rewriteOr(args[0]);
          }
          const result = (value as (...a: unknown[]) => unknown).apply(target, args);
          return result !== null && typeof result === "object" ? wrap(result) : result;
        };
      },
    });
  return {
    select(columns: string) {
      const mapped = columns
        .split(",")
        .map((c) => (aliases[c] ? `${c}:${aliases[c]}` : c))
        .join(",");
      return wrap(start().select(mapped));
    },
  };
}

/** A repository error as an API problem (README "Errors"). */
export function problemFor(error: DataError): Error {
  switch (error.kind) {
    case "refusal":
      return refused("REFUSE", error.message, error.rule);
    case "not-found":
      return notFound();
    case "conflict":
      return conflict(error.message);
    case "invalid":
      return refused("REFUSE", error.message, "invalid_value");
    case "unexpected":
      return new Error(error.message);
  }
}

const SCOPE_ALIASES = { node_kind: "scope_kind" } as const;
const PHASE_ALIASES = { transitioned_at: "created_at", transitioned_by: "created_by" } as const;

function liveProjects(db: XosClient) {
  return {
    select: (columns: string) => db.from("projects").select(columns).is("deleted_at", null),
  };
}

async function readProject(
  db: XosClient,
  id: string,
  columns: readonly string[] = PROJECT_COLUMNS,
) {
  const { data, error } = await db
    .from("projects")
    .select(columns.join(","))
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error !== null) throw error;
  if (data === null) throw notFound(`No project with id ${id} is visible to you.`);
  return data as unknown as Project;
}

async function readScopeNode(
  db: XosClient,
  id: string,
  columns: readonly string[] = SCOPE_NODE_COLUMNS,
) {
  const select = columns.map((c) => (c === "node_kind" ? "node_kind:scope_kind" : c)).join(",");
  const { data, error } = await db
    .from("scope_nodes")
    .select(select)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error !== null) throw error;
  if (data === null) throw notFound(`No scope node with id ${id} is visible to you.`);
  return data as unknown as ScopeNode;
}

/** The gate the project must pass next and the phase that follows it, from canon. */
async function nextGate(db: XosClient, phaseCode: string) {
  const { data, error } = await db
    .schema("xpms")
    .from("dim_phase")
    .select("phase_code, gate")
    .order("gate");
  if (error !== null) throw error;
  const phases = data ?? [];
  const current = phases.find((p) => p.phase_code === phaseCode);
  if (current === undefined) throw notFound();
  const after = phases.find((p) => p.gate === current.gate + 1);
  return { gate: current.gate, next: after?.phase_code ?? current.phase_code };
}

// Handlers -----------------------------------------------------------------------------------------

export const handlers = defineHandlers("Projects", {
  "projects.list": async ({ query }, { db }) =>
    ok(
      await listPage<Project>(liveProjects(db), query, {
        columns: PROJECT_COLUMNS,
        key: "id",
        defaultOrder: ["created_at"],
      }),
    ),

  "projects.create": async ({ body }, context) => {
    const result = await createProject(context.db, {
      orgId: requireOrg(context).id,
      key: body.project_key,
      name: body.name,
      timeZone: body.time_zone,
      jurisdictionId: body.jurisdiction_id ?? null,
      regionCode: body.region_code ?? null,
      tierCode: body.tier_code ?? null,
      venueId: body.venue_id ?? null,
      startsOn: body.starts_on ?? null,
      endsOn: body.ends_on ?? null,
      currencyCode: body.currency ?? null,
      description: body.description ?? null,
    });
    if (!result.ok) throw problemFor(result.error);
    if (body.workspace_id !== undefined && body.workspace_id !== null) {
      const { error } = await context.db
        .from("projects")
        .update({ workspace_id: body.workspace_id } as never)
        .eq("id", result.data.id);
      if (error !== null) throw error;
    }
    return created(await readProject(context.db, result.data.id));
  },

  "projects.archive": async ({ params }, { db }) => {
    await readProject(db, params.id, ["id"]);
    const result = await setProjectArchived(db, params.id, true);
    if (!result.ok) throw problemFor(result.error);
    return ok(await readProject(db, params.id));
  },

  "projects.unarchive": async ({ params }, { db }) => {
    await readProject(db, params.id, ["id"]);
    const result = await setProjectArchived(db, params.id, false);
    if (!result.ok) throw problemFor(result.error);
    return ok(await readProject(db, params.id));
  },

  "projects.get": async ({ params, query }, { db }) =>
    ok(await readProject(db, params.id, selectColumns(query.fields, PROJECT_COLUMNS, "id"))),

  "projects.update": async ({ params, body, ifMatch }, { db }) => {
    const version = versionFromIfMatch(ifMatch ?? "*");
    const patch = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
    let update = db
      .from("projects")
      .update(patch as never)
      .eq("id", params.id)
      .is("deleted_at", null);
    if (version !== null) update = update.eq("updated_at", version);
    const { data, error } = await update.select(PROJECT_COLUMNS.join(",")).maybeSingle();
    if (error !== null) throw error;
    if (data === null) {
      await readProject(db, params.id);
      throw preconditionFailed();
    }
    return ok(data as unknown as Project);
  },

  "projects.transition": async ({ params, body }, { db }) => {
    const current = await readProject(db, params.id);
    if (current.project_state !== body.expected_state) {
      throw conflict(
        `The project is ${current.project_state}, not ${body.expected_state}; read it again.`,
      );
    }
    const result = await transitionProject(db, {
      projectId: params.id,
      expected: body.expected_state as never,
      next: body.to_state as never,
      reason: body.reason ?? "",
    });
    if (!result.ok) throw problemFor(result.error);
    return ok(await readProject(db, params.id));
  },

  "projects.passGate": async ({ params, body }, { db }) => {
    const current = await readProject(db, params.id);
    const { next } = await nextGate(db, body.expected_phase_code);
    if (body.to_phase_code !== next) {
      throw conflict(
        `Passing the gate from ${body.expected_phase_code} enters ${next}, not ${body.to_phase_code}.`,
      );
    }
    if (current.current_phase_code !== body.expected_phase_code) {
      throw conflict(
        `The project is in ${current.current_phase_code}, not ${body.expected_phase_code}; read it again.`,
      );
    }
    const result = await passGate(db, {
      projectId: params.id,
      expectedPhase: body.expected_phase_code,
      reason: `Gate passed through the API toward ${body.to_phase_code}.`,
    });
    if (!result.ok) throw problemFor(result.error);
    return ok(await readProject(db, params.id));
  },

  "projects.gateReadiness": async ({ params }, { db }) => {
    const project = await readProject(db, params.id, ["id", "current_phase_code"]);
    const { gate } = await nextGate(db, project.current_phase_code);
    const { data, error } = await db
      .from("gate_criteria_status")
      .select("project_id, gate, criterion_id, is_blocking, evidence_count")
      .eq("project_id", params.id)
      .eq("gate", gate)
      .order("criterion_id");
    if (error !== null) throw error;
    return ok({
      data: (data ?? []).map((r) => ({
        project_id: r.project_id ?? params.id,
        gate: r.gate ?? gate,
        criterion_id: r.criterion_id ?? "",
        blocking: r.is_blocking === true,
        satisfied: (r.evidence_count ?? 0) > 0,
      })),
      next_cursor: null,
    } as Components["GateReadinessPage"]);
  },

  "scopeNodes.list": async ({ query }, { db }) =>
    ok(
      await listPage<ScopeNode>(
        aliasedSource(
          () => ({
            select: (c: string) => db.from("scope_nodes").select(c).is("deleted_at", null),
          }),
          SCOPE_ALIASES,
        ),
        query,
        { columns: SCOPE_NODE_COLUMNS, key: "id", defaultOrder: ["created_at"] },
      ),
    ),

  "scopeNodes.get": async ({ params, query }, { db }) =>
    ok(await readScopeNode(db, params.id, selectColumns(query.fields, SCOPE_NODE_COLUMNS, "id"))),

  "scopeNodes.create": async ({ body }, { db }) => {
    const result = await createScopeNode(db, {
      projectId: body.project_id,
      parentId: body.parent_id ?? null,
      kind: body.node_kind as never,
      code: body.scope_code,
      name: body.name,
    });
    if (!result.ok) throw problemFor(result.error);
    return created(await readScopeNode(db, result.data.id));
  },

  "scopeNodes.update": async ({ params, body, ifMatch }, { db }) => {
    const version = versionFromIfMatch(ifMatch ?? "*");
    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch["name"] = body.name;
    // Code and kind are immutable; sending a new one reaches the database guard, which refuses it.
    if (body.scope_code !== undefined) patch["scope_code"] = body.scope_code;
    if (body.node_kind !== undefined) patch["scope_kind"] = body.node_kind;
    let update = db
      .from("scope_nodes")
      .update(patch as never)
      .eq("id", params.id)
      .is("deleted_at", null);
    if (version !== null) update = update.eq("updated_at", version);
    const { data, error } = await update.select("id").maybeSingle();
    if (error !== null) throw error;
    if (data === null) {
      await readScopeNode(db, params.id);
      throw preconditionFailed();
    }
    return ok(await readScopeNode(db, params.id));
  },

  "scopeNodes.delete": async ({ params }, { db }) => {
    const result = await removeScopeNode(db, params.id);
    if (!result.ok) throw problemFor(result.error);
    return noContent();
  },

  "projectPhaseTransitions.list": async ({ query }, { db }) =>
    ok(
      await listPage<PhaseTransition>(
        aliasedSource(() => db.from("project_phase_transitions"), PHASE_ALIASES),
        query,
        { columns: PHASE_TRANSITION_COLUMNS, key: "id", defaultOrder: ["transitioned_at"] },
      ),
    ),

  "projectPhaseTransitions.get": async ({ params, query }, { db }) => {
    const columns = selectColumns(query.fields, PHASE_TRANSITION_COLUMNS, "id").map((c) =>
      c in PHASE_ALIASES ? `${c}:${PHASE_ALIASES[c as keyof typeof PHASE_ALIASES]}` : c,
    );
    const { data, error } = await db
      .from("project_phase_transitions")
      .select(columns.join(","))
      .eq("id", params.id)
      .maybeSingle();
    if (error !== null) throw error;
    if (data === null) throw notFound(`No gate transition with id ${params.id} is visible to you.`);
    return ok(data as unknown as PhaseTransition);
  },

  // Gate evidence: attested by the database guard (who and when), withdrawn by soft delete.
  ...tableHandlers("Projects", "gateEvidence"),
});
