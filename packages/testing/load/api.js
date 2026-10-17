import http from "k6/http";
import { check, sleep } from "k6";
import { Counter } from "k6/metrics";
import { apiHeaders, signIn, userFor, uuid } from "./lib/auth.js";
import { apiThresholds, loadEnv, rampingScenario } from "./lib/config.js";

/**
 * Public API load (Section 5.1): LOAD_PROFILE=platform ramps to 10,000 concurrent users across
 * every load tenant; LOAD_PROFILE=tenant ramps to 500 users in one tenant. Each virtual user reads
 * the way Atlas does (me, projects, records, notifications) and creates a record on one iteration
 * in ten, with an Idempotency-Key, so reads and writes meet their own p95 objectives. A user whose
 * org has no record with a scope node to copy only reads (counted in `writes_skipped`).
 */
const env = loadEnv(__ENV);
const profile = __ENV.LOAD_PROFILE === "tenant" ? "tenant" : "platform";
const vus = profile === "tenant" ? env.scale.tenantUsers : env.scale.platformUsers;
const writesSkipped = new Counter("writes_skipped");

export const options = {
  scenarios: { [profile]: rampingScenario(vus, env.duration, "default") },
  thresholds: apiThresholds(),
  summaryTrendStats: ["avg", "p(50)", "p(95)", "p(99)", "max"],
};

const READS = ["/me", "/projects?limit=25", "/records?limit=50", "/notifications?limit=20"];

// Per virtual user: its session and the record it copies for writes, fetched once.
let session = null;
let template = null;

function start() {
  session = signIn(env, userFor(env, __VU));
  const res = http.get(`${env.atlasUrl}/api/v1/records?limit=50`, {
    headers: apiHeaders(session.token),
    tags: { kind: "setup" },
  });
  // Created records need a scope node; take the first readable record that has one.
  const rows = res.status === 200 ? res.json("data") : [];
  template = (rows || []).find((r) => r.scope_node_id) || null;
}

export default function () {
  if (session === null) start();
  for (const path of READS) {
    const res = http.get(`${env.atlasUrl}/api/v1${path}`, {
      headers: apiHeaders(session.token),
      tags: { kind: "read", name: `GET ${path.split("?")[0]}` },
    });
    check(res, { "read answers 200": (r) => r.status === 200 });
  }
  if (__ITER % 10 === 0) {
    if (template === null) {
      writesSkipped.add(1);
    } else {
      const body = {
        record_kind: template.record_kind,
        title: `Load check ${__VU}-${__ITER}`,
        scope_node_id: template.scope_node_id,
        phase_code: template.phase_code,
        xyz: template.xyz,
        external_visibility: template.external_visibility,
      };
      const res = http.post(`${env.atlasUrl}/api/v1/records`, JSON.stringify(body), {
        headers: apiHeaders(session.token, {
          "Content-Type": "application/json",
          "Idempotency-Key": uuid(),
        }),
        tags: { kind: "write", name: "POST /records" },
      });
      check(res, { "write answers 201": (r) => r.status === 201 });
    }
  }
  sleep(1);
}
