import http from "k6/http";
import { check, fail } from "k6";

/**
 * Signs one load user in through Supabase Auth (password grant). Requests are tagged `kind:auth`, so
 * sign-in cost never counts against the read, write or sync objectives.
 */
export function signIn(env, email) {
  const res = http.post(
    `${env.supabaseUrl}/auth/v1/token?grant_type=password`,
    JSON.stringify({ email, password: env.password }),
    {
      headers: { apikey: env.anonKey, "Content-Type": "application/json" },
      tags: { kind: "auth" },
    },
  );
  if (!check(res, { "sign-in answers 200": (r) => r.status === 200 })) {
    fail(`sign-in failed for ${email}: ${res.status} ${res.body}`);
  }
  return { email, token: res.json("access_token") };
}

/**
 * The user a virtual user acts as, shared round-robin. Each virtual user signs in on its first
 * iteration and keeps the session, so 10,000 users never queue behind one setup().
 */
export function userFor(env, vu) {
  return env.users[(vu - 1) % env.users.length];
}

/** Headers for the public API (Bearer session JWT, ADR 0003). */
export function apiHeaders(token, extra = {}) {
  return { Authorization: `Bearer ${token}`, Accept: "application/json", ...extra };
}

/** Headers for PostgREST, as Compass sends them through supabase-js. */
export function restHeaders(env, token, extra = {}) {
  return {
    apikey: env.anonKey,
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

/** An RFC 4122 version 4 id for mutation ids and idempotency keys. */
export function uuid() {
  const hex = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < 36; i += 1) {
    if (i === 8 || i === 13 || i === 18 || i === 23) out += "-";
    else if (i === 14) out += "4";
    else if (i === 19) out += hex[8 + Math.floor(Math.random() * 4)];
    else out += hex[Math.floor(Math.random() * 16)];
  }
  return out;
}
