import http from "k6/http";
import { check, fail, sleep } from "k6";
import { Counter, Trend } from "k6/metrics";
import { restHeaders, signIn, userFor, uuid } from "./lib/auth.js";
import { SLO, loadEnv, rampingScenario } from "./lib/config.js";

/**
 * Compass during one show (Section 5.1: 1,000 devices syncing). Each virtual user is a device that
 * replays door counts through app.apply_sync_mutation (app.record_occupancy_count, the busiest
 * offline write at a gate), resends one mutation in five with the same id as a reconnect would, and
 * reads its shifts, cues and notifications through PostgREST the way supabase-js does.
 */
const env = loadEnv(__ENV);
const syncApply = new Trend("sync_apply_ms", true);
const syncReplay = new Trend("sync_replay_ms", true);
const refusals = new Counter("sync_refusals");

export const options = {
  scenarios: { show: rampingScenario(env.scale.compassDevices, env.duration, "default") },
  thresholds: {
    sync_apply_ms: [`p(95)<${SLO.syncP95}`],
    sync_replay_ms: [`p(95)<${SLO.syncP95}`],
    "http_req_duration{kind:read}": [`p(95)<${SLO.readP95}`],
    http_req_failed: ["rate<0.01"],
  },
  summaryTrendStats: ["avg", "p(50)", "p(95)", "p(99)", "max"],
};

const READS = [
  "/rest/v1/shifts?select=id,starts_at,ends_at&order=starts_at&limit=50",
  "/rest/v1/cues?select=id,position&order=position&limit=100",
  "/rest/v1/notifications?select=id,kind,read_at&order=created_at.desc&limit=20",
];

export function setup() {
  // One sign-in finds the counter; each device signs in itself on its first iteration.
  const first = signIn(env, env.users[0]);
  const res = http.get(
    `${env.supabaseUrl}/rest/v1/occupancy_counters?select=id,org_id&closed_at=is.null&deleted_at=is.null&limit=1`,
    {
      headers: restHeaders(env, first.token, { "Accept-Profile": "app" }),
      tags: { kind: "setup" },
    },
  );
  const counter = res.status === 200 ? res.json("0") : null;
  if (!counter) fail(`no open occupancy counter is readable: ${res.status} ${res.body}`);
  return { counter };
}

function applyMutation(data, token, id, delta) {
  return http.post(
    `${env.supabaseUrl}/rest/v1/rpc/apply_sync_mutation`,
    JSON.stringify({
      p_mutation_id: id,
      p_org_id: data.counter.org_id,
      p_device_id: `load-device-${__VU}`,
      p_rpc: "app.record_occupancy_count",
      p_args: { p_counter_id: data.counter.id, p_delta: delta, p_door: `Gate ${__VU % 8}` },
    }),
    {
      headers: restHeaders(env, token, { "Content-Profile": "app" }),
      tags: { kind: "sync", name: "rpc apply_sync_mutation" },
    },
  );
}

let lastMutation = null;
let session = null;

export default function (data) {
  if (session === null) session = signIn(env, userFor(env, __VU));
  const { token } = session;
  // Entries and exits alternate so the count stays near its start; a refusal is a clean answer.
  const id = uuid();
  const delta = __ITER % 2 === 0 ? 1 : -1;
  const applied = applyMutation(data, token, id, delta);
  syncApply.add(applied.timings.duration);
  check(applied, { "sync answers 200": (r) => r.status === 200 });
  if (applied.status === 200 && applied.json("refusal")) refusals.add(1);

  if (lastMutation && __ITER % 5 === 4) {
    const replay = applyMutation(data, token, lastMutation.id, lastMutation.delta);
    syncReplay.add(replay.timings.duration);
    check(replay, {
      "replay returns the stored result": (r) =>
        r.status === 200 && JSON.stringify(r.json()) === lastMutation.body,
    });
  }
  if (applied.status === 200) lastMutation = { id, delta, body: JSON.stringify(applied.json()) };

  for (const path of READS) {
    const res = http.get(`${env.supabaseUrl}${path}`, {
      headers: restHeaders(env, token, { "Accept-Profile": "app" }),
      tags: { kind: "read", name: `GET ${path.split("?")[0]}` },
    });
    check(res, { "read answers 200": (r) => r.status === 200 });
  }
  sleep(2);
}
