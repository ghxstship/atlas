/**
 * search-embed (A87, RRR-132; migration 1440): the semantic search embedding worker and the embedding seam.
 * The worker lives in @xos/data (search-embeddings.ts) and the provider seam with Supabase's gte-small in
 * @xos/ai (embeddings.ts, which redacts every text before the model sees it). No npm package loads: the
 * worker reaches PostgREST with plain fetch, so the function boots well inside the worker's CPU limit.
 */
export {
  EMBEDDING_DIMENSIONS,
  EmbeddingUnavailableError,
  embedTexts,
  embeddingProviderFromEnv,
  type EmbeddingProvider,
} from "../../../ai/src/embeddings.ts";
export {
  restAppRpc,
  runSearchEmbeddings,
  searchEmbeddingStore,
  type SearchEmbedder,
  type SearchEmbeddingPass,
} from "../../../data/src/search-embeddings.ts";
