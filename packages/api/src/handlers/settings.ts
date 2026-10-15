/**
 * Settings handlers (A30, migration 0850): the settings registry, setting values with their org
 * lock, and setting locks. Values at the organization, workspace, team and project scopes are
 * written through `app.set_setting` and `app.clear_setting`, so the guards check type, scope and
 * lock and RLS checks the setting's capability. Personal values belong to the person and are
 * edited in personal settings; the API refuses them here. See packages/api/README.md.
 */
import type { XosClient } from "@xos/data";
import type { Components } from "../contract/operations.generated.ts";
import { badRequest, notFound, refused } from "../problem.ts";
import { requireOrg } from "../runtime/context.ts";
import { assertIfMatch } from "../runtime/etag.ts";
import { created, defineHandlers, noContent, ok } from "../runtime/handler.ts";
import { decodeCursor, pageSize, toPage } from "../runtime/pagination.ts";
import { settingsParity } from "./settings/parity.ts";

type SettingValue = Components["SettingValue"];
type SettingLock = Components["SettingLock"];
type SettingDefinition = Components["SettingDefinition"];

const VALUE_COLUMNS =
  "id, org_id, created_at, created_by, updated_at, updated_by, setting_key, scope_kind, scope_id, value_text, value_boolean, value_integer, locked";

interface ValueRow {
  id: string;
  org_id: string;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  updated_by: string | null;
  setting_key: string;
  scope_kind: "Organization" | "Workspace" | "Team" | "Project";
  scope_id: string;
  value_text: string | null;
  value_boolean: boolean | null;
  value_integer: number | null;
  locked: boolean;
}

export function toSettingValue(row: ValueRow): SettingValue {
  return {
    id: row.id,
    org_id: row.org_id,
    created_at: row.created_at,
    created_by: row.created_by ?? "",
    updated_at: row.updated_at,
    updated_by: row.updated_by ?? "",
    scope_type: row.scope_kind,
    scope_id: row.scope_kind === "Organization" ? null : row.scope_id,
    setting_key: row.setting_key,
    value: row.value_text ?? row.value_boolean ?? row.value_integer ?? "",
  };
}

function toLock(row: ValueRow): SettingLock {
  return {
    id: row.id,
    org_id: row.org_id,
    created_at: row.created_at,
    created_by: row.created_by ?? "",
    updated_at: row.updated_at,
    updated_by: row.updated_by ?? "",
    setting_key: row.setting_key,
  };
}

function valueArgs(value: string | number | boolean) {
  if (typeof value === "string") return { p_value_text: value };
  if (typeof value === "boolean") return { p_value_boolean: value };
  if (!Number.isInteger(value)) throw badRequest("Integer settings take whole numbers.");
  return { p_value_integer: value };
}

const SHARED_SCOPES = ["Organization", "Workspace", "Team", "Project"] as const;
type SharedScope = (typeof SHARED_SCOPES)[number];

function sharedScope(scope: Components["SettingScope"]): SharedScope {
  if ((SHARED_SCOPES as readonly string[]).includes(scope)) return scope as SharedScope;
  throw refused(
    "REFUSE",
    "Personal values are set in personal settings, and platform defaults come from the registry.",
    "setting_scope_not_allowed",
  );
}

export const handlers = defineHandlers("Settings", {
  // API parity (A04P): see ./settings/parity.ts.
  ...settingsParity,
  "settingDefinitions.list": async ({ query }, { db }) => {
    const size = pageSize(query.limit);
    let request = db
      .from("setting_definitions")
      .select(
        "setting_key, value_type, capability_code, allows_organization, allows_workspace, allows_team, allows_project, allows_personal",
      )
      .order("setting_key", { ascending: true })
      .limit(size + 1);
    if (query.cursor !== undefined) {
      request = request.gt(
        "setting_key",
        String(decodeCursor(query.cursor, ["setting_key"])["setting_key"]),
      );
    }
    const { data, error } = await request;
    if (error !== null) throw error;
    const rows: SettingDefinition[] = data.map((d) => ({
      setting_key: d.setting_key ?? "",
      scope: d.allows_organization ? "Organization" : "Personal",
      value_type: (d.value_type ?? "Text").toLowerCase(),
      edit_capability: d.capability_code ?? "",
      overridable: Boolean(
        d.allows_workspace || d.allows_team || d.allows_project || d.allows_personal,
      ),
    }));
    return ok(toPage(rows, size, (row) => ({ setting_key: row.setting_key })));
  },

  "settingValues.list": async ({ query }, context) => {
    const org = requireOrg(context);
    const size = pageSize(query.limit);
    let request = context.db
      .from("setting_values")
      .select(VALUE_COLUMNS)
      .eq("org_id", org.id)
      .is("deleted_at", null)
      .order("id", { ascending: true })
      .limit(size + 1);
    if (query.cursor !== undefined) {
      request = request.gt("id", String(decodeCursor(query.cursor, ["id"])["id"]));
    }
    const { data, error } = await request;
    if (error !== null) throw error;
    return ok(toPage((data as ValueRow[]).map(toSettingValue), size, (row) => ({ id: row.id })));
  },

  "settingValues.get": async ({ params }, { db }) => {
    const row = await readValue(db, params.id);
    return ok(toSettingValue(row));
  },

  "settingValues.create": async ({ body }, context) => {
    const org = requireOrg(context);
    const scope = sharedScope(body.scope_type);
    const scopeId = scope === "Organization" ? org.id : body.scope_id;
    if (!scopeId) throw badRequest("scope_id names the workspace, team or project.");
    const { data, error } = await context.db.rpc("set_setting", {
      p_org_id: org.id,
      p_setting_key: body.setting_key,
      p_scope_kind: scope,
      p_scope_id: scopeId,
      ...valueArgs(body.value),
    });
    if (error !== null) throw error;
    return created(toSettingValue(await readValue(context.db, data)));
  },

  "settingValues.update": async ({ params, body, ifMatch }, context) => {
    const row = await readValue(context.db, params.id);
    assertIfMatch(ifMatch ?? "*", toSettingValue(row));
    if (body.value === undefined) return ok(toSettingValue(row));
    const { error } = await context.db.rpc("set_setting", {
      p_org_id: row.org_id,
      p_setting_key: row.setting_key,
      p_scope_kind: row.scope_kind,
      p_scope_id: row.scope_id,
      ...valueArgs(body.value),
      p_locked: row.locked,
    });
    if (error !== null) throw error;
    return ok(toSettingValue(await readValue(context.db, row.id)));
  },

  "settingValues.delete": async ({ params }, { db }) => {
    const row = await readValue(db, params.id);
    const { error } = await db.rpc("clear_setting", {
      p_org_id: row.org_id,
      p_setting_key: row.setting_key,
      p_scope_kind: row.scope_kind,
      p_scope_id: row.scope_id,
    });
    if (error !== null) throw error;
    return noContent();
  },

  "settingLocks.list": async ({ query }, context) => {
    const org = requireOrg(context);
    const size = pageSize(query.limit);
    let request = context.db
      .from("setting_values")
      .select(VALUE_COLUMNS)
      .eq("org_id", org.id)
      .eq("scope_kind", "Organization")
      .eq("locked", true)
      .is("deleted_at", null)
      .order("id", { ascending: true })
      .limit(size + 1);
    if (query.cursor !== undefined) {
      request = request.gt("id", String(decodeCursor(query.cursor, ["id"])["id"]));
    }
    const { data, error } = await request;
    if (error !== null) throw error;
    return ok(toPage((data as ValueRow[]).map(toLock), size, (row) => ({ id: row.id })));
  },

  "settingLocks.get": async ({ params }, { db }) => {
    const row = await readValue(db, params.id);
    if (!row.locked) throw notFound("No setting lock with this identifier is visible to you.");
    return ok(toLock(row));
  },

  "settingLocks.create": async ({ body }, context) => {
    const org = requireOrg(context);
    const { data, error } = await context.db
      .from("setting_values")
      .select(VALUE_COLUMNS)
      .eq("org_id", org.id)
      .eq("setting_key", body.setting_key)
      .eq("scope_kind", "Organization")
      .is("deleted_at", null)
      .maybeSingle();
    if (error !== null) throw error;
    const row = data as ValueRow | null;
    if (row === null) {
      throw refused(
        "REFUSE",
        "Set the organization value first; a lock keeps that value for every lower scope.",
        "setting_lock_needs_value",
      );
    }
    const value = row.value_text ?? row.value_boolean ?? row.value_integer;
    const locked = await context.db.rpc("set_setting", {
      p_org_id: org.id,
      p_setting_key: row.setting_key,
      p_scope_kind: "Organization",
      p_scope_id: org.id,
      ...valueArgs(value ?? ""),
      p_locked: true,
    });
    if (locked.error !== null) throw locked.error;
    return created(toLock(await readValue(context.db, row.id)));
  },

  "settingLocks.delete": async ({ params }, { db }) => {
    const row = await readValue(db, params.id);
    if (!row.locked) throw notFound("No setting lock with this identifier is visible to you.");
    const { error } = await db.rpc("set_setting", {
      p_org_id: row.org_id,
      p_setting_key: row.setting_key,
      p_scope_kind: "Organization",
      p_scope_id: row.org_id,
      ...valueArgs(row.value_text ?? row.value_boolean ?? row.value_integer ?? ""),
      p_locked: false,
    });
    if (error !== null) throw error;
    return noContent();
  },
});

async function readValue(db: XosClient, id: string): Promise<ValueRow> {
  const { data, error } = await db
    .from("setting_values")
    .select(VALUE_COLUMNS)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error !== null) throw error;
  if (data === null) throw notFound("No setting value with this identifier is visible to you.");
  return data as ValueRow;
}
