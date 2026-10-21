/**
 * The embedding seam for semantic search (Section 5: pgvector over documents and SOPs; finding A65-005).
 * Beside the model boundary (`ModelClient`), and like it, nothing outside an adapter knows a provider's
 * wire format. The worker (`@xos/data/search-embeddings`) embeds the text of published documents, SOPs and
 * handbook articles; the search embeds the words a person searched with. Both go through one provider.
 *
 * The default provider is Supabase's built-in gte-small model (`Supabase.ai.Session("gte-small")`), which
 * runs inside the Supabase Edge Runtime the platform already uses, so no text leaves for a new
 * subprocessor. The search-embed Edge Function runs it for the worker and, for servers outside the Edge
 * Runtime such as Atlas, embeds a person's query (`remoteGteSmallEmbeddings`). Search stays lexical for an
 * org until an Admin turns on search.semantic_enabled. XOS_SEARCH_EMBEDDINGS=off turns the provider off
 * everywhere; XOS_SEARCH_EMBEDDINGS=local-hash names a deterministic fake for tests and local development,
 * refused in production. Every text is redacted (`redactText`) before any provider sees it, and the
 * database hands the worker no column classified Restricted (migration 1440).
 */
import { redactText } from "./redact.ts";

/** Dimensions of every stored vector: gte-small's width (app.search_embeddings.embedding is vector(384)). */
export const EMBEDDING_DIMENSIONS = 384;

/** A document is embedded for storage; a query for comparison. Some providers embed them differently. */
export type EmbeddingPurpose = "document" | "query";

export interface EmbeddingProvider {
  /** Stored with each vector (app.search_embeddings.provider), for example `supabase-gte`. */
  readonly provider: string;
  /** Model that makes the vectors; vectors of different models are never compared. */
  readonly model: string;
  /** Always EMBEDDING_DIMENSIONS; a provider that cannot produce them is not wired. */
  readonly dimensions: number;
  /** Cosine similarity below which a match is noise for this model. */
  readonly minSimilarity: number;
  /** One vector per text, in order. */
  embed(texts: readonly string[], purpose: EmbeddingPurpose): Promise<number[][]>;
}

/** Raised when no provider may run, or a provider failed. */
export class EmbeddingUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingUnavailableError";
  }
}

// Supabase gte-small ---------------------------------------------------------------------------------------

/** Names stored with gte-small vectors. */
export const GTE_SMALL = { provider: "supabase-gte", model: "gte-small" } as const;

/** gte-small reads about 512 tokens; longer text is cut to its start, where titles and summaries sit. */
export const GTE_SMALL_MAX_CHARS = 2000;

/** gte-small's floor: below it a match is noise (measured on the demo seed, A87). */
export const GTE_SMALL_MIN_SIMILARITY = 0.82;

/**
 * One text to one vector in the Edge Runtime:
 * `new Supabase.ai.Session("gte-small").run(text, { mean_pool: true, normalize: true })`.
 */
export type GteSmallRun = (text: string) => Promise<ArrayLike<number>>;

/** Embeds a person's query through the search-embed Edge Function, for servers outside the Edge Runtime. */
export type GteSmallRemote = (text: string) => Promise<readonly number[]>;

/**
 * Supabase's gte-small in the Edge Runtime. Vectors come back normalized, so cosine similarity is their
 * dot product. On the demo seed, related texts scored 0.82 to 0.87 and unrelated ones 0.74 to 0.81.
 */
export function gteSmallEmbeddings(run: GteSmallRun): EmbeddingProvider {
  return {
    ...GTE_SMALL,
    dimensions: EMBEDDING_DIMENSIONS,
    minSimilarity: GTE_SMALL_MIN_SIMILARITY,
    async embed(texts) {
      const out: number[][] = [];
      // One at a time: the Edge Runtime's model session runs on the function's own CPU.
      for (const text of texts) out.push(Array.from(await run(text.slice(0, GTE_SMALL_MAX_CHARS))));
      return out;
    },
  };
}

/** gte-small reached through the search-embed Edge Function; the same model, so its vectors compare. */
export function remoteGteSmallEmbeddings(remote: GteSmallRemote): EmbeddingProvider {
  return {
    ...GTE_SMALL,
    dimensions: EMBEDDING_DIMENSIONS,
    minSimilarity: GTE_SMALL_MIN_SIMILARITY,
    async embed(texts) {
      const out: number[][] = [];
      for (const text of texts) out.push([...(await remote(text.slice(0, GTE_SMALL_MAX_CHARS)))]);
      return out;
    },
  };
}

// The deterministic local fake -------------------------------------------------------------------------------

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** 32-bit FNV-1a of a string's UTF-16 code units. */
function fnv1a(text: string): number {
  let hash = FNV_OFFSET;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

/** A crude English and Spanish stem: enough for climb, climbs, climbing and climbed to meet. */
function stem(word: string): string {
  for (const suffix of ["ations", "ation", "ings", "ing", "edly", "ed", "es", "s"]) {
    if (word.length - suffix.length >= 4 && word.endsWith(suffix))
      return word.slice(0, -suffix.length);
  }
  return word;
}

const STOP_WORDS = new Set(
  "a an and as at by for in is it of on or the to with you your el la los las de del y en un una".split(
    " ",
  ),
);

/** Combining marks left by NFKD, removed so `evacuación` and `evacuacion` agree. */
const COMBINING_MARKS = /[̀-ͯ]/g;

/**
 * The vector of a text by feature hashing: each word stem adds ±1 at a hashed position, then the vector
 * is scaled to unit length. Texts that share words point the same way; the same text always gives the
 * same vector. It knows nothing of meaning beyond shared words, which is all tests need.
 */
export function hashEmbedding(text: string, dimensions = EMBEDDING_DIMENSIONS): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const words = text
    .toLocaleLowerCase("en-US")
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
  for (const word of words) {
    const hash = fnv1a(stem(word));
    vector[hash % dimensions] = (vector[hash % dimensions] ?? 0) + (hash >>> 31 === 1 ? -1 : 1);
  }
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  return norm === 0 ? vector : vector.map((v) => v / norm);
}

/** The deterministic local fake provider for tests and local development. */
export function localHashEmbeddings(): EmbeddingProvider {
  return {
    provider: "local-hash",
    model: "local-hash-384",
    dimensions: EMBEDDING_DIMENSIONS,
    // Two short texts sharing one of three words sit near 0.3; unrelated texts near 0.
    minSimilarity: 0.25,
    embed(texts) {
      return Promise.resolve(texts.map((t) => hashEmbedding(t)));
    },
  };
}

// Choosing the provider -----------------------------------------------------------------------------------------

export type EmbeddingEnv = Readonly<Record<string, string | undefined>>;

/** How this runtime reaches gte-small: in the Edge Runtime itself, or through the Edge Function. */
export interface EmbeddingRuntime {
  readonly gteSmall?: GteSmallRun;
  readonly remoteGteSmall?: GteSmallRemote;
}

/** True when the process is a production one, where the local fake must never run. */
function isProduction(env: EmbeddingEnv): boolean {
  return env["NODE_ENV"] === "production" || env["XOS_ENVIRONMENT"] === "production";
}

/**
 * The provider XOS_SEARCH_EMBEDDINGS names: gte-small (`supabase-gte`) when unset, null when `off`, the
 * local fake for `local-hash` outside production. gte-small is null when this runtime has no way to reach
 * it. Any other name is refused: a provider outside Supabase is a new subprocessor, an owner decision.
 */
export function embeddingProviderFromEnv(
  env: EmbeddingEnv,
  runtime: EmbeddingRuntime = {},
): EmbeddingProvider | null {
  const name = env["XOS_SEARCH_EMBEDDINGS"]?.trim() || GTE_SMALL.provider;
  if (name === "off") return null;
  if (name === "local-hash") {
    if (isProduction(env)) {
      throw new EmbeddingUnavailableError(
        "The local-hash embedding fake runs only outside production.",
      );
    }
    return localHashEmbeddings();
  }
  if (name === GTE_SMALL.provider) {
    if (runtime.gteSmall) return gteSmallEmbeddings(runtime.gteSmall);
    if (runtime.remoteGteSmall) return remoteGteSmallEmbeddings(runtime.remoteGteSmall);
    return null;
  }
  throw new EmbeddingUnavailableError(
    `No embedding provider named ${name}: a provider outside Supabase is a new subprocessor and an owner decision (legal/OWNER_INPUTS.md).`,
  );
}

/**
 * Embeds texts after redaction, checking the provider kept its contract: one vector per text, each of
 * EMBEDDING_DIMENSIONS finite numbers.
 */
export async function embedTexts(
  provider: EmbeddingProvider,
  texts: readonly string[],
  purpose: EmbeddingPurpose,
): Promise<number[][]> {
  if (provider.dimensions !== EMBEDDING_DIMENSIONS) {
    throw new EmbeddingUnavailableError(
      `${provider.provider} makes ${provider.dimensions} dimensions; search stores ${EMBEDDING_DIMENSIONS}.`,
    );
  }
  if (texts.length === 0) return [];
  const vectors = await provider.embed(
    texts.map((t) => redactText(t)),
    purpose,
  );
  if (
    vectors.length !== texts.length ||
    vectors.some((v) => v.length !== EMBEDDING_DIMENSIONS || v.some((x) => !Number.isFinite(x)))
  ) {
    throw new EmbeddingUnavailableError(`${provider.provider} returned malformed vectors.`);
  }
  return vectors;
}

/** pgvector's text form of a vector, `[0.1,0.2,...]`, as PostgREST accepts it. */
export function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.map((v) => (Number.isFinite(v) ? Number(v.toFixed(7)) : 0)).join(",")}]`;
}
