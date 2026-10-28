/**
 * Work handlers (A08): the record spine (records, their state ledger, checklist items and
 * watchers) and work orders with bids. Every read runs as the caller, so row level security decides
 * (invariant 2); state changes go through app.transition_record, app.transition_work_order and
 * app.award_work_order, whose refusals come back as 422 with the rule.
 *
 * Operations left out stay document-only because the frozen v1 contract and the schema disagree;
 * the A08 completion report proposes the corrections:
 *   records.archive (records have no archived state: Trash is the soft delete, Canceled the
 *   retained end state) and recordReplans (the contract lists one field per entry; the replan log
 *   stores one row per change with every date before and after).
 */
import type { XosClient } from "@xos/data";
import { applyArchived, parseArchived, type ArchivedFilter } from "@xos/data/archive";
import { duplicateRecord, transitionRecord } from "@xos/data/work";
import { awardWorkOrder, transitionWorkOrder } from "@xos/data/work-orders";
import type { Components } from "../contract/operations.generated.ts";
import { badRequest, conflict, notFound, preconditionFailed, refused } from "../problem.ts";
import { versionFromIfMatch } from "../runtime/etag.ts";
import { created, defineHandlers, noContent, ok } from "../runtime/handler.ts";
import { listPage } from "../runtime/listing.ts";
import { selectColumns } from "../runtime/pagination.ts";
import { requireOrg } from "../runtime/context.ts";
import { aliasedSource, problemFor } from "./projects.ts";
import { bulkEdit, fieldHistory } from "./parts/bulk-edit-and-history.ts";
import { from, groupBy, tableHandlers } from "./support/table.ts";

type RecordBody = Components["Record"];
type ChecklistItem = Components["RecordChecklistItem"];
type Watcher = Components["RecordWatcher"];
type StateTransition = Components["RecordStateTransition"];
type WorkOrder = Components["WorkOrder"];
type Bid = Components["WorkOrderBid"];
type Row = Record<string, unknown>;

const BASE = ["id", "org_id", "created_at", "created_by", "updated_at", "updated_by"] as const;

// Records ------------------------------------------------------------------------------------------------

/** Read columns of a record; external_visibility is added from its junction rows. */
export const RECORD_COLUMNS = [
  ...BASE,
  "record_key",
  "record_kind",
  "record_subtype",
  "record_class",
  "record_state",
  "title",
  "scope_node_id",
  "phase_code",
  "urid",
  "xyz",
  "owner_party_id",
  "accountable_party_id",
  "starts_at",
  "ends_at",
  "due_at",
  "blocker_text",
  "replan_reason",
  "project_id",
  "parent_record_id",
  "wbs_code",
  "description",
  "sop_id",
  "team_code",
] as const;

const RECORD_ALIASES = { record_key: "record_display_key" } as const;

/**
 * Read fields a record's sidecars hold (A54-002): its assignees (app.record_assignments) and the subtype facts of
 * app.record_task, app.record_permit and app.record_inspection. Read once per page, never selected.
 */
const RECORD_DERIVED = [
  "assignee_membership_ids",
  "progress_pct",
  "permit_identifier",
  "inspection_result_enum_id",
] as const;

/** Every read field of a record, in contract order. */
const RECORD_FIELDS = [...RECORD_COLUMNS, "external_visibility", ...RECORD_DERIVED];
const derivedField = (c: string) =>
  c === "external_visibility" || (RECORD_DERIVED as readonly string[]).includes(c);

/** Adds the sidecar fields the caller asked for to each record, one query per sidecar for the page. */
async function withSidecars<T extends Row>(
  db: XosClient,
  rows: T[],
  wanted: readonly string[],
): Promise<T[]> {
  const asked = RECORD_DERIVED.filter((f) => wanted.includes(f));
  if (asked.length === 0 || rows.length === 0) return rows;
  const ids = rows.map((r) => String(r["id"]));
  const sidecar = (table: string, columns: string, ask: boolean) =>
    ask
      ? groupBy(
          from(db, table)
            .select(`record_id, ${columns}`)
            .in("record_id", ids)
            .is("deleted_at", null)
            .order("created_at", { ascending: true }),
          "record_id",
        )
      : Promise.resolve(new Map<string, Row[]>());
  const [assignees, tasks, permits, inspections] = await Promise.all([
    sidecar("record_assignments", "membership_id", asked.includes("assignee_membership_ids")),
    sidecar("record_task", "progress_pct", asked.includes("progress_pct")),
    sidecar("record_permit", "permit_identifier", asked.includes("permit_identifier")),
    sidecar("record_inspection", "result_enum_id", asked.includes("inspection_result_enum_id")),
  ]);
  const first = (groups: ReadonlyMap<string, Row[]>, id: string, column: string) =>
    groups.get(id)?.[0]?.[column] ?? null;
  return rows.map((r) => {
    const id = String(r["id"]);
    const facts: Row = {
      assignee_membership_ids: (assignees.get(id) ?? []).map((a) => String(a["membership_id"])),
      progress_pct: first(tasks, id, "progress_pct"),
      permit_identifier: first(permits, id, "permit_identifier"),
      inspection_result_enum_id: first(inspections, id, "result_enum_id"),
    };
    return { ...r, ...Object.fromEntries(asked.map((f) => [f, facts[f]])) };
  });
}

/** Columns a page reads to compose `record_key` itself. */
const KEY_PARTS = ["project_id", "record_number"] as const;

/**
 * Sets `record_key` (`<project key>-<number>`) on rows read with KEY_PARTS, reading the projects'
 * keys in one query, and drops the parts the caller did not ask for.
 *
 * The `record_display_key` computed column gives the same value, but Postgres runs it once per row
 * as its own query, and each run evaluates the projects read policy from scratch: about 1.8 ms a
 * row, 40 ms for a page of 22 (A24-010). One query for the page's projects evaluates it once.
 */
export async function composeRecordKeys(
  db: XosClient,
  rows: Row[],
  added: readonly string[],
): Promise<Row[]> {
  const ids = [...new Set(rows.map((r) => r["project_id"]).filter((v) => typeof v === "string"))];
  const keys = new Map<string, string>();
  if (ids.length > 0) {
    const { data, error } = await db
      .from("projects")
      .select("id, project_key")
      .in("id", ids as string[]);
    if (error !== null) throw error;
    for (const p of data ?? []) keys.set(p.id, p.project_key);
  }
  return rows.map((row) => {
    const key = keys.get(String(row["project_id"]));
    const kept = Object.entries(row).filter(([column]) => !added.includes(column));
    return {
      ...Object.fromEntries(kept),
      record_key: key === undefined ? null : `${key}-${String(row["record_number"])}`,
    };
  });
}

/** Records that are not in Trash; a list leaves archived ones out unless asked (A124). */
function liveRecords(db: XosClient, archived: ArchivedFilter = "include") {
  const source = aliasedSource(
    () => ({
      select: (c: string) =>
        applyArchived(db.from("records").select(c).is("deleted_at", null), archived),
    }),
    RECORD_ALIASES,
  );
  return {
    select(columns: string): unknown {
      const list = columns.split(",");
      if (!list.includes("record_key")) return source.select(columns);
      const added = KEY_PARTS.filter((c) => !list.includes(c));
      const builder = source.select(
        [...list.filter((c) => c !== "record_key"), ...added].join(","),
      );
      return withComposedKeys(db, builder, added);
    },
  };
}

/** Wraps a records query so awaiting it answers rows with `record_key` composed. */
function withComposedKeys(db: XosClient, builder: unknown, added: readonly string[]): unknown {
  return new Proxy(builder as Row, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function") return value;
      if (prop === "then") {
        return (
          resolve: (v: unknown) => unknown,
          reject?: (reason: unknown) => unknown,
        ): PromiseLike<unknown> =>
          Promise.resolve(
            target as unknown as PromiseLike<{ data: Row[] | Row | null; error: unknown }>,
          )
            .then(async (result) => {
              if (result.error !== null || result.data === null) return result;
              if (Array.isArray(result.data)) {
                return { ...result, data: await composeRecordKeys(db, result.data, added) };
              }
              const [row] = await composeRecordKeys(db, [result.data], added);
              return { ...result, data: row };
            })
            .then(resolve, reject);
      }
      return (...args: unknown[]) => {
        const next = (value as (...a: unknown[]) => unknown).apply(target, args);
        return next !== null && typeof next === "object" ? withComposedKeys(db, next, added) : next;
      };
    },
  });
}

/** Adds external_visibility (the junction rows, presented as a set) to records that asked for it. */
async function withVisibility<T extends Row>(
  db: XosClient,
  rows: T[],
  wanted: boolean,
): Promise<T[]> {
  if (!wanted || rows.length === 0) return rows;
  const ids = rows.map((r) => String(r["id"]));
  const { data, error } = await db
    .from("record_external_visibility")
    .select("record_id, external_role_type")
    .in("record_id", ids)
    .is("deleted_at", null)
    .not("external_role_type", "is", null);
  if (error !== null) throw error;
  const byRecord = new Map<string, string[]>();
  for (const v of data ?? []) {
    if (v.external_role_type === null) continue;
    byRecord.set(v.record_id, [...(byRecord.get(v.record_id) ?? []), v.external_role_type]);
  }
  return rows.map((r) => ({ ...r, external_visibility: byRecord.get(String(r["id"])) ?? [] }));
}

async function readRecord(db: XosClient, id: string, fields?: string): Promise<RecordBody> {
  const wanted = selectColumns(fields, RECORD_FIELDS, "id");
  const columns = wanted
    .filter((c) => !derivedField(c))
    .map((c) =>
      c in RECORD_ALIASES ? `${c}:${RECORD_ALIASES[c as keyof typeof RECORD_ALIASES]}` : c,
    );
  const { data, error } = await db
    .from("records")
    .select(columns.join(","))
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error !== null) throw error;
  if (data === null) throw notFound(`No record with id ${id} is visible to you.`);
  const [row] = await withVisibility(
    db,
    await withSidecars(db, [data as unknown as Row], wanted),
    wanted.includes("external_visibility"),
  );
  return row as unknown as RecordBody;
}

/** Replaces the record's external role types with the given set. */
async function setVisibility(
  db: XosClient,
  orgId: string,
  recordId: string,
  roles: readonly string[],
): Promise<void> {
  const { data, error } = await db
    .from("record_external_visibility")
    .select("id, external_role_type")
    .eq("record_id", recordId)
    .is("deleted_at", null)
    .not("external_role_type", "is", null);
  if (error !== null) throw error;
  const current = data ?? [];
  const stale = current
    .filter((v) => !roles.includes(String(v.external_role_type)))
    .map((v) => v.id);
  if (stale.length > 0) {
    const { error: removeError } = await db
      .from("record_external_visibility")
      .update({ deleted_at: new Date().toISOString() })
      .in("id", stale);
    if (removeError !== null) throw removeError;
  }
  const have = new Set(current.map((v) => String(v.external_role_type)));
  const add = roles.filter((r) => !have.has(r));
  if (add.length > 0) {
    const { error: addError } = await db.from("record_external_visibility").insert(
      add.map((role) => ({
        org_id: orgId,
        record_id: recordId,
        external_role_type: role as never,
      })),
    );
    if (addError !== null) throw addError;
  }
}

/** The XYZ basis for a written tag: Category when it equals the URID category's tag. */
async function xyzBasis(db: XosClient, urid: string | null | undefined, xyz: string) {
  if (!urid) return "Declared" as const;
  const { data, error } = await db
    .schema("xpms")
    .from("dim_category")
    .select("xyz")
    .eq("cat_urid", urid)
    .maybeSingle();
  if (error !== null) throw error;
  return data?.xyz === xyz ? ("Category" as const) : ("Declared" as const);
}

// Checklist items ---------------------------------------------------------------------------------------

const CHECKLIST_COLUMNS = [
  ...BASE,
  "record_id",
  "position",
  "label",
  "done",
  "done_by",
  "done_at",
  "evidence_document_id",
] as const;

const CHECKLIST_SELECT = [...BASE, "record_id", "position", "label", "checked_at", "checked_by"];

/** A checklist row in contract shape: done is a tick, stamped by the database. */
function cleanChecklist(row: Row): ChecklistItem {
  const { checked_at: doneAt, checked_by: doneBy, ...rest } = row;
  return {
    ...(rest as unknown as ChecklistItem),
    done: doneAt !== null && doneAt !== undefined,
    done_by: (doneBy as string | null | undefined) ?? null,
    done_at: (doneAt as string | null | undefined) ?? null,
    evidence_document_id: null,
  };
}

async function readChecklistItem(db: XosClient, id: string): Promise<ChecklistItem> {
  const { data, error } = await db
    .from("record_checklist_items")
    .select(CHECKLIST_SELECT.join(","))
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error !== null) throw error;
  if (data === null) throw notFound(`No checklist item with id ${id} is visible to you.`);
  return cleanChecklist(data as unknown as Row);
}

// Watchers and state transitions ------------------------------------------------------------------------

const WATCHER_COLUMNS = [...BASE, "record_id", "person_id"] as const;
const TRANSITION_COLUMNS = [
  ...BASE,
  "record_id",
  "from_state",
  "to_state",
  "transitioned_at",
  "transitioned_by",
] as const;
const TRANSITION_ALIASES = {
  transitioned_at: "created_at",
  transitioned_by: "created_by",
} as const;

// Work orders and bids -----------------------------------------------------------------------------------

export const WORK_ORDER_COLUMNS = [
  ...BASE,
  "project_id",
  "record_id",
  "title",
  "urid",
  "work_order_state",
  "due_at",
  "budget_minor",
  "currency",
  "work_order_number",
  "location_text",
  "scope_of_work",
  "scheduled_starts_at",
  "estimated_hours",
] as const;
const WORK_ORDER_ALIASES = { due_at: "scheduled_ends_at", currency: "currency_code" } as const;

const BID_COLUMNS = [
  ...BASE,
  "work_order_id",
  "bidder_organization_id",
  "amount_minor",
  "currency",
  "bid_state",
  "notes",
] as const;
const BID_ALIASES = { currency: "currency_code", notes: "note" } as const;
const BID_SELECT = [
  ...BASE,
  "work_order_id",
  "bidder_organization_id",
  "amount_minor",
  "currency:currency_code",
  "notes:note",
  "withdrawn_at",
  "work_order:work_orders!work_order_bids_work_order_id_fkey(awarded_bid_id)",
];

function aliasSelect(columns: readonly string[], aliases: Readonly<Record<string, string>>) {
  return columns.map((c) => (aliases[c] ? `${c}:${aliases[c]}` : c)).join(",");
}

async function readWorkOrder(db: XosClient, id: string, fields?: string): Promise<WorkOrder> {
  const columns = selectColumns(fields, WORK_ORDER_COLUMNS, "id");
  const { data, error } = await db
    .from("work_orders")
    .select(aliasSelect(columns, WORK_ORDER_ALIASES))
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error !== null) throw error;
  if (data === null) throw notFound(`No work order with id ${id} is visible to you.`);
  return data as unknown as WorkOrder;
}

/** The state of a bid, derived from the work order's award and the withdrawal stamp. */
function toBid(row: Row): Bid {
  const awarded = (row["work_order"] as { awarded_bid_id: string | null } | null)?.awarded_bid_id;
  const bid: Row = {
    ...row,
    bid_state: awarded === row["id"] ? "Awarded" : row["withdrawn_at"] ? "Withdrawn" : "Submitted",
  };
  delete bid["work_order"];
  delete bid["withdrawn_at"];
  return bid as unknown as Bid;
}

async function readBid(db: XosClient, id: string): Promise<Bid> {
  const { data, error } = await db
    .from("work_order_bids")
    .select(BID_SELECT.join(","))
    .eq("id", id)
    .is("deleted_at", null)
    .not("bidder_organization_id", "is", null)
    .maybeSingle();
  if (error !== null) throw error;
  if (data === null) throw notFound(`No bid with id ${id} is visible to you.`);
  return toBid(data as unknown as Row);
}

/** Applies an update guarded by If-Match on updated_at; 412 when stale, 404 when gone. */
async function guardedUpdate(
  db: XosClient,
  table: "records" | "record_checklist_items" | "work_orders" | "work_order_bids",
  id: string,
  patch: Row,
  ifMatch: string | undefined,
  exists: () => Promise<unknown>,
): Promise<void> {
  const version = versionFromIfMatch(ifMatch ?? "*");
  let update = db
    .from(table)
    .update(patch as never)
    .eq("id", id)
    .is("deleted_at", null);
  if (version !== null) update = update.eq("updated_at", version);
  const { data, error } = await update.select("id").maybeSingle();
  if (error !== null) throw error;
  if (data === null) {
    await exists();
    throw preconditionFailed();
  }
}

function defined(body: Row): Row {
  return Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
}

// Handlers -----------------------------------------------------------------------------------------------

export const handlers = defineHandlers("Work", {
  "records.list": async ({ query }, { db }) => {
    const wanted = selectColumns(query.fields, RECORD_FIELDS, "id");
    const page = await listPage<Row>(
      liveRecords(db, parseArchived(query.archived)),
      { ...query, fields: wanted.filter((c) => !derivedField(c)).join(",") },
      { columns: RECORD_COLUMNS, key: "id", defaultOrder: ["created_at"] },
    );
    const data = await withVisibility(
      db,
      await withSidecars(db, page.data, wanted),
      wanted.includes("external_visibility"),
    );
    return ok({ data, next_cursor: page.next_cursor } as unknown as Components["RecordPage"]);
  },

  "records.get": async ({ params, query }, { db }) =>
    ok(await readRecord(db, params.id, query.fields)),

  "records.create": async ({ body }, context) => {
    const org = requireOrg(context).id;
    const { db } = context;
    const { data: node, error: nodeError } = await db
      .from("scope_nodes")
      .select("project_id")
      .eq("id", body.scope_node_id)
      .is("deleted_at", null)
      .maybeSingle();
    if (nodeError !== null) throw nodeError;
    if (node === null) {
      throw refused(
        "REFUSE",
        `No scope node with id ${body.scope_node_id} is visible to you.`,
        "record_scope_node_unknown",
      );
    }
    const { data, error } = await db
      .from("records")
      .insert({
        org_id: org,
        project_id: node.project_id,
        scope_node_id: body.scope_node_id,
        record_kind: body.record_kind,
        record_subtype: body.record_subtype ?? null,
        title: body.title,
        phase_code: body.phase_code,
        urid: body.urid ?? null,
        xyz: body.xyz,
        xyz_basis: await xyzBasis(db, body.urid, body.xyz),
        owner_party_id: body.owner_party_id ?? null,
        accountable_party_id: body.accountable_party_id ?? null,
        starts_at: body.starts_at ?? null,
        ends_at: body.ends_at ?? null,
        due_at: body.due_at ?? null,
      })
      .select("id")
      .single();
    if (error !== null) throw error;
    // A new record starts Proposed; Blocked and Deferred texts are written by a transition.
    if (body.blocker_text || body.replan_reason) {
      throw badRequest(
        "A new record starts Proposed; send blocker_text or replan_reason with a transition.",
      );
    }
    await setVisibility(db, org, data.id, body.external_visibility);
    return created(await readRecord(db, data.id));
  },

  "records.update": async ({ params, body, ifMatch }, context) => {
    const { db } = context;
    const { external_visibility, ...rest } = body;
    const patch = defined(rest as Row);
    if (patch["xyz"] !== undefined || patch["urid"] !== undefined) {
      const current = await readRecord(db, params.id, "id,urid,xyz");
      const urid = (patch["urid"] as string | undefined) ?? current.urid;
      const xyz = (patch["xyz"] as string | undefined) ?? current.xyz;
      patch["xyz_basis"] = await xyzBasis(db, urid, xyz);
    }
    if (Object.keys(patch).length > 0) {
      await guardedUpdate(db, "records", params.id, patch, ifMatch, () =>
        readRecord(db, params.id, "id"),
      );
    }
    if (external_visibility !== undefined) {
      await setVisibility(db, requireOrg(context).id, params.id, external_visibility);
    }
    return ok(await readRecord(db, params.id));
  },

  "records.delete": async ({ params }, { db }) => {
    const { data, error } = await db
      .from("records")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", params.id)
      .is("deleted_at", null)
      .select("id")
      .maybeSingle();
    if (error !== null) throw error;
    if (data === null) throw notFound(`No record with id ${params.id} is visible to you.`);
    return noContent();
  },

  "records.transition": async ({ params, body }, { db }) => {
    const current = await readRecord(db, params.id, "id,record_state");
    if (current.record_state !== body.expected_state) {
      throw conflict(
        `The record is ${current.record_state}, not ${body.expected_state}; read it again.`,
      );
    }
    const result = await transitionRecord(db, {
      recordId: params.id,
      expected: body.expected_state,
      next: body.to_state,
      reason: `Moved to ${body.to_state} through the API.`,
      blockerText: body.blocker_text ?? null,
      replanReason: body.replan_reason ?? null,
    });
    if (!result.ok) throw problemFor(result.error);
    return ok(await readRecord(db, params.id));
  },

  "records.duplicate": async ({ params }, context) => {
    const result = await duplicateRecord(context.db, {
      orgId: requireOrg(context).id,
      recordId: params.id,
      withChildren: true,
    });
    if (!result.ok) throw problemFor(result.error);
    return created(await readRecord(context.db, result.data.id));
  },

  "recordStateTransitions.list": async ({ query }, { db }) =>
    ok(
      await listPage<StateTransition>(
        aliasedSource(
          () => ({
            select: (c: string) =>
              db.from("record_state_transitions").select(c).not("from_state", "is", null),
          }),
          TRANSITION_ALIASES,
        ),
        query,
        { columns: TRANSITION_COLUMNS, key: "id", defaultOrder: ["transitioned_at"] },
      ),
    ),

  "recordStateTransitions.get": async ({ params, query }, { db }) => {
    const columns = selectColumns(query.fields, TRANSITION_COLUMNS, "id");
    const { data, error } = await db
      .from("record_state_transitions")
      .select(aliasSelect(columns, TRANSITION_ALIASES))
      .eq("id", params.id)
      .not("from_state", "is", null)
      .maybeSingle();
    if (error !== null) throw error;
    if (data === null)
      throw notFound(`No state transition with id ${params.id} is visible to you.`);
    return ok(data as unknown as StateTransition);
  },

  "recordChecklistItems.list": async ({ query }, { db }) => {
    const aliases = { done_by: "checked_by", done_at: "checked_at" } as const;
    const filter = { ...(query.filter ?? {}) };
    const done = filter["done"];
    delete filter["done"];
    const page = await listPage<Row>(
      aliasedSource(
        () => ({
          select: (c: string) => {
            let b = db.from("record_checklist_items").select(c).is("deleted_at", null);
            if (done?.eq === "true") b = b.not("checked_at", "is", null);
            if (done?.eq === "false") b = b.is("checked_at", null);
            return b;
          },
        }),
        aliases,
      ),
      {
        ...query,
        filter,
        fields:
          "id,org_id,created_at,created_by,updated_at,updated_by,record_id,position,label,done_by,done_at",
      },
      {
        columns: CHECKLIST_COLUMNS.filter((c) => c !== "done" && c !== "evidence_document_id"),
        key: "id",
        defaultOrder: ["position"],
      },
    );
    const wanted = selectColumns(query.fields, CHECKLIST_COLUMNS, "id");
    const data = page.data.map((row) => {
      const full: Row = { ...row, done: row["done_at"] !== null, evidence_document_id: null };
      return Object.fromEntries(wanted.map((c) => [c, full[c] ?? null]));
    });
    return ok({
      data,
      next_cursor: page.next_cursor,
    } as unknown as Components["RecordChecklistItemPage"]);
  },

  "recordChecklistItems.get": async ({ params }, { db }) =>
    ok(await readChecklistItem(db, params.id)),

  "recordChecklistItems.create": async ({ body }, context) => {
    const { data, error } = await context.db
      .from("record_checklist_items")
      .insert({
        org_id: requireOrg(context).id,
        record_id: body.record_id,
        position: body.position,
        label: body.label,
        checked_at: body.done ? new Date().toISOString() : null,
      })
      .select("id")
      .single();
    if (error !== null) throw error;
    return created(await readChecklistItem(context.db, data.id));
  },

  "recordChecklistItems.update": async ({ params, body, ifMatch }, { db }) => {
    const patch: Row = defined({ position: body.position, label: body.label });
    if (body.done !== undefined) patch["checked_at"] = body.done ? new Date().toISOString() : null;
    if (Object.keys(patch).length > 0) {
      await guardedUpdate(db, "record_checklist_items", params.id, patch, ifMatch, () =>
        readChecklistItem(db, params.id),
      );
    }
    return ok(await readChecklistItem(db, params.id));
  },

  "recordChecklistItems.delete": async ({ params }, { db }) => {
    const { data, error } = await db
      .from("record_checklist_items")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", params.id)
      .is("deleted_at", null)
      .select("id")
      .maybeSingle();
    if (error !== null) throw error;
    if (data === null) throw notFound(`No checklist item with id ${params.id} is visible to you.`);
    return noContent();
  },

  "recordWatchers.list": async ({ query }, { db }) =>
    ok(
      await listPage<Watcher>(
        { select: (c: string) => db.from("record_watchers").select(c).is("deleted_at", null) },
        query,
        { columns: WATCHER_COLUMNS, key: "id", defaultOrder: ["created_at"] },
      ),
    ),

  "recordWatchers.create": async ({ body }, context) => {
    const { data, error } = await context.db
      .from("record_watchers")
      .insert({
        org_id: requireOrg(context).id,
        record_id: body.record_id,
        person_id: body.person_id,
      })
      .select(WATCHER_COLUMNS.join(","))
      .single();
    if (error !== null) throw error;
    return created(data as unknown as Watcher);
  },

  "recordWatchers.delete": async ({ params }, { db }) => {
    const { data, error } = await db
      .from("record_watchers")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", params.id)
      .is("deleted_at", null)
      .select("id")
      .maybeSingle();
    if (error !== null) throw error;
    if (data === null) throw notFound(`No watcher with id ${params.id} is visible to you.`);
    return noContent();
  },

  "workOrders.list": async ({ query }, { db }) =>
    ok(
      await listPage<WorkOrder>(
        aliasedSource(
          () => ({
            select: (c: string) =>
              applyArchived(
                db.from("work_orders").select(c).is("deleted_at", null),
                parseArchived(query.archived),
              ),
          }),
          WORK_ORDER_ALIASES,
        ),
        query,
        { columns: WORK_ORDER_COLUMNS, key: "id", defaultOrder: ["created_at"] },
      ),
    ),

  "workOrders.get": async ({ params, query }, { db }) =>
    ok(await readWorkOrder(db, params.id, query.fields)),

  "workOrders.create": async ({ body }, context) => {
    const { data, error } = await context.db
      .from("work_orders")
      .insert({
        org_id: requireOrg(context).id,
        project_id: body.project_id,
        record_id: body.record_id ?? null,
        title: body.title,
        urid: body.urid ?? null,
        scheduled_ends_at: body.due_at ?? null,
        budget_minor: body.budget_minor ?? null,
        currency_code: body.currency,
      } as never)
      .select("id")
      .single();
    if (error !== null) throw error;
    return created(await readWorkOrder(context.db, (data as { id: string }).id));
  },

  "workOrders.update": async ({ params, body, ifMatch }, { db }) => {
    const patch = defined({
      record_id: body.record_id,
      title: body.title,
      urid: body.urid,
      scheduled_ends_at: body.due_at,
      budget_minor: body.budget_minor,
      currency_code: body.currency,
      location_text: body.location_text,
      scope_of_work: body.scope_of_work,
      scheduled_starts_at: body.scheduled_starts_at,
      estimated_hours: body.estimated_hours,
    });
    if (Object.keys(patch).length > 0) {
      await guardedUpdate(db, "work_orders", params.id, patch, ifMatch, () =>
        readWorkOrder(db, params.id, "id"),
      );
    }
    return ok(await readWorkOrder(db, params.id));
  },

  "workOrders.delete": async ({ params }, { db }) => {
    const { data, error } = await db
      .from("work_orders")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", params.id)
      .is("deleted_at", null)
      .select("id")
      .maybeSingle();
    if (error !== null) throw error;
    if (data === null) throw notFound(`No work order with id ${params.id} is visible to you.`);
    return noContent();
  },

  "workOrders.transition": async ({ params, body }, { db }) => {
    const current = await readWorkOrder(db, params.id, "id,work_order_state");
    if (current.work_order_state !== body.expected_state) {
      throw conflict(
        `The work order is ${current.work_order_state}, not ${body.expected_state}; read it again.`,
      );
    }
    const result = await transitionWorkOrder(db, {
      id: params.id,
      expected: body.expected_state,
      next: body.to_state,
      reason: body.reason ?? `Moved to ${body.to_state} through the API.`,
    });
    if (!result.ok) throw problemFor(result.error);
    return ok(await readWorkOrder(db, params.id));
  },

  "workOrderBids.list": async ({ query }, { db }) => {
    const filter = { ...(query.filter ?? {}) };
    delete filter["bid_state"];
    const page = await listPage<Row>(
      aliasedSource(
        () => ({
          select: (c: string) =>
            db
              .from("work_order_bids")
              .select(
                `${c},withdrawn_at,work_order:work_orders!work_order_bids_work_order_id_fkey(awarded_bid_id)`,
              )
              .is("deleted_at", null)
              .not("bidder_organization_id", "is", null),
        }),
        BID_ALIASES,
      ),
      { ...query, filter, fields: BID_COLUMNS.filter((c) => c !== "bid_state").join(",") },
      {
        columns: BID_COLUMNS.filter((c) => c !== "bid_state"),
        key: "id",
        defaultOrder: ["created_at"],
      },
    );
    const wanted = selectColumns(query.fields, BID_COLUMNS, "id");
    const data = page.data.map((row) => {
      const bid = toBid(row) as unknown as Row;
      return Object.fromEntries(wanted.map((c) => [c, bid[c] ?? null]));
    });
    return ok({ data, next_cursor: page.next_cursor } as unknown as Components["WorkOrderBidPage"]);
  },

  "workOrderBids.get": async ({ params }, { db }) => ok(await readBid(db, params.id)),

  "workOrderBids.create": async ({ body }, context) => {
    const { data, error } = await context.db
      .from("work_order_bids")
      .insert({
        org_id: requireOrg(context).id,
        work_order_id: body.work_order_id,
        bidder_organization_id: body.bidder_organization_id,
        amount_minor: body.amount_minor ?? null,
        currency_code: body.currency,
        note: body.notes ?? null,
      })
      .select("id")
      .single();
    if (error !== null) throw error;
    return created(await readBid(context.db, data.id));
  },

  "workOrderBids.update": async ({ params, body, ifMatch }, { db }) => {
    const patch = defined({
      amount_minor: body.amount_minor,
      currency_code: body.currency,
      note: body.notes,
    });
    if (Object.keys(patch).length > 0) {
      await guardedUpdate(db, "work_order_bids", params.id, patch, ifMatch, () =>
        readBid(db, params.id),
      );
    }
    return ok(await readBid(db, params.id));
  },

  "workOrderBids.award": async ({ params }, { db }) => {
    const bid = await readBid(db, params.id);
    const result = await awardWorkOrder(db, {
      id: bid.work_order_id,
      bidId: params.id,
      reason: "Awarded through the API.",
    });
    if (!result.ok) throw problemFor(result.error);
    return ok(await readBid(db, params.id));
  },

  // Replans (A04P): the history the replan transition writes; read only, the time is created_at.
  ...tableHandlers("Work", "recordReplans", { aliases: { replanned_at: "created_at" } }),

  // Bulk edit and field history (A106, migrations 1451 and 1452).
  "records.bulkPreview": async ({ body }, context) =>
    ok((await bulkEdit(context, "records", body, true)) as never),
  "records.bulkUpdate": async ({ body }, context) =>
    ok((await bulkEdit(context, "records", body, false)) as never),
  "records.fieldHistory": async ({ params, query }, context) =>
    ok((await fieldHistory(context, "app.records", params.id, query.limit)) as never),
});
