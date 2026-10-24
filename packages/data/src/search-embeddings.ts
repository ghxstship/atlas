import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The semantic search embedding worker (A87, RRR-132; migration 1440). Run with the service role, like the
 * report and import workers, by the search-embed Edge Function on a schedule. Each pass:
 *   1. retires the vectors of sources that are gone or unpublished, or whose org turned semantic search off
 *      (app.retire_search_embeddings), whether or not a provider is configured;
 *   2. reads the backlog: published documents, SOPs and handbook articles of orgs with search.semantic_enabled
 *      on whose text has no current vector from this provider and model (app.search_embedding_backlog). The
 *      database builds the text and never includes a column classified Restricted;
 *   3. embeds the texts through the embedding seam (the caller wires @xos/ai `embedTexts`, which redacts
 *      every text first) and stores each vector (app.store_search_embedding), which refuses a vector for text
 *      that changed meanwhile: that source simply comes back in the next pass.
 * The worker holds no provider code and no secrets; it only sees the `SearchEmbedder` it is given.
 */

export interface SearchEmbeddingSource {
  readonly orgId: string;
  readonly sourceTable: "documents" | "sops" | "handbook_articles";
  readonly sourceId: string;
  readonly content: string;
  readonly contentSha256: string;
}

/** The database side of the worker; supabaseSearchEmbeddingStore implements it over the service role. */
export interface SearchEmbeddingStore {
  retire(): Promise<number>;
  backlog(
    provider: string,
    model: string,
    limit: number,
  ): Promise<readonly SearchEmbeddingSource[]>;
  /** Stores one vector; `stale` when the source changed, went away or its org turned semantic search off. */
  store(
    source: SearchEmbeddingSource,
    provider: string,
    model: string,
    vector: readonly number[],
  ): Promise<"stored" | "stale">;
}

/** The embedding seam as the worker sees it: names for the stored rows and a redacting embed call. */
export interface SearchEmbedder {
  readonly provider: string;
  readonly model: string;
  embed(texts: readonly string[]): Promise<number[][]>;
}

export interface SearchEmbeddingPass {
  readonly retired: number;
  readonly embedded: number;
  readonly stale: number;
  /** Why the pass stopped early, or null. */
  readonly error: string | null;
}

/** pgvector's text form of a vector, `[0.1,0.2,...]`. */
export function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.map((v) => (Number.isFinite(v) ? Number(v.toFixed(7)) : 0)).join(",")}]`;
}

/**
 * One pass of the worker. With no embedder (no provider configured) it only retires. It embeds at most
 * `batches` batches of `batch` sources, so one call stays well inside an Edge Function's time limit.
 */
export async function runSearchEmbeddings(options: {
  readonly store: SearchEmbeddingStore;
  readonly embedder: SearchEmbedder | null;
  readonly batch?: number;
  readonly batches?: number;
}): Promise<SearchEmbeddingPass> {
  const { store, embedder } = options;
  const retired = await store.retire();
  let embedded = 0;
  let stale = 0;
  if (!embedder) return { retired, embedded, stale, error: null };
  const size = Math.max(1, Math.min(options.batch ?? 32, 128));
  for (let round = 0; round < Math.max(1, options.batches ?? 4); round++) {
    const sources = await store.backlog(embedder.provider, embedder.model, size);
    if (sources.length === 0) break;
    let vectors: number[][];
    try {
      vectors = await embedder.embed(sources.map((s) => s.content));
    } catch (error) {
      return {
        retired,
        embedded,
        stale,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    let storedThisRound = 0;
    for (const [i, source] of sources.entries()) {
      const vector = vectors[i];
      if (!vector) continue;
      if ((await store.store(source, embedder.provider, embedder.model, vector)) === "stored") {
        embedded += 1;
        storedThisRound += 1;
      } else {
        stale += 1;
      }
    }
    // A round where every source changed underneath would read the same backlog again; stop instead.
    if (storedThisRound === 0 || sources.length < size) break;
  }
  return { retired, embedded, stale, error: null };
}

const TABLES = new Set(["documents", "sops", "handbook_articles"]);
const STALE_RULES = new Set(["search_source_changed", "search_source_unavailable"]);

function textOf(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value === "")
    throw new Error(`search embedding row lacks ${key}`);
  return value;
}

/** One call of an `app` RPC, answered as supabase-js answers it. */
export type AppRpc = (
  fn: string,
  args?: Readonly<Record<string, unknown>>,
) => Promise<{
  readonly data: unknown;
  readonly error: { readonly message: string; readonly hint?: string | null } | null;
}>;

/** SearchEmbeddingStore over the 1440 worker RPCs, called with the service role. */
export function searchEmbeddingStore(rpc: AppRpc): SearchEmbeddingStore {
  return {
    async retire() {
      const { data, error } = await rpc("retire_search_embeddings");
      if (error) throw new Error(`retire_search_embeddings: ${error.message}`);
      return Number(data ?? 0);
    },
    async backlog(provider, model, limit) {
      const { data, error } = await rpc("search_embedding_backlog", {
        p_provider: provider,
        p_model: model,
        p_limit: limit,
      });
      if (error) throw new Error(`search_embedding_backlog: ${error.message}`);
      return ((data ?? []) as Record<string, unknown>[])
        .filter((r) => TABLES.has(String(r["source_table"])))
        .map((r) => ({
          orgId: textOf(r, "org_id"),
          sourceTable: textOf(r, "source_table") as SearchEmbeddingSource["sourceTable"],
          sourceId: textOf(r, "source_id"),
          content: textOf(r, "content"),
          contentSha256: textOf(r, "content_sha256"),
        }));
    },
    async store(source, provider, model, vector) {
      const { error } = await rpc("store_search_embedding", {
        p_source_table: source.sourceTable,
        p_source_id: source.sourceId,
        p_content_sha256: source.contentSha256,
        p_provider: provider,
        p_model: model,
        p_embedding: toVectorLiteral(vector),
      });
      if (!error) return "stored";
      if (error.hint && STALE_RULES.has(error.hint)) return "stale";
      throw new Error(`store_search_embedding: ${error.message}`);
    },
  };
}

/** SearchEmbeddingStore over a service-role Supabase client. */
export function supabaseSearchEmbeddingStore(client: SupabaseClient): SearchEmbeddingStore {
  const app = client.schema("app");
  return searchEmbeddingStore(async (fn, args) => await app.rpc(fn, args ?? {}));
}

/**
 * An `app` RPC over PostgREST with plain fetch, for the search-embed Edge Function, which loads no npm
 * package so it boots well inside the worker's CPU limit. `authorization` is the bearer it calls as: the
 * service key for the worker, or a person's own session token for their search context.
 */
export function restAppRpc(options: {
  readonly url: string;
  readonly apiKey: string;
  readonly authorization: string;
  readonly fetch?: typeof fetch;
}): AppRpc {
  const doFetch = options.fetch ?? fetch;
  return async (fn, args) => {
    const response = await doFetch(`${options.url}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: {
        apikey: options.apiKey,
        Authorization: options.authorization,
        "Content-Type": "application/json",
        "Content-Profile": "app",
        "Accept-Profile": "app",
      },
      body: JSON.stringify(args ?? {}),
    });
    const text = await response.text();
    const body: unknown = text === "" ? null : JSON.parse(text);
    if (response.ok) return { data: body, error: null };
    const problem = (body ?? {}) as { message?: unknown; hint?: unknown };
    return {
      data: null,
      error: {
        message: typeof problem.message === "string" ? problem.message : `HTTP ${response.status}`,
        hint: typeof problem.hint === "string" ? problem.hint : null,
      },
    };
  };
}
