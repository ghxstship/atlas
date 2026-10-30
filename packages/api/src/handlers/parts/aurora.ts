/**
 * Aurora AI handlers (A25, RRR-39; Section 4.7, ADR 0020), spread into the Settings handler file (../settings.ts).
 *
 * Every feature runs through `runFeature` in @xos/ai with a store over the 0650 RPCs, so the
 * database authorizes and meters each request with the caller's own session (membership, the
 * aurora_ai plan feature, the Admin switch and aurora_requests_per_month, refused with XR001
 * plan_limit_exceeded) and logs the prompt and output redacted.
 *
 * The assistant, drafting and summaries read records only through this API's own handlers,
 * invoked in process with the caller's request context: the same row level security, the same
 * Restricted masking, so Aurora can never see more than the caller. What comes back is scrubbed of
 * Restricted columns, masked values and excluded tables (app.ai_never_send) before any prompt.
 *
 * A run of show or risk assessment (P6) is drafted only into an empty list: the database answers
 * whether it is empty (app.drafted_list_is_empty) before any model call or metering, the draft reads
 * the list's own records through `listDraftItems` (which the preview shares, so the panel lists
 * exactly what is sent), and `aurora.applyDraft` writes the kept lines in one transaction
 * (app.apply_drafted_list), again only while the list is empty.
 *
 * The model client is the Anthropic client unless a test passes another; the API key stays in the
 * server environment, read only by the SDK.
 */
import type { ModelClient, ModelConfig, PublicApi, ApiCollection, AuroraResult } from "@xos/ai";
import {
  askAssistant,
  buildFilter,
  draft,
  draftList,
  isListDraftKind,
  extractDocument,
  loadModelConfig,
  NeverSendList,
  scrubRecord,
  summarize,
  suggestCatalogBinding,
  suggestColumnMappings,
  type AuroraContext,
  type FilterCollection,
  type CatalogField,
  type ListDraftKind,
  type VocabularyTerm,
} from "@xos/ai";
import {
  applyDraftedList,
  createAuroraStore,
  draftedListIsEmpty,
  getAiAllowance,
  listAiNeverSend,
  listEnabledAiFeatures,
  saveAiSettings,
  transitionAiSuggestion,
} from "@xos/data/ai";
import { todayIn } from "@xos/data/calendar";
import { readOrgTimeZone } from "@xos/data/settings";
import { z } from "zod";
import type { ResourceSpec } from "../../catalog/types.ts";
import {
  ApiProblem,
  fromDatabaseError,
  isDatabaseError,
  notFound,
  refused,
} from "../../problem.ts";
import type { RequestContext } from "../../runtime/context.ts";
import { requireOrg, requirePerson } from "../../runtime/context.ts";
import {
  ok,
  type ErasedHandler,
  type ErasedRequest,
  type ErasedResult,
} from "../../runtime/handler.ts";
import { from, run, tableResource, unwrap, type Row } from "../support/table.ts";

export interface AuroraDeps {
  /** The model client for one request. */
  readonly model: () => ModelClient | Promise<ModelClient>;
  readonly config: () => ModelConfig;
  /**
   * Today on the org's calendar, ISO 8601, for relative dates ("overdue", "this month"). Never the
   * UTC date, which is a day ahead every evening in the Americas (A71, A95).
   */
  readonly today: (context: RequestContext) => string | Promise<string>;
  /** The org's time zone, named in the plain-language prompt beside today's date. */
  readonly timeZone: (context: RequestContext) => string | Promise<string>;
  /** The API Aurora reads through; defaults to this API's handlers, in process. */
  readonly readApi?: (context: RequestContext) => PublicApi;
  /** Every resource of the contract; defaults to the resolved catalog. */
  readonly catalog?: () => Promise<readonly ResourceSpec[]>;
}

async function anthropicClient(): Promise<ModelClient> {
  const { AnthropicModelClient, anthropicConfigured } = await import("@xos/ai/anthropic");
  if (!anthropicConfigured()) {
    throw refused(
      "REFUSE",
      "Aurora AI is not configured on this deployment. Ask your platform operator to connect the model provider.",
      "aurora_not_configured",
    );
  }
  return new AnthropicModelClient();
}

/** The org's time zone, read once per request (locale.time_zone, UTC when unset). */
const zones = new WeakMap<RequestContext, Promise<string>>();
function orgZone(context: RequestContext): Promise<string> {
  let zone = zones.get(context);
  if (zone === undefined) {
    zone = readOrgTimeZone(context.db, requireOrg(context).id);
    zones.set(context, zone);
  }
  return zone;
}

const DEFAULT_DEPS: AuroraDeps = {
  model: anthropicClient,
  config: () => loadModelConfig(),
  today: async (context) => todayIn(await orgZone(context)),
  timeZone: orgZone,
};

async function resolvedCatalog(): Promise<readonly ResourceSpec[]> {
  const { catalog } = await import("../../app.ts");
  return catalog;
}

/** Tables Aurora never reads through the assistant, whatever the never-send list says. */
const OWN_TABLES = new Set([
  "app.ai_settings",
  "app.ai_requests",
  "app.ai_usage",
  "app.ai_suggestions",
  "app.ai_suggestion_fields",
]);

/** Readable collections: list operations over a table, minus excluded and Aurora's own tables. */
export function readableCollections(
  specs: readonly ResourceSpec[],
  neverSend: NeverSendList,
): ApiCollection[] {
  return specs
    .filter((s) => s.verbs.includes("list") && !s.path.includes("{"))
    .filter((s) => !OWN_TABLES.has(s.def.table) && !neverSend.excludesTable(s.def.table))
    .map((s) => ({ path: s.path.slice(1), table: s.def.table, description: s.def.description }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Create and update operations the assistant may propose for confirmation. */
export function proposableOperations(specs: readonly ResourceSpec[]): string[] {
  return specs
    .flatMap((s) =>
      (["create", "update"] as const).filter((v) => s.verbs.includes(v)).map((v) => `${s.op}.${v}`),
    )
    .filter((id) => !id.startsWith("ai") && !id.startsWith("aurora"))
    .sort();
}

function statusOf(error: unknown): number {
  if (error instanceof ApiProblem) return error.body.status;
  if (isDatabaseError(error)) return fromDatabaseError(error)?.body.status ?? 500;
  return 500;
}

/**
 * This API's list and get handlers, called in process as the caller. `/<collection>/<id>/<segment>`
 * reaches the resource's GET item query of that segment, such as a project's gate readiness.
 */
export function inProcessApi(context: RequestContext, specs: readonly ResourceSpec[]): PublicApi {
  return {
    async get(path, query) {
      const [, collection, id, segment] = path.split("/");
      const spec = specs.find((s) => s.path === `/${collection ?? ""}`);
      if (!spec) return { status: 404, body: {} };
      const itemQuery =
        id && segment
          ? spec.actions.find(
              (a) => a.scope === "item" && a.method === "get" && a.segment === segment,
            )
          : undefined;
      if (segment && !itemQuery) return { status: 404, body: {} };
      const operationId = `${spec.op}.${itemQuery ? itemQuery.verb : id ? "get" : "list"}`;
      const { MODULE_HANDLERS } = await import("../index.generated.ts");
      const handler = MODULE_HANDLERS.map((m) => m.handlers[operationId]).find(
        (h): h is ErasedHandler => h !== undefined,
      );
      if (!handler)
        return { status: 404, body: { detail: `${operationId} is not available yet.` } };
      const filter: Record<string, Record<string, string>> = {};
      let limit = 10;
      for (const [key, value] of Object.entries(query)) {
        const match = /^filter\[([^\][]+)\]\[([^\][]+)\]$/.exec(key);
        if (match)
          filter[match[1] as string] = {
            ...filter[match[1] as string],
            [match[2] as string]: value,
          };
        else if (key === "limit") limit = Number(value);
      }
      const request: ErasedRequest = {
        operationId,
        params: id ? { [spec.keyParam]: id, id } : {},
        query: id ? {} : { limit, ...(Object.keys(filter).length > 0 ? { filter } : {}) },
        body: undefined,
        idempotencyKey: undefined,
        ifMatch: undefined,
      };
      try {
        const result: ErasedResult = await handler(request, context);
        return { status: result.status, body: result.body };
      } catch (error) {
        const status = statusOf(error);
        if (status === 500) throw error;
        return { status, body: error instanceof ApiProblem ? error.body : {} };
      }
    },
  };
}

function unwrapSchema(schema: z.ZodType): z.ZodType {
  let current = schema;
  while (current instanceof z.ZodNullable || current instanceof z.ZodOptional) {
    current = current.unwrap() as z.ZodType;
  }
  return current;
}

/** The filterable fields of a collection, read from its contract read shape. */
export function filterFields(spec: ResourceSpec): CatalogField[] {
  const out: CatalogField[] = [];
  for (const [name, raw] of Object.entries(spec.def.read.shape as Record<string, z.ZodType>)) {
    const schema = unwrapSchema(raw);
    if (schema instanceof z.ZodEnum) {
      out.push({ name, type: "enum", values: schema.options.map(String) });
    } else if (schema instanceof z.ZodNumber) {
      out.push({ name, type: "number" });
    } else if (schema instanceof z.ZodBoolean) {
      out.push({ name, type: "boolean" });
    } else if (schema instanceof z.ZodString) {
      const format = (schema as unknown as { format?: string | null }).format ?? null;
      out.push({
        name,
        type:
          format === "date" || format === "datetime"
            ? "date"
            : format === "uuid"
              ? "uuid"
              : "string",
      });
    }
  }
  return out;
}

/** The API answer of an Aurora result. A refusal becomes a 422 problem naming its rule. */
export function toResponse<T>(result: AuroraResult<T>) {
  if (result.kind === "refused") throw refused("REFUSE", result.message, result.rule);
  const base = {
    ai_generated: true as const,
    request_id: result.kind === "failed" ? result.requestId : result.requestId,
    model: result.kind === "failed" ? null : result.model,
    missing: result.kind === "no-answer" ? result.missing : null,
    failure_code: result.kind === "failed" ? result.code : null,
  };
  if (result.kind === "answer") {
    return ok({
      ...base,
      outcome: "answer" as const,
      answer: result.value as unknown,
      suggestions: result.proposals.map((p) => ({
        suggestion_id: p.suggestionId,
        operation_id: p.operationId,
        summary: p.summary,
      })),
    });
  }
  return ok({
    ...base,
    outcome: result.kind === "no-answer" ? ("no_answer" as const) : ("failed" as const),
    answer: null,
    suggestions: [],
  });
}

/** Reads the records named in a request through the in-process API, scrubbed later by the feature. */
async function readItems(
  api: PublicApi,
  specs: readonly ResourceSpec[],
  items: readonly { collection: string; id: string }[],
): Promise<{ id: string; table: string; data: Row }[]> {
  const out: { id: string; table: string; data: Row }[] = [];
  for (const item of items) {
    const spec = specs.find((s) => s.path === `/${item.collection}`);
    if (!spec) continue;
    const response = await api.get(`/${item.collection}/${item.id}`, {});
    if (response.status === 200 && typeof response.body === "object" && response.body !== null) {
      out.push({ id: item.id, table: spec.def.table, data: response.body as Row });
    }
  }
  return out;
}

// Drafted lists (P6) ---------------------------------------------------------------------------

/** The collection and table of the list each kind fills. */
const LIST_TARGETS: Readonly<Record<ListDraftKind, { collection: string; table: string }>> = {
  run_of_show: { collection: "run-of-show", table: "app.run_of_show" },
  risk_assessment: { collection: "projects", table: "app.projects" },
};

/** The refusal sentence for a list that already has entries, as app.apply_drafted_list words it. */
const NOT_EMPTY: Readonly<Record<ListDraftKind, string>> = {
  run_of_show: "This running order already has cues. Aurora only drafts into an empty list.",
  risk_assessment:
    "This list already has entries, including archived or canceled ones. Aurora only drafts into an empty list.",
};

/** The list a drafted run of show or risk assessment fills, refused when absent or of another kind. */
export function listTarget(
  kind: ListDraftKind,
  target: { collection: string; id: string } | undefined,
): { collection: string; id: string } {
  if (!target) {
    throw refused(
      "REFUSE",
      "Name the list to draft into: a running order for a run of show, a project for a risk assessment.",
      "aurora_draft_target_required",
    );
  }
  if (target.collection !== LIST_TARGETS[kind].collection) {
    throw refused(
      "REFUSE",
      `A ${kind === "run_of_show" ? "run of show" : "risk assessment"} is drafted into ${LIST_TARGETS[kind].collection}, not ${target.collection}.`,
      "aurora_draft_target_mismatch",
    );
  }
  return target;
}

export interface DraftItem {
  readonly collection: string;
  readonly id: string;
  readonly table: string;
  readonly data: Row;
}

/**
 * Everything a drafted list sends, read with the caller's permissions: the list's record (the
 * running order, or the project), for a run of show its project and its schedule record (usually the
 * Event, whose subtype is the event type), for a risk assessment up to 10 Event records of the
 * project, then the context the request names (at most 20), each record once. `aurora.draft` and
 * `aurora.preview` both read through it, so the preview lists exactly what is sent.
 */
export async function listDraftItems(
  api: PublicApi,
  specs: readonly ResourceSpec[],
  kind: ListDraftKind,
  target: { collection: string; id: string },
  context: readonly { collection: string; id: string }[],
): Promise<DraftItem[]> {
  const out: DraftItem[] = [];
  const add = (collection: string, id: string, data: unknown) => {
    const spec = specs.find((s) => s.path === `/${collection}`);
    if (!spec || typeof data !== "object" || data === null) return;
    if (out.some((r) => r.collection === collection && r.id === id)) return;
    out.push({ collection, id, table: spec.def.table, data: data as Row });
  };
  const read = async (collection: string, id: unknown) => {
    if (typeof id !== "string") return null;
    const response = await api.get(`/${collection}/${id}`, {});
    if (response.status !== 200) return null;
    add(collection, id, response.body);
    return response.body as Row;
  };
  const listed = await read(target.collection, target.id);
  if (kind === "run_of_show" && listed) {
    await read("projects", listed["project_id"]);
    await read("records", listed["record_id"]);
  }
  if (kind === "risk_assessment" && listed) {
    const events = await api.get("/records", {
      "filter[project_id][eq]": target.id,
      "filter[record_kind][eq]": "Event",
      limit: "10",
    });
    const rows = (events.body as { data?: unknown } | null)?.data;
    if (events.status === 200 && Array.isArray(rows)) {
      for (const row of rows as Row[]) {
        if (typeof row["id"] === "string") add("records", row["id"], row);
      }
    }
  }
  for (const item of context.slice(0, 20)) await read(item.collection, item.id);
  return out;
}

/** The canon Risk subtypes, in canon order, read as the caller (xpms is readable by every member). */
async function readRiskCategories(context: RequestContext): Promise<string[]> {
  const rows = await run<{ record_subtype: string }[]>(
    from(context.db, "dim_record_subtype", "xpms")
      .select("record_subtype, ordinal")
      .eq("record_kind", "Risk")
      .order("ordinal", { ascending: true }),
  );
  return rows.map((r) => String(r.record_subtype));
}

type SummaryKind = "record_activity" | "project_week" | "gate_readiness";

/**
 * What a summary reads: the named items, and for a project's gate readiness the criteria of its next
 * gate with whether evidence satisfies each (projects.gateReadiness), cited by the project's id.
 */
async function summaryItems(
  api: PublicApi,
  specs: readonly ResourceSpec[],
  body: {
    kind?: SummaryKind | undefined;
    subject_collection?: string | undefined;
    subject_id?: string | undefined;
    items: readonly { collection: string; id: string }[];
  },
): Promise<{ id: string; table: string; data: Row }[]> {
  const items = await readItems(api, specs, body.items);
  if (body.kind === "gate_readiness" && body.subject_collection === "projects" && body.subject_id) {
    const readiness = await api.get(`/projects/${body.subject_id}/gate-readiness`, {});
    const rows = (readiness.body as { data?: unknown } | null)?.data;
    if (readiness.status === 200 && Array.isArray(rows)) {
      items.push({
        id: body.subject_id,
        table: "app.gate_criteria_status",
        data: { gate_readiness: rows as unknown[] },
      });
    }
  }
  return items;
}

/** The org's verbiage library, read as the caller (knowledge.verbiage.read); none when unreadable. */
async function readVocabulary(api: PublicApi): Promise<VocabularyTerm[]> {
  const response = await api.get("/verbiage-terms", { limit: "100" });
  const rows = (response.body as { data?: unknown } | null)?.data;
  if (response.status !== 200 || !Array.isArray(rows)) return [];
  return (rows as Row[]).flatMap((r) =>
    typeof r["term"] === "string"
      ? [
          {
            term: r["term"],
            casingRule: typeof r["casing_rule"] === "string" ? r["casing_rule"] : "",
            definition: typeof r["definition"] === "string" ? r["definition"] : "",
          },
        ]
      : [],
  );
}

/** Each named record as the model would see it: the fields sent, the fields withheld, the values. */
export function previewRecords(
  named: readonly { collection: string; id: string }[],
  read: readonly { id: string; table: string; data: Row }[],
  specs: readonly ResourceSpec[],
  neverSend: NeverSendList,
) {
  // The gate readiness a gate summary adds carries the project's id; it never stands in for the
  // project record the request names.
  const byId = new Map(
    read.filter((r) => r.table !== "app.gate_criteria_status").map((r) => [r.id, r]),
  );
  const preview = (
    collection: string,
    record: { id: string; table: string; data: Row } | undefined,
  ) => {
    const scrubbed = record ? scrubRecord(record.table, record.data, neverSend) : null;
    if (!record || scrubbed === null) {
      return {
        collection,
        id: record?.id ?? "",
        sent: false,
        fields: [],
        withheld: [],
        data: null,
      };
    }
    const fields = Object.keys(scrubbed);
    const withheld = Object.keys(record.data).filter((k) => k !== "is_masked" && !(k in scrubbed));
    return { collection, id: record.id, sent: true, fields, withheld, data: scrubbed };
  };
  const out = named.map((item) => ({
    ...preview(item.collection, byId.get(item.id)),
    id: item.id,
  }));
  // The gate readiness a gate summary adds is cited by the project's id but is its own record.
  for (const extra of read.filter((r) => r.table === "app.gate_criteria_status")) {
    const spec = specs.find((s) => s.def.table === "app.projects");
    out.push({ ...preview(spec ? spec.path.slice(1) : "projects", extra), id: extra.id });
  }
  return out;
}

/** A page's own filters for `aurora.filter`, less any that names a Restricted column of the table. */
export function pageFilterFields(
  fields: readonly {
    name: string;
    type: "string" | "number" | "date" | "boolean" | "enum";
    values?: string[] | undefined;
    description?: string | undefined;
    ops?: CatalogField["ops"] | undefined;
  }[],
  table: string,
  neverSend: NeverSendList,
): CatalogField[] {
  return fields
    .filter((f) => !neverSend.excludesColumn(table, f.name))
    .map((f) => ({
      name: f.name,
      type: f.type,
      ...(f.values ? { values: f.values } : {}),
      ...(f.description ? { description: f.description } : {}),
      ...(f.ops ? { ops: f.ops } : {}),
    }));
}

const suggestions = tableResource("aiSuggestions", {
  derived: ["proposed_fields"],
  toContract: async (row, context) => {
    const fieldRows = await run<Row[]>(
      from(context.db, "ai_suggestion_fields")
        .select(
          "field_path, proposed_value, confidence, refusal, missing, source_excerpt, position",
        )
        .eq("suggestion_id", String(row["id"]))
        .is("deleted_at", null)
        .order("position", { ascending: true }),
    );
    return {
      ...row,
      proposed_fields: fieldRows.map((f) => ({
        field_path: f["field_path"],
        proposed_value: f["proposed_value"] ?? null,
        confidence: f["confidence"] === null ? null : Number(f["confidence"]),
        refusal: f["refusal"] ?? null,
        missing: f["missing"] ?? null,
        source_excerpt: f["source_excerpt"] ?? null,
        provenance: "agent",
      })),
    };
  },
});
const requests = tableResource("aiRequests", { softDelete: true });
const usage = tableResource("aiUsage");
const settings = tableResource("aiSettings");

type Transition = {
  next: "Confirmed" | "Rejected" | "Applied" | "Proposed";
  expected: "Proposed" | "Confirmed";
};
const TRANSITIONS: Readonly<Record<string, Transition>> = {
  reject: { expected: "Proposed", next: "Rejected" },
  apply: { expected: "Confirmed", next: "Applied" },
  reopen: { expected: "Confirmed", next: "Proposed" },
};

/** The Aurora handler set, keyed by operationId, for the Settings module file to spread. */
export function auroraHandlers(
  overrides: Partial<AuroraDeps> = {},
): Readonly<Record<string, ErasedHandler>> {
  const deps: AuroraDeps = { ...DEFAULT_DEPS, ...overrides };
  const catalogOf = deps.catalog ?? resolvedCatalog;

  /** What reading for Aurora needs, without a model: a preview calls none. */
  const readSetup = async (context: RequestContext) => {
    requireOrg(context);
    requirePerson(context);
    const neverSend = new NeverSendList(unwrap(await listAiNeverSend(context.db)));
    const specs = await catalogOf();
    const api = deps.readApi ? deps.readApi(context) : inProcessApi(context, specs);
    return { neverSend, specs, api };
  };

  /** The request context a feature runs with: the model, the store over the caller's session. */
  const modelSetup = async (context: RequestContext): Promise<AuroraContext> => ({
    orgId: requireOrg(context).id,
    client: await deps.model(),
    store: createAuroraStore(context.db),
    config: deps.config(),
    today: await deps.today(context),
  });

  const setup = async (context: RequestContext) => {
    const read = await readSetup(context);
    return { ctx: await modelSetup(context), ...read };
  };

  /** A run of show or risk assessment, drafted only into an empty list (P6). */
  const draftIntoList = async (
    context: RequestContext,
    kind: ListDraftKind,
    body: {
      instructions: string;
      target?: { collection: string; id: string };
      context?: { collection: string; id: string }[];
      verbiage?: { term: string; preferred: string }[];
    },
  ) => {
    const target = listTarget(kind, body.target);
    const { neverSend, specs, api } = await readSetup(context);
    // Before any model call or metering: a caller who may not write to the list gets 404, and a
    // list with entries (also ones the caller cannot see) is refused.
    if (!unwrap(await draftedListIsEmpty(context.db, kind, target.id))) {
      throw refused("REFUSE", NOT_EMPTY[kind], "aurora_draft_list_not_empty");
    }
    const [records, vocabulary, categories] = await Promise.all([
      listDraftItems(api, specs, kind, target, body.context ?? []),
      readVocabulary(api),
      kind === "risk_assessment" ? readRiskCategories(context) : Promise.resolve([]),
    ]);
    const listed = records.find((r) => r.collection === target.collection && r.id === target.id);
    if (!listed) throw notFound("The list to draft into is not visible to you.");
    let runOfShow: { runOfShowId: string; showDate: string; timeZone: string } | undefined;
    if (kind === "run_of_show") {
      const project = records.find(
        (r) => r.collection === "projects" && r.id === listed.data["project_id"],
      );
      const zone = project?.data["time_zone"];
      runOfShow = {
        runOfShowId: target.id,
        showDate: String(listed.data["show_date"]),
        timeZone: typeof zone === "string" && zone !== "" ? zone : await deps.timeZone(context),
      };
    }
    const result = await draftList(await modelSetup(context), {
      kind,
      instructions: body.instructions,
      target: { table: LIST_TARGETS[kind].table, id: target.id },
      context: records,
      verbiage: body.verbiage ?? [],
      vocabulary,
      neverSend,
      ...(runOfShow ? { runOfShow } : {}),
      ...(kind === "risk_assessment" ? { risks: { projectId: target.id, categories } } : {}),
    });
    if (result.kind !== "answer") return toResponse(result);
    // Each line carries the suggestion that holds it; proposals come in line order.
    const items = (result.value.items as readonly object[]).map((item, i) => ({
      suggestion_id: result.proposals[i]?.suggestionId ?? null,
      ...item,
    }));
    return toResponse({
      ...result,
      value: {
        ...result.value,
        items,
        ...(kind === "risk_assessment" ? { categories } : {}),
      },
    });
  };

  const handlers: Record<string, ErasedHandler> = {
    ...settings.handlers,
    ...requests.handlers,
    ...usage.handlers,
    ...suggestions.handlers,

    "aiSettings.save": async (request, context) => {
      const org = requireOrg(context);
      const body = request.body as Record<string, boolean>;
      unwrap(
        await saveAiSettings(context.db, org.id, {
          assistant: body["assistant_enabled"] === true,
          plain_language: body["plain_language_enabled"] === true,
          extraction: body["extraction_enabled"] === true,
          drafting: body["drafting_enabled"] === true,
          summaries: body["summaries_enabled"] === true,
          mapping: body["mapping_enabled"] === true,
        }),
      );
      const page = await settings.list(context, { limit: 1 });
      const row = page.data[0];
      if (!row) throw refused("REFUSE", "The switches were not saved.", "ai_settings_not_saved");
      return ok(row);
    },

    "aurora.status": async (_request, context) => {
      const org = requireOrg(context);
      const [features, allowance] = await Promise.all([
        listEnabledAiFeatures(context.db, org.id),
        getAiAllowance(context.db, org.id),
      ]);
      const a = unwrap(allowance);
      return ok({
        enabled_features: [...unwrap(features)],
        used: a.used,
        allowance: a.allowance,
        plan_includes_aurora: a.planIncludesAurora,
      });
    },

    "aurora.ask": async (request, context) => {
      const body = request.body as {
        question: string;
        history?: { question: string; answer: string }[];
      };
      const { ctx, neverSend, specs, api } = await setup(context);
      return toResponse(
        await askAssistant(ctx, {
          question: body.question,
          history: body.history ?? [],
          collections: readableCollections(specs, neverSend),
          writableOperations: proposableOperations(specs),
          api,
          neverSend,
        }),
      );
    },

    "aurora.filter": async (request, context) => {
      const body = request.body as {
        sentence: string;
        collections: string[];
        time_zone: string;
        fields?: Parameters<typeof pageFilterFields>[0];
      };
      const { ctx, neverSend, specs } = await setup(context);
      const page = body.fields;
      // A page's own filters stand in for the first collection's API fields (A95).
      const catalog: FilterCollection[] = readableCollections(specs, neverSend)
        .filter((c) => (page ? c.path === body.collections[0] : body.collections.includes(c.path)))
        .map((c) => {
          const spec = specs.find((s) => s.path === `/${c.path}`) as ResourceSpec;
          return {
            collection: c.path,
            fields: page
              ? pageFilterFields(page, c.table, neverSend)
              : filterFields(spec).filter((f) => !neverSend.excludesColumn(c.table, f.name)),
          };
        });
      return toResponse(
        await buildFilter(ctx, {
          sentence: body.sentence,
          catalog,
          timeZone: await deps.timeZone(context),
        }),
      );
    },

    "aurora.extract": async (request, context) => {
      const body = request.body as {
        kind: "rider" | "insurance_certificate" | "invoice" | "receipt" | "quote";
        document_id?: string | null;
        media_type: "application/pdf" | "text/plain" | "image/png" | "image/jpeg" | "image/webp";
        content_base64: string;
        file_name: string;
      };
      const { ctx } = await setup(context);
      const data =
        body.media_type === "text/plain"
          ? Buffer.from(body.content_base64, "base64").toString("utf8")
          : body.content_base64;
      return toResponse(
        await extractDocument(ctx, {
          kind: body.kind,
          document: { type: "document", mediaType: body.media_type, data },
          fileName: body.file_name,
          subject: body.document_id ? { table: "app.documents", id: body.document_id } : null,
        }),
      );
    },

    "aurora.draft": async (request, context) => {
      const body = request.body as {
        kind:
          | "sop"
          | "advance_packet"
          | "email"
          | "day_sheet"
          | "change_order_description"
          | ListDraftKind;
        instructions: string;
        target?: { collection: string; id: string };
        context?: { collection: string; id: string }[];
        verbiage?: { term: string; preferred: string }[];
      };
      if (isListDraftKind(body.kind)) return draftIntoList(context, body.kind, body);
      const kind = body.kind;
      const { ctx, neverSend, specs, api } = await setup(context);
      const [records, vocabulary] = await Promise.all([
        readItems(api, specs, body.context ?? []),
        readVocabulary(api),
      ]);
      return toResponse(
        await draft(ctx, {
          kind,
          instructions: body.instructions,
          context: records,
          verbiage: body.verbiage ?? [],
          vocabulary,
          neverSend,
          subject: null,
        }),
      );
    },

    "aurora.preview": async (request, context) => {
      const body = request.body as {
        feature: "drafting" | "summaries";
        draft_kind?: ListDraftKind;
        target?: { collection: string; id: string };
        kind?: SummaryKind;
        subject_collection?: string;
        subject_id?: string;
        items: { collection: string; id: string }[];
      };
      const { neverSend, specs, api } = await readSetup(context);
      const drafting = body.feature === "drafting";
      if (drafting && body.draft_kind) {
        // Exactly what the drafted list reads and sends (P6, S4.7, A95).
        const kind = body.draft_kind;
        const target = listTarget(kind, body.target);
        const [read, vocabulary, categories] = await Promise.all([
          listDraftItems(api, specs, kind, target, body.items),
          readVocabulary(api),
          kind === "risk_assessment" ? readRiskCategories(context) : Promise.resolve(null),
        ]);
        return ok({
          records: previewRecords(
            read.map((r) => ({ collection: r.collection, id: r.id })),
            read,
            specs,
            neverSend,
          ),
          vocabulary_terms: vocabulary.length,
          ...(categories ? { categories } : {}),
        });
      }
      const [read, vocabulary] = await Promise.all([
        drafting ? readItems(api, specs, body.items) : summaryItems(api, specs, body),
        drafting ? readVocabulary(api) : Promise.resolve([]),
      ]);
      return ok({
        records: previewRecords(body.items, read, specs, neverSend),
        vocabulary_terms: vocabulary.length,
      });
    },

    "aurora.summarize": async (request, context) => {
      const body = request.body as {
        kind: SummaryKind;
        subject_collection: string;
        subject_id: string;
        items: { collection: string; id: string }[];
      };
      const { ctx, neverSend, specs, api } = await setup(context);
      const subjectSpec = specs.find((s) => s.path === `/${body.subject_collection}`);
      const items = await summaryItems(api, specs, body);
      return toResponse(
        await summarize(ctx, {
          kind: body.kind,
          subject: { table: subjectSpec?.def.table ?? "app.projects", id: body.subject_id },
          items,
          neverSend,
        }),
      );
    },

    "aurora.applyDraft": async (request, context) => {
      requireOrg(context);
      requirePerson(context);
      const body = request.body as {
        request_id: string;
        items: { suggestion_id: string; values?: Record<string, unknown> }[];
      };
      return ok(
        unwrap(
          await applyDraftedList(context.db, { requestId: body.request_id, items: body.items }),
        ),
      );
    },

    "aurora.mapColumns": async (request, context) => {
      const body = request.body as {
        collection: string;
        columns: { header: string; samples: string[] }[];
        fields: { name: string; description: string }[];
      };
      const { ctx } = await setup(context);
      return toResponse(await suggestColumnMappings(ctx, body));
    },

    "aurora.bindCode": async (request, context) => {
      const body = request.body as {
        code: string;
        description: string | null;
        candidates: { element_id: string; name: string; urid: string }[];
      };
      const { ctx } = await setup(context);
      return toResponse(
        await suggestCatalogBinding(ctx, {
          code: body.code,
          description: body.description,
          candidates: body.candidates.map((c) => ({
            elementId: c.element_id,
            name: c.name,
            urid: c.urid,
          })),
        }),
      );
    },
  };

  for (const [verb, move] of Object.entries(TRANSITIONS)) {
    handlers[`aiSuggestions.${verb}`] = async (request, context) => {
      const id = String(request.params["id"]);
      const body = request.body as { reason: string; applied_id?: string };
      await suggestions.read(context, id, ["id"]);
      unwrap(
        await transitionAiSuggestion(context.db, {
          id,
          expected: move.expected,
          next: move.next,
          reason: body.reason,
          ...(move.next === "Applied" && body.applied_id ? { appliedId: body.applied_id } : {}),
        }),
      );
      return ok(await suggestions.read(context, id));
    };
  }
  handlers["aiSuggestions.confirm"] = async (request, context) => {
    const id = String(request.params["id"]);
    const body = request.body as { reason: string; values?: Record<string, unknown> };
    const current = await suggestions.read(context, id);
    unwrap(
      await transitionAiSuggestion(context.db, {
        id,
        expected: "Proposed",
        next: "Confirmed",
        reason: body.reason,
      }),
    );
    const written = await performSuggestion(context, current, body.values ?? {});
    if (written.ok) {
      unwrap(
        await transitionAiSuggestion(context.db, {
          id,
          expected: "Confirmed",
          next: "Applied",
          reason: "Written by " + String(current["operation_id"]) + ".",
          appliedId: written.id,
        }),
      );
      return ok(await suggestions.read(context, id));
    }
    unwrap(
      await transitionAiSuggestion(context.db, {
        id,
        expected: "Confirmed",
        next: "Proposed",
        reason: ("The API refused the write: " + written.detail).slice(0, 500),
      }),
    );
    throw refused("REFUSE", written.detail, written.rule);
  };
  return handlers;
}

/** Turns proposed fields into a request body; dotted paths become nested objects. */
export function bodyFromFields(
  fields: readonly { field_path: unknown; proposed_value: unknown; refusal: unknown }[],
  values: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const put = (path: string, value: unknown) => {
    const parts = path.split(".");
    let node = body;
    for (const part of parts.slice(0, -1)) {
      const next = node[part];
      node[part] = typeof next === "object" && next !== null ? next : {};
      node = node[part] as Record<string, unknown>;
    }
    node[parts[parts.length - 1] as string] = value;
  };
  for (const f of fields) {
    if (f.refusal === null && typeof f.field_path === "string") put(f.field_path, f.proposed_value);
  }
  for (const [path, value] of Object.entries(values)) put(path, value);
  return body;
}

/** Performs a confirmed suggestion's operation in process as the caller. */
async function performSuggestion(
  context: RequestContext,
  suggestion: Row,
  values: Readonly<Record<string, unknown>>,
): Promise<{ ok: true; id: string } | { ok: false; detail: string; rule: string }> {
  const operationId = String(suggestion["operation_id"]);
  const { MODULE_HANDLERS } = await import("../index.generated.ts");
  const handler = MODULE_HANDLERS.map((m) => m.handlers[operationId]).find(
    (h): h is ErasedHandler => h !== undefined,
  );
  if (!handler) {
    return {
      ok: false,
      detail: operationId + " is not available in this API yet, so nothing was written.",
      rule: "ai_suggestion_operation_unavailable",
    };
  }
  const target = suggestion["target_id"];
  const fields = (suggestion["proposed_fields"] ?? []) as {
    field_path: unknown;
    proposed_value: unknown;
    refusal: unknown;
  }[];
  try {
    const result = await handler(
      {
        operationId,
        params: typeof target === "string" ? { id: target } : {},
        query: {},
        body: bodyFromFields(fields, values),
        idempotencyKey: "aurora-" + String(suggestion["id"]),
        ifMatch: typeof target === "string" ? "*" : undefined,
      },
      context,
    );
    const written = (result.body as { id?: unknown } | null)?.id;
    const id = typeof written === "string" ? written : typeof target === "string" ? target : null;
    if (id === null) {
      return {
        ok: false,
        detail: operationId + " returned no record id.",
        rule: "ai_suggestion_no_record",
      };
    }
    return { ok: true, id };
  } catch (error) {
    const problem =
      error instanceof ApiProblem
        ? error
        : isDatabaseError(error)
          ? fromDatabaseError(error)
          : undefined;
    if (!problem || problem.body.status >= 500) throw error;
    const rule = (problem.body as { rule?: unknown }).rule;
    return {
      ok: false,
      detail: problem.body.detail ?? problem.body.title,
      rule: typeof rule === "string" ? rule : "ai_suggestion_write_refused",
    };
  }
}
