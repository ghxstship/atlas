# ADR 0043: Global Search, Recents and Semantic Search with gte-small

- Status: Accepted
- Date: 2026-10-21
- Decider: Orchestrator for the owner (embedding model); built and recorded by A87 (RRR-132)
- Closes: finding A65-005 (Section 11.7 Search, Section 11.10 item 1, Section 11.11 Settings, Section 5 pgvector)

## Context

The command menu found pages, settings pages and, after A61 (A59-015), records and people by title or key. Section 11.7 also asks for quoted phrases, operators and the last 50 records each person viewed. Section 11.11 asks that any setting be reached in one search, and Section 5 puts pgvector semantic search over documents and SOPs in the stack. This ADR records the shape of the search and where each part lives.

## Decision

1. **One RPC, read as the caller.** `app.global_search` (migration 1440) is `SECURITY INVOKER`. Every table it reads applies the caller's own row level security, so search can never widen what a person sees. It only calls `app` objects. The definer helper `app.search_context` hands it facts the caller may know: their person id, the org's time zone, today on the org's calendar, and whether semantic search is on.
2. **The grammar lives in `@xos/data`.** `packages/data/src/search-query.ts` is pure, so it runs in the browser (the menu's operator chips) and on the server. The RPC never receives raw text. It takes a structured request: terms, phrases, exclusions, filters, and dates as a calendar date or a number of days from today. The database resolves those dates on the org's calendar (A71).
3. **Ranking.** Text relevance is `ts_rank_cd` over a `simple` tsvector, with titles weighted above bodies and long bodies length-normalized. It is multiplied by a recency factor with a 45-day decay. A key match (`NWS-12`) ranks first. Every searched text is indexed with the `simple` configuration, so a typed prefix matches the stored word in any language.
4. **Recents are their own table.** `activity_events` records changes, not views, so `app.recent_views` holds one row per person, org and thing opened. A trigger keeps the newest 50, rows expire after 90 days, and the person's rows are deleted when the person is. Atlas records a view beside the page's other reads, so it adds no wait. Previewing another role records nothing.
5. **Settings come from the registry on the server.** Labels and keys from `packages/schemas/settings`, on pages the viewer can open, link to the page with `?setting=<key>`. That opens More fields if needed and focuses the field. The registry never ships to the browser.
6. **Semantic search uses Supabase's gte-small.** The `search-embed` Edge Function runs `Supabase.ai.Session("gte-small")` inside the Edge Runtime, so no document or query text goes to a new subprocessor. Vectors are `vector(384)`, gte-small's width. The function embeds the backlog for the worker schedule (service key). It also embeds a person's query for Atlas with that person's session, and only when their org has semantic search on. The provider sits behind `EmbeddingProvider` in `@xos/ai`, with a deterministic `local-hash` fake for tests. Any provider outside Supabase would be a new subprocessor and an owner decision.
7. **Off until an Admin turns it on.** `search.semantic_enabled` (organization scope, `org.ai.write`, default off) gates both the worker's backlog and the query vector. Turning it off retires the org's vectors on the next worker pass. The database builds the text to embed only from columns no classification marks Restricted, never from a table excluded from AI features, and the seam redacts emails, phone numbers and identifiers before the model sees any text.
8. **The function boots light.** `search-embed` loads its own 13 KB bundle (`packages/platform/edge/entries/search-embed.ts`) and no npm package, so a cold start stays inside the worker's CPU limit. Each call embeds at most eight texts. When the per-function bundles (A85) land, the entry follows their layout unchanged.

## Consequences

- The similarity floor for gte-small is 0.82. On the demo seed, related texts scored 0.82 to 0.87 and unrelated ones 0.74 to 0.81. It is a constant in `@xos/ai` and can be tuned there.
- The first query after the Edge Function goes cold may miss the 1.5-second limit Atlas allows for the query vector, and that search is lexical only.
- Gateway's command menu is unchanged: Gateway has no record search for operators to narrow. Compass phone search is a separate follow-up.
