/**
 * Handlers for the settings features A52 built (RRR-97, ADR 0032 amendment): org legal entities,
 * the IP allow-list, access review campaigns and items, break-glass sessions and project shares
 * (Settings), and project assignment roles and blocks (Identity). Tables are read and written as the
 * caller, so row level security and the guards of migrations 1200 to 1206 decide every refusal.
 * The Restricted tax identifier is written through its encrypting RPC and read from the masked view;
 * break-glass sessions open and end through their RPCs.
 */
import type { Components } from "../../contract/operations.generated.ts";
import { requireOrg } from "../../runtime/context.ts";
import type { RequestContext } from "../../runtime/context.ts";
import { assertIfMatch } from "../../runtime/etag.ts";
import type { HandlerSet } from "../../runtime/handler.ts";
import { created, noContent, ok } from "../../runtime/handler.ts";
import { masked } from "../../runtime/masking.ts";
import { notFound, preconditionFailed } from "../../problem.ts";
import { from, handlersFor, rpc, run, tableResource } from "../support/table.ts";
import type { Row } from "../support/table.ts";

// Legal entities ------------------------------------------------------------------------------------
// Reads come from app.org_legal_entities_masked (live rows only); writes go to app.org_legal_entities.

const TAX_REASON = "Requires data.restricted.read.tax.";
const ENTITY_FIELDS = [
  "legal_name",
  "country_code",
  "fiscal_year_start_month",
  "base_currency",
  "is_primary",
] as const;

const legalEntities = tableResource("orgLegalEntities", {
  softDelete: false,
  verbs: ["list", "get"],
  extraColumns: ["is_masked"],
  toContract: (row) => {
    const { is_masked: isMasked, ...rest } = row;
    return isMasked === true ? { ...rest, tax_identifier: masked(TAX_REASON) } : rest;
  },
});

function entityColumns(body: Row): Row {
  const out: Row = {};
  for (const field of ENTITY_FIELDS) if (body[field] !== undefined) out[field] = body[field];
  return out;
}

async function setTaxIdentifier(context: RequestContext, id: string, value: unknown) {
  await run(
    rpc(context.db, "set_org_legal_entity_tax_identifier", {
      p_legal_entity_id: id,
      p_tax_identifier: value ?? null,
    }),
  );
}

// Break-glass sessions ------------------------------------------------------------------------------

const breakGlass = tableResource("breakGlassSessions", { verbs: ["list", "get"] });

// Project shares --------------------------------------------------------------------------------------

async function scopeNodesOf(context: RequestContext, shareId: unknown): Promise<string[]> {
  const rows = await run<{ scope_node_id: string }[]>(
    from(context.db, "project_share_scope_nodes")
      .select("scope_node_id")
      .eq("project_share_id", shareId)
      .is("deleted_at", null)
      .order("scope_node_id", { ascending: true }),
  );
  return rows.map((r) => r.scope_node_id);
}

async function replaceScopeNodes(
  context: RequestContext,
  shareId: string,
  wanted: readonly string[],
): Promise<void> {
  const current = await scopeNodesOf(context, shareId);
  const removed = current.filter((n) => !wanted.includes(n));
  const added = [...new Set(wanted)].filter((n) => !current.includes(n));
  if (removed.length > 0) {
    await run(
      from(context.db, "project_share_scope_nodes")
        .update({ deleted_at: new Date().toISOString() })
        .eq("project_share_id", shareId)
        .in("scope_node_id", removed)
        .is("deleted_at", null),
    );
  }
  if (added.length > 0) {
    await run(
      from(context.db, "project_share_scope_nodes").insert(
        added.map((scope_node_id) => ({ project_share_id: shareId, scope_node_id })),
      ),
    );
  }
}

const projectShares = tableResource("projectShares", {
  verbs: ["list", "get", "delete"],
  derived: ["scope_node_ids"],
  toContract: async (row, context) => ({
    ...row,
    scope_node_ids: await scopeNodesOf(context, row["id"]),
  }),
});

const SHARE_FIELDS = ["project_role", "valid_to"] as const;

// Handlers --------------------------------------------------------------------------------------------

export const a52SettingsHandlers = {
  ...handlersFor("Settings", legalEntities),
  "orgLegalEntities.create": async ({ body }, context) => {
    const inserted = await run<Row>(
      from(context.db, "org_legal_entities")
        .insert({ org_id: requireOrg(context).id, ...entityColumns(body as Row) })
        .select("id")
        .single(),
    );
    const id = String(inserted["id"]);
    if ((body.tax_identifier ?? null) !== null)
      await setTaxIdentifier(context, id, body.tax_identifier);
    return created((await legalEntities.read(context, id)) as Components["OrgLegalEntity"]);
  },
  "orgLegalEntities.update": async ({ params, body, ifMatch }, context) => {
    const current = await legalEntities.read(context, params.id);
    assertIfMatch(ifMatch ?? "*", current);
    const patch = entityColumns(body as Row);
    if (Object.keys(patch).length > 0) {
      const rows = await run<Row[] | null>(
        from(context.db, "org_legal_entities")
          .update(patch)
          .eq("id", params.id)
          .is("deleted_at", null)
          .select("id"),
      );
      if (rows === null || rows.length === 0) throw preconditionFailed();
    }
    if (body.tax_identifier !== undefined) {
      await setTaxIdentifier(context, params.id, body.tax_identifier);
    }
    return ok((await legalEntities.read(context, params.id)) as Components["OrgLegalEntity"]);
  },
  "orgLegalEntities.delete": async ({ params }, context) => {
    await legalEntities.read(context, params.id, ["id"]);
    await run(
      from(context.db, "org_legal_entities")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", params.id)
        .is("deleted_at", null),
    );
    return noContent();
  },

  ...handlersFor("Settings", tableResource("orgIpAllowlistEntries")),
  ...handlersFor("Settings", tableResource("accessReviewCampaigns")),
  ...handlersFor("Settings", tableResource("accessReviewItems", { orgColumn: false })),

  ...handlersFor("Settings", breakGlass),
  "breakGlassSessions.create": async ({ body }, context) => {
    const session = await run<Row>(
      rpc(context.db, "start_break_glass", {
        p_org_id: requireOrg(context).id,
        p_reason: body.reason,
      }),
    );
    return created(
      (await breakGlass.read(context, String(session["id"]))) as Components["BreakGlassSession"],
    );
  },
  "breakGlassSessions.end": async ({ params }, context) => {
    await breakGlass.read(context, params.id, ["id"]);
    await run(rpc(context.db, "end_break_glass", { p_session_id: params.id }));
    return ok((await breakGlass.read(context, params.id)) as Components["BreakGlassSession"]);
  },

  ...handlersFor("Settings", projectShares),
  "projectShares.create": async ({ body }, context) => {
    const values: Row = {
      project_id: body.project_id,
      partner_organization_id: body.partner_organization_id,
    };
    for (const field of SHARE_FIELDS) if (body[field] !== undefined) values[field] = body[field];
    const inserted = await run<Row>(
      from(context.db, "project_shares").insert(values).select("id").single(),
    );
    const id = String(inserted["id"]);
    if (body.scope_node_ids !== undefined)
      await replaceScopeNodes(context, id, body.scope_node_ids);
    return created((await projectShares.read(context, id)) as Components["ProjectShare"]);
  },
  "projectShares.update": async ({ params, body, ifMatch }, context) => {
    const current = await projectShares.read(context, params.id);
    assertIfMatch(ifMatch ?? "*", current);
    const patch: Row = {};
    for (const field of SHARE_FIELDS) if (body[field] !== undefined) patch[field] = body[field];
    if (Object.keys(patch).length > 0) {
      const rows = await run<Row[] | null>(
        from(context.db, "project_shares")
          .update(patch)
          .eq("id", params.id)
          .is("deleted_at", null)
          .select("id"),
      );
      if (rows === null || rows.length === 0) throw notFound();
    }
    if (body.scope_node_ids !== undefined) {
      await replaceScopeNodes(context, params.id, body.scope_node_ids);
    }
    return ok((await projectShares.read(context, params.id)) as Components["ProjectShare"]);
  },
} satisfies HandlerSet<"Settings">;

export const a52IdentityHandlers = {
  ...handlersFor("Identity", tableResource("projectAssignmentRoles", { orgColumn: false })),
  ...handlersFor("Identity", tableResource("blocks")),
} satisfies HandlerSet<"Identity">;
