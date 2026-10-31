// NWS weather feed worker (B8, RRR-232, gap G-150, ADR 0147 decision 8). pg_cron calls it every 10 minutes while a
// weather feed is on (private.request_weather_feed, migration 2976) with the service key, like the other workers. For
// each feed app.due_weather_feeds names, it reads the National Weather Service (nws.ts) and records the poll with
// app.record_weather_feed, or the failure with app.record_weather_feed_failure, so the Weather page can say the feed is
// stale. It uses only the shared core (the PostgREST seam) and fetch, so it loads no npm package at boot (A85).
import { env, hasBearer, json, serve, serviceDb } from "../_shared/runtime.ts";
import { runNwsFeed, type DueFeed, type WeatherFeedStore } from "./nws.ts";

function store(): WeatherFeedStore {
  const db = serviceDb();
  return {
    dueFeeds: async () => ((await db.rpc("due_weather_feeds", {})) as DueFeed[] | null) ?? [],
    async record(feedId, payload) {
      await db.rpc("record_weather_feed", { p_feed_id: feedId, p_payload: payload });
    },
    async fail(feedId, message) {
      await db.rpc("record_weather_feed_failure", { p_feed_id: feedId, p_error: message });
    },
  };
}

serve(async (request) => {
  if (!hasBearer(request, env("SUPABASE_SERVICE_ROLE_KEY"))) {
    return json(401, { type: "/problems/unauthorized", title: "Unauthorized", status: 401 });
  }
  const summary = await runNwsFeed({
    fetch,
    store: store(),
    userAgent: Deno.env.get("XOS_WEATHER_USER_AGENT"),
  });
  return json(200, summary);
});
