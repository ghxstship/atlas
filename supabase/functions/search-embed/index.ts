// Semantic search embeddings (A87, RRR-132; migration 1440) with Supabase's built-in gte-small model, which
// runs inside this Edge Runtime, so no text leaves for another provider. Two callers:
//   * the worker schedule, with the service key: one pass of the embedding worker (@xos/data
//     search-embeddings): retire the vectors of sources that are gone, unpublished or in an org that turned
//     semantic search off, then embed the backlog of published documents, SOPs and handbook articles of orgs
//     with search.semantic_enabled on. The database never hands over a column classified Restricted;
//   * a signed-in person's search, from Atlas, with their own session: { org_id, text } embeds the words they
//     searched with, only for a member of an org that has semantic search on (app.search_context decides,
//     as that person).
// Every text is redacted before the model sees it (@xos/ai embedTexts). XOS_SEARCH_EMBEDDINGS=off turns the
// provider off; local-hash names the test fake, refused in production.
//
// It loads no npm package and not the platform bundle (its own bundle is about 13 KB, packages/platform/edge/
// entries/search-embed.ts), so a cold start stays inside the worker's CPU limit; the model runs outside it.
import {
  embedTexts,
  embeddingProviderFromEnv,
  restAppRpc,
  runSearchEmbeddings,
  searchEmbeddingStore,
  type EmbeddingProvider,
} from "../_vendor/search-embed.js";

declare const Supabase: {
  readonly ai: {
    readonly Session: new (model: string) => {
      run(input: string, options: { mean_pool: boolean; normalize: boolean }): Promise<unknown>;
    };
  };
};

let session: InstanceType<typeof Supabase.ai.Session> | null = null;

/** One text to one normalized gte-small vector; the session is made once per worker instance. */
async function gteSmall(text: string): Promise<ArrayLike<number>> {
  session ??= new Supabase.ai.Session("gte-small");
  return (await session.run(text, { mean_pool: true, normalize: true })) as ArrayLike<number>;
}

function env(name: string): string {
  const value = Deno.env.get(name);
  if (value === undefined || value.length === 0) throw new Error(`${name} is not set`);
  return value;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function problem(status: number, title: string, detail: string): Response {
  return json(status, {
    type: `/problems/${title.toLowerCase().replaceAll(" ", "-")}`,
    title,
    status,
    detail,
  });
}

/** The same check as _shared/runtime.ts hasBearer, without loading the platform bundle. */
function isServiceKey(header: string, key: string): boolean {
  const expected = `Bearer ${key}`;
  if (header.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < header.length; i += 1) diff |= header.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function provider(): EmbeddingProvider | null {
  return embeddingProviderFromEnv(Deno.env.toObject(), { gteSmall });
}

async function handle(request: Request): Promise<Response> {
  if (request.method !== "POST") return problem(405, "Method Not Allowed", "Use POST.");
  const url = env("SUPABASE_URL");
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
  const authorization = request.headers.get("Authorization") ?? "";

  // The worker schedule.
  if (isServiceKey(authorization, serviceKey)) {
    const model = provider();
    const pass = await runSearchEmbeddings({
      store: searchEmbeddingStore(restAppRpc({ url, apiKey: serviceKey, authorization })),
      embedder: model
        ? {
            provider: model.provider,
            model: model.model,
            embed: (texts) => embedTexts(model, texts, "document"),
          }
        : null,
      // gte-small runs on this worker's CPU: eight texts a call, and the schedule calls every minute.
      batch: 8,
      batches: 1,
    });
    return json(200, { provider: model?.provider ?? "off", model: model?.model ?? null, ...pass });
  }

  // A person's search: their own session decides whether their org has semantic search on.
  if (!authorization.startsWith("Bearer "))
    return problem(401, "Unauthorized", "Sign in to search.");
  const body = (await request.json().catch(() => null)) as {
    org_id?: unknown;
    text?: unknown;
  } | null;
  const orgId = typeof body?.org_id === "string" && UUID.test(body.org_id) ? body.org_id : null;
  const text = typeof body?.text === "string" ? body.text.trim().slice(0, 500) : "";
  if (!orgId || text === "") {
    return problem(400, "Bad Request", "Send the org id and the words to search for.");
  }
  const asPerson = restAppRpc({ url, apiKey: env("SUPABASE_ANON_KEY"), authorization });
  const { data, error } = await asPerson("search_context", { p_org_id: orgId });
  const context = (Array.isArray(data) ? data[0] : data) as
    { semantic_enabled?: boolean } | null | undefined;
  if (error || !context)
    return problem(403, "Forbidden", "Only a member of the org can search it.");
  if (context.semantic_enabled !== true) {
    return problem(403, "Forbidden", "Semantic search is off for this organization.");
  }
  const model = provider();
  if (!model) return problem(503, "Service Unavailable", "No embedding provider is running.");
  const [vector] = await embedTexts(model, [text], "query");
  return json(200, { provider: model.provider, model: model.model, vector });
}

Deno.serve(async (request) => {
  try {
    return await handle(request);
  } catch (error) {
    // Logged with its message only; no text that was being embedded is logged.
    console.error("search-embed failed", error instanceof Error ? error.message : "unknown error");
    return problem(
      500,
      "Internal Server Error",
      "The embedding pass failed; it runs again on schedule.",
    );
  }
});
