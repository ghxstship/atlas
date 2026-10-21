/**
 * GET /api/system-banners: the live platform banners for Atlas (A90, Section 4.10), read with the publishable key
 * through api_public.active_system_banners. At most one database read per server instance a minute
 * (createBannerCache), and shared caches may keep the answer a minute too, so banners stay cheap at any traffic.
 * A failed read answers the last banners, or none.
 */
import { createClient } from "@supabase/supabase-js";
import {
  BANNER_CACHE_SECONDS,
  createBannerCache,
  listActiveSystemBanners,
} from "@xos/data/system-banners";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

let cached: ReturnType<typeof createBannerCache> | undefined;

export async function GET(): Promise<Response> {
  if (!cached) {
    const config = env();
    const client = createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    cached = createBannerCache((surface) => listActiveSystemBanners(client, surface));
  }
  const banners = await cached("atlas");
  return Response.json(
    { banners },
    {
      headers: {
        "Cache-Control": `public, max-age=30, s-maxage=${BANNER_CACHE_SECONDS}, stale-while-revalidate=300`,
      },
    },
  );
}
