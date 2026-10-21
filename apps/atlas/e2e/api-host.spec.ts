import { expect, test, type Page } from "@playwright/test";
import { DEMO_ORG, signInAs } from "./a36-support";

/**
 * The API host (RRR-119, lib/api-host.ts), against an Atlas started with XOS_API_HOST. E2E_API_HOST
 * names the same host (CI: api.localhost). Requests reach the same server with that Host header, as
 * Vercel sends them for api.ghxstship.tech.
 */
const apiHost = process.env["E2E_API_HOST"];
test.skip(!apiHost, "Start Atlas with XOS_API_HOST and set E2E_API_HOST to the same host.");

const onApiHost = { host: apiHost ?? "" };

/** The access token in the page's Atlas session cookie (plain or chunked, `base64-` JSON). */
async function accessToken(page: Page): Promise<string> {
  const index = (name: string) => Number(name.split(".")[1] ?? "-1");
  const parts = (await page.context().cookies())
    .filter((c) => /^(__Host-)?xos-auth(\.\d+)?$/.test(c.name))
    .sort((a, b) => index(a.name) - index(b.name));
  const value = decodeURIComponent(parts.map((c) => c.value).join(""));
  const json = value.startsWith("base64-")
    ? Buffer.from(value.slice("base64-".length), "base64url").toString("utf8")
    : value;
  return (JSON.parse(json) as { access_token: string }).access_token;
}

test("the API host describes the API and serves no page or cookie", async ({ request }) => {
  const root = await request.get("/", { headers: onApiHost });
  expect(root.status()).toBe(200);
  const pointer = (await root.json()) as { versions: { v1: { base_url: string } } };
  expect(pointer.versions.v1.base_url).toMatch(new RegExp(`^https?://${apiHost}/v1$`));

  for (const path of ["/auth/sign-in", `/${DEMO_ORG}/home`, "/v2/projects"]) {
    const res = await request.get(path, { headers: onApiHost, maxRedirects: 0 });
    expect(res.status(), path).toBe(404);
    expect(res.headers()["content-type"], path).toBe("application/problem+json");
    expect(res.headers()["set-cookie"], path).toBeUndefined();
  }

  const document = await request.get("/v1/openapi.json", { headers: onApiHost });
  expect(document.status()).toBe(200);
  expect(((await document.json()) as { servers: { url: string }[] }).servers).toContainEqual(
    expect.objectContaining({ url: "https://api.ghxstship.tech/v1" }),
  );

  const anonymous = await request.get("/v1/canon/departments", { headers: onApiHost });
  expect(anonymous.status()).toBe(401);
  expect(((await anonymous.json()) as { instance: string }).instance).toBe("/v1/canon/departments");
});

test("a person's token reads the same rows on both hosts, with the same limits", async ({
  page,
  playwright,
  baseURL,
}) => {
  await signInAs(page, "producer@example.com", DEMO_ORG);
  const onAtlas = await page.request.get("/api/v1/vendors?limit=5");
  expect(onAtlas.status()).toBe(200);

  // A client of the API host holds a bearer token, never the Atlas cookie.
  const client = await playwright.request.newContext({ baseURL: baseURL ?? "" });
  const authorization = `Bearer ${await accessToken(page)}`;
  const onApi = await client.get("/v1/vendors?limit=5", {
    headers: { ...onApiHost, authorization },
  });
  expect(onApi.status()).toBe(200);
  const ids = async (res: typeof onApi) =>
    ((await res.json()) as { data: { id: string }[] }).data.map((row) => row.id);
  expect(await ids(onApi)).toEqual(await ids(onAtlas));
  expect(onApi.headers()["ratelimit-limit"]).toBe(onAtlas.headers()["ratelimit-limit"]);
  expect(onApi.headers()["set-cookie"]).toBeUndefined();

  // A server-to-server write sends no Origin. The page CSRF check never applies on the API host; the
  // API answers it as on Atlas's host.
  const write = await client.post("/v1/no-such-resource", {
    headers: { ...onApiHost, authorization },
    data: {},
  });
  expect(write.status()).toBe(404);
  expect(((await write.json()) as { type: string }).type).toBe("/problems/not-found");
  await client.dispose();
});
