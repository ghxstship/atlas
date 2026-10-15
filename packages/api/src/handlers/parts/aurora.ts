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
 * The model client is the Anthropic client unless a test passes another; the API key stays in the
 * server environment, read only by the SDK.
 */
import type { ModelClient, ModelConfig, PublicApi, ApiCollection, AuroraResult } from "@xos/ai";
import {
  askAssistant,
  buildFilter,
  draft,
  extractDocument,
  loadModelConfig,
  NeverSendList,
  summarize,
  suggestCatalogBinding,
  suggestColumnMappings,
  type AuroraContext,
  type FilterCollection,
  type CatalogField,
} from "@xos/ai";
import {
  createAuroraStore,
  getAiAllowance,
  listAiNeverSend,
  listEnabledAiFeatures,
  saveAiSettings,
  transitionAiSuggestion,
} from "@xos/data/ai";
import { z } from "zod";
import type { ResourceSpec } from "../../catalog/types.ts";
import { ApiProblem, fromDatabaseError, isDatabaseError, refused } from "../../problem.ts";
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
  /** Today's date for relative dates, ISO 8601. */
  readonly today: () => string;
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

const DEFAULT_DEPS: AuroraDeps = {
  model: anthropicClient,
  config: () => loadModelConfig(),
  today: () => new Date().toISOString().slice(0, 10),
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

/** This API's list and get handlers, called in process as the caller. */
export function inProcessApi(context: RequestContext, specs: readonly ResourceSpec[]): PublicApi {
  return {
    async get(path, query) {
      const [, collection, id] = path.split("/");
      const spec = specs.find((s) => s.path === `/${collection ?? ""}`);
      if (!spec) return { status: 404, body: {} };
      const operationId = `${spec.op}.${id ? "get" : "list"}`;
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
  confirm: { expected: "Proposed", next: "Confirmed" },
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

  const setup = async (context: RequestContext) => {
    const org = requireOrg(context);
    requirePerson(context);
    const neverSend = new NeverSendList(unwrap(await listAiNeverSend(context.db)));
    const specs = await catalogOf();
    const api = deps.readApi ? deps.readApi(context) : inProcessApi(context, specs);
    const ctx: AuroraContext = {
      orgId: org.id,
      client: await deps.model(),
      store: createAuroraStore(context.db),
      config: deps.config(),
      today: deps.today(),
    };
    return { ctx, neverSend, specs, api };
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
      const body = request.body as { sentence: string; collections: string[]; time_zone: string };
      const { ctx, neverSend, specs } = await setup(context);
      const catalog: FilterCollection[] = readableCollections(specs, neverSend)
        .filter((c) => body.collections.includes(c.path))
        .map((c) => {
          const spec = specs.find((s) => s.path === `/${c.path}`) as ResourceSpec;
          return {
            collection: c.path,
            fields: filterFields(spec).filter((f) => !neverSend.excludesColumn(c.table, f.name)),
          };
        });
      return toResponse(
        await buildFilter(ctx, { sentence: body.sentence, catalog, timeZone: body.time_zone }),
      );
    },

    "aurora.extract": async (request, context) => {
      const body = request.body as {
        kind: "rider" | "insurance_certificate" | "invoice" | "receipt" | "quote";
        document_id: string;
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
          subject: { table: "app.documents", id: body.document_id },
        }),
      );
    },

    "aurora.draft": async (request, context) => {
      const body = request.body as {
        kind: "sop" | "advance_packet" | "email" | "day_sheet" | "change_order_description";
        instructions: string;
        context?: { collection: string; id: string }[];
        verbiage?: { term: string; preferred: string }[];
      };
      const { ctx, neverSend, specs, api } = await setup(context);
      const records = await readItems(api, specs, body.context ?? []);
      return toResponse(
        await draft(ctx, {
          kind: body.kind,
          instructions: body.instructions,
          context: records,
          verbiage: body.verbiage ?? [],
          neverSend,
          subject: null,
        }),
      );
    },

    "aurora.summarize": async (request, context) => {
      const body = request.body as {
        kind: "record_activity" | "project_week" | "gate_readiness";
        subject_collection: string;
        subject_id: string;
        items: { collection: string; id: string }[];
      };
      const { ctx, neverSend, specs, api } = await setup(context);
      const subjectSpec = specs.find((s) => s.path === `/${body.subject_collection}`);
      const items = await readItems(api, specs, body.items);
      return toResponse(
        await summarize(ctx, {
          kind: body.kind,
          subject: { table: subjectSpec?.def.table ?? "app.projects", id: body.subject_id },
          items,
          neverSend,
        }),
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
  return handlers;
}
