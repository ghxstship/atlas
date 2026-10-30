/**
 * Places handlers (A09): venues with their location, spaces, zones, capability documents (freeze),
 * site plans and pins, geofences as GeoJSON polygons, requirements and capabilities (one shape with a
 * direction facet), reconciliation runs and their lines. Every call runs as the caller, so row level
 * security and the guards of 0301, 0350, 0351 and 0420 to 0422 decide; refusals come back as 422 with
 * the rule. Shapes follow the corrected catalog (catalog/modules/places.ts, ADR 0023).
 */
import { notFound, preconditionFailed, refused } from "../problem.ts";
import type { RequestContext } from "../runtime/context.ts";
import { assertIfMatch, versionFromIfMatch } from "../runtime/etag.ts";
import { created, defineHandlers, ok } from "../runtime/handler.ts";
import {
  from,
  handlersFor,
  rpc,
  run,
  tableHandlers,
  tableResource,
  type Row,
} from "./support/table.ts";

// Site plans ------------------------------------------------------------------------------------------

const listedSitePlans = tableResource("sitePlans", {
  verbs: ["list"],
  scope: (query) => query.neq("plan_state", "Archived"),
});

// Venues ------------------------------------------------------------------------------------------

const venues = tableResource("venues", {
  aliases: { latitude: "venue_latitude", longitude: "venue_longitude" },
  sortable: [
    "name",
    "locality",
    "postal_code",
    "jurisdiction_id",
    "time_zone",
    "created_at",
    "updated_at",
  ],
});

const VENUE_COLUMNS = [
  "name",
  "street_address",
  "locality",
  "postal_code",
  "jurisdiction_id",
  "time_zone",
];

function venueColumns(body: Row): Row {
  return Object.fromEntries(
    VENUE_COLUMNS.filter((c) => body[c] !== undefined).map((c) => [c, body[c]]),
  );
}

/** Sets or clears the location when the body names it; both coordinates travel together. */
async function locate(context: RequestContext, id: string, body: Row): Promise<void> {
  const hasLat = body["latitude"] !== undefined;
  const hasLng = body["longitude"] !== undefined;
  if (!hasLat && !hasLng) return;
  if (hasLat !== hasLng) {
    throw refused(
      "REFUSE",
      "Send latitude and longitude together, or neither.",
      "venue_location_pair",
    );
  }
  await run(
    rpc(context.db, "set_venue_location", {
      p_venue_id: id,
      p_longitude: body["longitude"],
      p_latitude: body["latitude"],
    }),
  );
}

// Capability documents ------------------------------------------------------------------------------

const documents = tableResource("capabilityDocuments", { aliases: { frozen: "is_frozen" } });

// Geofences --------------------------------------------------------------------------------------------

const geofences = tableResource("geofences", {
  derived: ["boundary"],
  sortable: ["name", "venue_id", "zone_id", "created_at", "updated_at"],
  toContract: async (row, context) => {
    const shape = await run<{ boundary_geojson: unknown } | null>(
      from(context.db, "geofence_shapes")
        .select("boundary_geojson")
        .eq("id", row["id"])
        .maybeSingle(),
    );
    return { ...row, boundary: shape?.boundary_geojson ?? null };
  },
});

// Reconciliations ---------------------------------------------------------------------------------------

const reconciliations = tableResource("reconciliations", {
  aliases: { run_at: "reconciled_at" },
  derived: ["met_count", "gap_count", "unknown_count"],
  sortable: ["project_id", "run_at", "created_at"],
  toContract: async (row, context) => {
    const lines = await run<{ result: string }[]>(
      from(context.db, "reconciliation_lines")
        .select("result")
        .eq("reconciliation_id", row["id"])
        .is("deleted_at", null),
    );
    const count = (result: string) => lines.filter((l) => l.result === result).length;
    return {
      ...row,
      met_count: count("Met"),
      gap_count: count("Gap"),
      unknown_count: count("Unknown"),
    };
  },
});

export const handlers = defineHandlers("Places", {
  ...handlersFor("Places", venues),
  "venues.create": async ({ body }, context) => {
    const values = {
      ...venueColumns(body as Row),
      ...(context.org ? { org_id: context.org.id } : {}),
    };
    const inserted = await run<{ id: string }>(
      from(context.db, "venues").insert(values).select("id").single(),
    );
    await locate(context, inserted.id, body as Row);
    return created((await venues.read(context, inserted.id)) as never);
  },
  "venues.update": async ({ params, body, ifMatch }, context) => {
    const id = String(params.id);
    const current = await venues.read(context, id);
    const patch = venueColumns(body as Row);
    if (Object.keys(patch).length === 0) {
      assertIfMatch(ifMatch ?? "*", current);
    } else {
      const version = versionFromIfMatch(ifMatch ?? "*");
      let q = from(context.db, "venues").update(patch).eq("id", id).is("deleted_at", null);
      if (version !== null) q = q.eq("updated_at", version);
      const rows = await run<Row[]>(q.select("id"));
      if (rows.length === 0) throw preconditionFailed();
    }
    await locate(context, id, body as Row);
    return ok((await venues.read(context, id)) as never);
  },

  ...tableHandlers("Places", "spaces"),
  ...tableHandlers("Places", "zones"),

  ...handlersFor("Places", documents),
  "capabilityDocuments.freeze": async ({ params }, context) => {
    const id = String(params.id);
    await documents.read(context, id, ["id"]);
    const rows = await run<Row[]>(
      from(context.db, "capability_documents")
        .update({ is_frozen: true })
        .eq("id", id)
        .select("id"),
    );
    if (rows.length === 0) throw notFound();
    return ok((await documents.read(context, id)) as never);
  },

  ...tableHandlers("Places", "sitePlans"),
  // v1 has no plan state (frozen contract, B1, ADR 0140 D1): a list leaves out Archived plans, so a v1 client never
  // takes a retired plan for a live one. Get, update and delete still answer for it.
  ...handlersFor("Places", listedSitePlans),
  ...tableHandlers("Places", "sitePlanPins", { aliases: { x: "x_ratio", y: "y_ratio" } }),

  ...handlersFor("Places", geofences),
  "geofences.create": async ({ body }, context) => {
    const b = body as Row;
    const id = await run<string>(
      rpc(context.db, "save_geofence", {
        p_id: null,
        p_venue_id: b["venue_id"],
        p_zone_id: b["zone_id"] ?? null,
        p_name: b["name"],
        p_boundary_geojson: b["boundary"],
      }),
    );
    return created((await geofences.read(context, id)) as never);
  },
  "geofences.update": async ({ params, body }, context) => {
    const id = String(params.id);
    const current = await geofences.read(context, id);
    const b = body as Row;
    await run(
      rpc(context.db, "save_geofence", {
        p_id: id,
        p_venue_id: null,
        p_zone_id: b["zone_id"] === undefined ? current["zone_id"] : b["zone_id"],
        p_name: b["name"] ?? current["name"],
        p_boundary_geojson: b["boundary"] ?? current["boundary"],
      }),
    );
    return ok((await geofences.read(context, id)) as never);
  },

  ...tableHandlers("Places", "requirements"),

  ...handlersFor("Places", reconciliations),
  "reconciliations.create": async ({ body }, context) => {
    const b = body as Row;
    const id = await run<string>(
      rpc(context.db, "reconcile_project", {
        p_project_id: b["project_id"],
        p_note: b["note"] ?? null,
      }),
    );
    return created((await reconciliations.read(context, id)) as never);
  },
  ...tableHandlers("Places", "reconciliationLines"),
});
