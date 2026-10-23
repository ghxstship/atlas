/**
 * Canon responses cached by canon generation, with the generation in the URL (Section 5.1, A65-032).
 *
 * Canon changes only when a new generation ships (`xpms.version.generation`, Section 2), so a canon read
 * that names the current generation can be cached for good:
 *
 * - `GET /canon/...?generation=<current>` answers with `Cache-Control: private, max-age=31536000, immutable`.
 *   The URL is content-addressed: once a newer generation ships, the old URL is never answered with new data.
 * - `GET /canon/...?generation=<anything else>` answers `307` to the same URL at the current generation,
 *   with `no-store`, so a client holding an old URL moves to the current one and caches that.
 * - `GET /canon/...` without a generation answers as before, revalidated on every use (`no-cache`), and
 *   names the cacheable URL in `Content-Location`.
 *
 * Every canon read also carries `XOS-Canon-Generation`. The cache is `private`: each request still passes
 * the caller's credential and rate limit, so a shared cache must not answer it. The `generation` parameter
 * is read here, before the operation's own query validation, which ignores it; the frozen v1 operations
 * are unchanged (ADR 0014).
 */

import type { RequestContext } from "./context.ts";

export const CANON_GENERATION_HEADER = "XOS-Canon-Generation";
export const IMMUTABLE = "private, max-age=31536000, immutable";
export const REVALIDATE = "private, no-cache";
export const NO_STORE = "no-store";

/** Reads the canon generation in effect, or null when it cannot be read. */
export type CanonGenerationReader = (context: RequestContext) => Promise<number | null>;

/** The highest generation in `xpms.version`, which every signed-in caller may read (migration 0199). */
export const readCanonGeneration: CanonGenerationReader = async ({ db }) => {
  try {
    const { data, error } = await db
      .schema("xpms")
      .from("version")
      .select("generation")
      .order("generation", { ascending: false })
      .limit(1);
    if (error !== null) return null;
    const value = Number((data as { generation?: unknown }[] | null)?.[0]?.generation);
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
};

export type CanonCacheDecision =
  | {
      readonly kind: "redirect";
      readonly location: string;
      readonly headers: Record<string, string>;
    }
  | { readonly kind: "serve"; readonly headers: Record<string, string> };

/** The request's query string with `generation` set, as a relative reference (`?a=1&generation=2`). */
export function withGeneration(url: URL, generation: number): string {
  const search = new URLSearchParams(url.search);
  search.set("generation", String(generation));
  return `?${search.toString()}`;
}

/**
 * What a canon read answers, given the request URL and the current generation. With no readable
 * generation the response is not cached at all, so nothing stale can be kept.
 */
export function canonCacheDecision(url: URL, current: number | null): CanonCacheDecision {
  if (current === null) return { kind: "serve", headers: { "Cache-Control": NO_STORE } };
  const requested = url.searchParams.get("generation");
  const generation = { [CANON_GENERATION_HEADER]: String(current) };
  if (requested === null) {
    return {
      kind: "serve",
      headers: {
        ...generation,
        "Cache-Control": REVALIDATE,
        "Content-Location": withGeneration(url, current),
      },
    };
  }
  if (requested === String(current)) {
    return { kind: "serve", headers: { ...generation, "Cache-Control": IMMUTABLE } };
  }
  const location = withGeneration(url, current);
  return {
    kind: "redirect",
    location,
    headers: { ...generation, "Cache-Control": NO_STORE, Location: location },
  };
}

/** Canon reads: every GET of the Canon module. The one write, `canonExtensions.propose`, is a POST. */
export function isCanonRead(op: { readonly module: string; readonly method: string }): boolean {
  return op.module === "Canon" && op.method === "get";
}
