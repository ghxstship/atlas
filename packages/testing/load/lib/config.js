// Shared configuration for the k6 load scripts (Section 5.1). k6 runs plain JavaScript, so the
// numbers here mirror packages/testing/src/budgets.ts; test/load-config.test.ts keeps them equal.

/** Section 5.1 service level objectives, in milliseconds. */
export const SLO = {
  readP95: 250,
  writeP95: 400,
  p99: 800,
  syncP95: 5000,
};

/** Section 5.1 load targets. */
export const TARGETS = {
  platformUsers: 10000,
  tenantUsers: 500,
  compassDevices: 1000,
};

/** Smoke scale: enough concurrency to prove the scripts, small enough for a laptop stack. */
export const SMOKE = {
  platformUsers: 20,
  tenantUsers: 10,
  compassDevices: 25,
};

const LOCAL_HOSTS = ["127.0.0.1", "localhost", "host.docker.internal"];

function hostOf(url) {
  const match = /^https?:\/\/([^/:]+)/.exec(url);
  return match ? match[1] : "";
}

/**
 * The run mode and its targets, from the environment. Smoke runs refuse any non-local target, so a
 * mistyped URL can never put load on a hosted environment. Full scale needs LOAD_MODE=full and
 * LOAD_CONFIRM_STAGING set to the staging host, run by the owner (docs: load/README.md).
 */
export function loadEnv(env) {
  const mode = env.LOAD_MODE === "full" ? "full" : "smoke";
  const supabaseUrl = env.SUPABASE_URL || "http://host.docker.internal:57421";
  const atlasUrl = env.ATLAS_URL || "http://host.docker.internal:3006";
  const anonKey = env.SUPABASE_ANON_KEY || "";
  if (!anonKey) throw new Error("SUPABASE_ANON_KEY is required (the stack's publishable key).");
  for (const url of [supabaseUrl, atlasUrl]) {
    const host = hostOf(url);
    if (mode === "smoke" && !LOCAL_HOSTS.includes(host)) {
      throw new Error(`Smoke runs only target a local stack; ${host} is not local.`);
    }
    if (mode === "full" && !LOCAL_HOSTS.includes(host) && env.LOAD_CONFIRM_STAGING !== host) {
      throw new Error(`Full runs against ${host} need LOAD_CONFIRM_STAGING=${host}.`);
    }
  }
  return {
    mode,
    supabaseUrl,
    atlasUrl,
    anonKey,
    password: env.LOAD_PASSWORD || "xos-demo-2026",
    users: (env.LOAD_USERS || "owner@example.com,producer@example.com,admin@example.com")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    scale: mode === "full" ? TARGETS : SMOKE,
    duration: env.LOAD_DURATION || (mode === "full" ? "10m" : "30s"),
  };
}

/** Ramp to `vus` and hold: a fifth of the run up, the rest at peak, a short ramp down. */
export function rampingScenario(vus, duration, exec) {
  const seconds = parseDuration(duration);
  const up = Math.max(1, Math.round(seconds / 5));
  const down = Math.max(1, Math.round(seconds / 10));
  return {
    executor: "ramping-vus",
    exec,
    startVUs: 0,
    stages: [
      { duration: `${up}s`, target: vus },
      { duration: `${Math.max(1, seconds - up - down)}s`, target: vus },
      { duration: `${down}s`, target: 0 },
    ],
    gracefulRampDown: "10s",
  };
}

export function parseDuration(text) {
  const match = /^(\d+)(s|m|h)$/.exec(text);
  if (!match) throw new Error(`Duration must look like 30s, 10m or 1h, got ${text}.`);
  const n = Number(match[1]);
  return match[2] === "h" ? n * 3600 : match[2] === "m" ? n * 60 : n;
}

/** Thresholds for the Section 5.1 objectives, tagged by request kind. */
export function apiThresholds() {
  return {
    "http_req_duration{kind:read}": [`p(95)<${SLO.readP95}`, `p(99)<${SLO.p99}`],
    "http_req_duration{kind:write}": [`p(95)<${SLO.writeP95}`, `p(99)<${SLO.p99}`],
    http_req_failed: ["rate<0.01"],
  };
}
