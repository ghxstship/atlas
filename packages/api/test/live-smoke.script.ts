/**
 * Manual smoke run against the shared local stack: `npx tsx test/live-smoke.script.ts`.
 * Reads XOS_API_LIVE_URL and XOS_API_LIVE_ANON_KEY; signs in (or signs up) a local test user.
 */
import { createApiApp } from "../src/app.ts";
import { createSupabaseAuthenticator } from "../src/runtime/auth.ts";

const url = process.env["XOS_API_LIVE_URL"] ?? "http://127.0.0.1:56021";
const anonKey = process.env["XOS_API_LIVE_ANON_KEY"] ?? "";
const email = "a04r-api-smoke@example.test";
const password = ["a04r", "smoke", "local", "1234"].join("-");
const headers = { apikey: anonKey, "content-type": "application/json" };
let res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers,
  body: JSON.stringify({ email, password }),
});
if (res.status !== 200) {
  res = await fetch(`${url}/auth/v1/signup`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email, password }),
  });
}
const session = (await res.json()) as { access_token?: string };
console.log("session", res.status, session.access_token !== undefined);
const app = createApiApp({
  authenticate: createSupabaseAuthenticator({ url, anonKey, siteOrigin: "http://localhost:3000" }),
  validateResponses: true,
  onError: (e) => console.error(e),
});
for (const path of [
  "/canon/departments?limit=3",
  "/canon/departments/4000",
  "/canon/departments/9000",
  "/projects",
]) {
  const r = await app.request(path, {
    headers: { authorization: `Bearer ${session.access_token}` },
  });
  console.log(path, r.status, (await r.text()).slice(0, 240));
}
console.log("anonymous", (await app.request("/canon/departments")).status);
