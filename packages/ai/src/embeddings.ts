/**
 * The embedding seam for semantic search (Section 5: pgvector over documents and SOPs; finding A65-005).
 * Beside the model boundary (`ModelClient`), and like it, nothing outside an adapter knows a provider's
 * wire format. The worker (`@xos/data/search-embeddings`) embeds the text of published documents, SOPs and
 * handbook articles; the search embeds the words a person searched with. Both go through one provider.
 *
 * No provider is chosen yet. A provider is a new subprocessor, so choosing one is an owner decision
 * (legal/OWNER_INPUTS.md); until then `embeddingProviderFromEnv` returns null and search stays lexical.
 * The deterministic `localHashEmbeddings` fake stands in for tests and local development only: it runs
 * when XOS_SEARCH_EMBEDDINGS=local-hash and the process is not a production one, and it never leaves the
 * process. Every text is redacted (`redactText`) before it reaches any provider, and the database hands
 * the worker no column classified Restricted (migration 1440).
 */
import { redactText } from "./redact.ts";

/** Dimensions of every stored vector (app.search_embeddings.embedding is vector(1024)). */
export const EMBEDDING_DIMENSIONS = 1024;

/** A document is embedded for storage; a query for comparison. Some providers embed them differently. */
export type EmbeddingPurpose = "document" | "query";

export interface EmbeddingProvider {
  /** Stored with each vector (app.search_embeddings.provider), for example `local-hash`. */
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

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "by",
  "for",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
  "you",
  "your",
  "el",
  "la",
  "los",
  "las",
  "de",
  "del",
  "y",
  "en",
  "un",
  "una",
]);

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
    .replace(/[̀-ͯ]/g, "")
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
    model: "local-hash-1024",
    dimensions: EMBEDDING_DIMENSIONS,
    // Two short texts sharing one of three words sit near 0.3; unrelated texts near 0.
    minSimilarity: 0.25,
    embed(texts) {
      return Promise.resolve(texts.map((t) => hashEmbedding(t)));
    },
  };
}

export type EmbeddingEnv = Readonly<Record<string, string | undefined>>;

/** True when the process is a production one, where the local fake must never run. */
function isProduction(env: EmbeddingEnv): boolean {
  return env["NODE_ENV"] === "production" || env["XOS_ENVIRONMENT"] === "production";
}

/**
 * The provider XOS_SEARCH_EMBEDDINGS names, or null when it names none (`off` or unset). Only
 * `local-hash` exists, refused in production; any other name is refused until the owner chooses a
 * provider and an adapter is added here.
 */
export function embeddingProviderFromEnv(env: EmbeddingEnv): EmbeddingProvider | null {
  const name = env["XOS_SEARCH_EMBEDDINGS"]?.trim() ?? "";
  if (name === "" || name === "off") return null;
  if (name === "local-hash") {
    if (isProduction(env)) {
      throw new EmbeddingUnavailableError(
        "The local-hash embedding fake runs only outside production.",
      );
    }
    return localHashEmbeddings();
  }
  throw new EmbeddingUnavailableError(
    `No embedding provider named ${name}: choosing one is an owner decision (legal/OWNER_INPUTS.md).`,
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
