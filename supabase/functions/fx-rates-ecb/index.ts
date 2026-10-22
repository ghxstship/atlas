// ECB reference rate worker (A97, RRR-142; Section 15, ADR 0053). pg_cron calls it on ECB business days after
// publication (private.request_fx_feed, migration 1542) with the service key, like the other workers. It reads
// the daily reference rates file, writes them per ECB publication date into every org's app.fx_rates through
// app.record_fx_reference_rates (idempotent: a rerun for the same date changes nothing), and records every
// failure with app.record_fx_feed_failure so finance pages can say the rates are stale. It uses only the shared
// core (the PostgREST seam), so it loads no npm package at boot (A85).
import { env, hasBearer, json, serve, serviceDb } from "../_shared/runtime.ts";
import { runEcbFeed, type FxFeedStore } from "./ecb.ts";

function store(): FxFeedStore {
  const db = serviceDb();
  return {
    record: (source, daily) =>
      db.rpc("record_fx_reference_rates", {
        p_source: source,
        p_rate_date: daily.date,
        p_rates: daily.rates,
      }),
    async fail(source, message) {
      await db.rpc("record_fx_feed_failure", { p_source: source, p_error: message });
    },
  };
}

serve(async (request) => {
  if (!hasBearer(request, env("SUPABASE_SERVICE_ROLE_KEY"))) {
    return json(401, { type: "/problems/unauthorized", title: "Unauthorized", status: 401 });
  }
  const outcome = await runEcbFeed({ fetch, store: store() });
  return json(outcome.ok ? 200 : 502, outcome);
});
