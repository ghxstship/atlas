import http from "k6/http";
import { check, sleep } from "k6";
import { apiHeaders, sessionFor, signInAll, uuid } from "./lib/auth.js";
import { apiThresholds, loadEnv, rampingScenario } from "./lib/config.js";

/**
 * Public API load (Section 5.1): LOAD_PROFILE=platform ramps to 10,000 concurrent users across
 * every load tenant; LOAD_PROFILE=tenant ramps to 500 users in one tenant. Each virtual user reads
 * the way Atlas does (me, projects, records, notifications) and creates a record on one iteration
 * in ten, with an Idempotency-Key, so reads and writes meet their own p95 objectives.
 */
const env = loadEnv(__ENV);
const profile = __ENV.LOAD_PROFILE === "tenant" ? "tenant" : "platform";
const vus = profile === "tenant" ? env.scale.tenantUsers : env.scale.platformUsers;

export const options = {
  scenarios: { [profile]: rampingScenario(vus, env.duration, "default") },
  thresholds: apiThresholds(),
  summaryTrendStats: ["avg", "p(50)", "p(95)", "p(99)", "max"],
};

const READS = ["/me", "/projects?limit=25", "/records?limit=50", "/notifications?limit=20"];

export function setup() {
  const sessions = signInAll(env);
  // A template for created records: the kind, scope and phase of a record the user can already read.
  const res = http.get(`${env.atlasUrl}/api/v1/records?limit=1`, {
    headers: apiHeaders(sessions[0].token),
    tags: { kind: "setup" },
  });
  const row = res.status === 200 ? res.json("data.0") : null;
  return { sessions, template: row };
}

export default function (data) {
  const { token } = sessionFor(data.sessions, __VU);
  for (const path of READS) {
    const res = http.get(`${env.atlasUrl}/api/v1${path}`, {
      headers: apiHeaders(token),
      tags: { kind: "read", name: `GET ${path.split("?")[0]}` },
    });
    check(res, { "read answers 200": (r) => r.status === 200 });
  }
  if (data.template && __ITER % 10 === 0) {
    const t = data.template;
    const body = {
      record_kind: t.record_kind,
      title: `Load check ${__VU}-${__ITER}`,
      scope_node_id: t.scope_node_id,
      phase_code: t.phase_code,
      xyz: t.xyz,
      external_visibility: t.external_visibility,
    };
    const res = http.post(`${env.atlasUrl}/api/v1/records`, JSON.stringify(body), {
      headers: apiHeaders(token, { "Content-Type": "application/json", "Idempotency-Key": uuid() }),
      tags: { kind: "write", name: "POST /records" },
    });
    check(res, { "write answers 201": (r) => r.status === 201 });
  }
  sleep(1);
}
