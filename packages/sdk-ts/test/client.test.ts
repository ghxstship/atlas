/** Runtime behavior against the contract test server: conventions from ADR 0003 and 0007. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Project } from "../src/index.ts";
import {
  OPERATIONS,
  XosApiError,
  XosAuthenticationError,
  XosBadRequestError,
  XosClient,
  XosConflictError,
  XosNetworkError,
  XosNotFoundError,
  XosPreconditionFailedError,
  XosPreconditionRequiredError,
  XosRateLimitError,
  XosRefusalError,
  XosServerError,
  XosValidationError,
  errorForProblem,
  parseRetryAfter,
} from "../src/index.ts";
import type { ContractServer } from "./contract/server.ts";
import { startContractServer } from "./contract/server.ts";

let server: ContractServer;
let sleeps: number[];
let client: XosClient;

const project = { name: "Harborfront Summer Series", tier_code: "04", currency: "USD" } as const;

beforeAll(async () => {
  server = await startContractServer();
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  sleeps = [];
  server.requests.length = 0;
  client = new XosClient({
    baseUrl: `${server.baseUrl}/`,
    apiKey: server.apiKey,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
});

describe("construction", () => {
  it("refuses a missing base URL, two credentials and a missing fetch", () => {
    expect(() => new XosClient({ baseUrl: "" })).toThrow(/baseUrl/);
    expect(() => new XosClient({ baseUrl: "http://x", apiKey: "a", accessToken: "b" })).toThrow(
      /only one/,
    );
    expect(
      () => new XosClient({ baseUrl: "http://x", fetch: 1 as unknown as typeof fetch }),
    ).toThrow(/fetch/);
  });

  it("strips a trailing slash from the base URL", () => {
    expect(client.baseUrl).toBe(server.baseUrl);
  });

  it("refreshes tokens through getToken on every request", async () => {
    let calls = 0;
    const refreshing = new XosClient({
      baseUrl: server.baseUrl,
      getToken: async () => {
        calls++;
        return server.apiKey;
      },
    });
    await refreshing.projects.list();
    await refreshing.projects.list();
    expect(calls).toBe(2);
  });

  it("sends an access token as a bearer credential", async () => {
    const bearer = new XosClient({ baseUrl: server.baseUrl, accessToken: server.apiKey });
    await expect(bearer.projects.list()).resolves.toMatchObject({ status: 200 });
  });
});

describe("create, read, update, delete", () => {
  it("round-trips a project with ETag concurrency", async () => {
    const created = await client.projects.create(project);
    expect(created.status).toBe(201);
    expect(created.etag).toMatch(/^W\//);
    expect(created.rateLimit).toEqual({ limit: 600, remaining: 599, reset: 60 });
    const id = created.data.id;

    const read = await client.projects.get(id);
    expect(read.data.name).toBe(project.name);

    const updated = await client.projects.update(
      id,
      { name: "Harborfront Fall Series" },
      { ifMatch: read.etag as string },
    );
    expect(updated.data.name).toBe("Harborfront Fall Series");

    await expect(
      client.projects.update(id, { name: "Stale" }, { ifMatch: read.etag as string }),
    ).rejects.toBeInstanceOf(XosPreconditionFailedError);

    const deleted = await client.projects.delete(id);
    expect(deleted.status).toBe(204);
    expect(deleted.data).toBeUndefined();
    await expect(client.projects.get(id)).rejects.toBeInstanceOf(XosNotFoundError);
  });

  it("returns a sparse fieldset", async () => {
    const { data } = await client.projects.create(project);
    const read = await client.projects.get(data.id, { fields: ["name"] });
    expect(Object.keys(read.data).sort()).toEqual(["id", "name"]);
  });

  it("refuses an update without ifMatch before sending it", async () => {
    await expect(client.projects.update("x", {}, {} as { ifMatch: string })).rejects.toThrow(
      /ifMatch/,
    );
  });

  it("maps a missing If-Match to XosPreconditionRequiredError", async () => {
    const { data } = await client.projects.create(project);
    const spec = { ...OPERATIONS["projects.update"], ifMatch: false };
    await expect(client.request(spec, { path: { id: data.id }, body: {} })).rejects.toBeInstanceOf(
      XosPreconditionRequiredError,
    );
  });
});

describe("idempotency", () => {
  it("generates a key per call and reuses it across retries", async () => {
    server.failNext({ status: 503 });
    await client.projects.create(project);
    const posts = server.requests.filter((r) => r.method === "POST");
    expect(posts).toHaveLength(2);
    const [first, second] = posts.map((r) => r.headers["idempotency-key"]);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).toBe(first);
    expect(sleeps).toEqual([500]);
  });

  it("replays the original response for a repeated caller key", async () => {
    const a = await client.projects.create(project, { idempotencyKey: "import-row-000001" });
    const b = await client.projects.create(project, { idempotencyKey: "import-row-000001" });
    expect(b.data.id).toBe(a.data.id);
    expect(b.headers.get("Idempotent-Replayed")).toBe("true");
    expect(server.rows("/projects").filter((r) => r["id"] === a.data.id)).toHaveLength(1);
  });

  it("raises XosConflictError when a key is reused with another body", async () => {
    await client.projects.create(project, { idempotencyKey: "import-row-000002" });
    await expect(
      client.projects.create(
        { ...project, name: "Other" },
        { idempotencyKey: "import-row-000002" },
      ),
    ).rejects.toBeInstanceOf(XosConflictError);
  });

  it("uses a custom key generator", async () => {
    const custom = new XosClient({
      baseUrl: server.baseUrl,
      apiKey: server.apiKey,
      idempotencyKey: () => "fixed-key-123",
    });
    await custom.projects.create(project);
    expect(server.requests.at(-1)?.headers["idempotency-key"]).toBe("fixed-key-123");
  });
});

describe("pagination and filters", () => {
  it("pages with cursors and iterates every item", async () => {
    for (let i = 0; i < 5; i++) await client.projects.create({ ...project, name: `Paging ${i}` });
    const first = await client.projects.list({
      limit: 2,
      filter: { name: { contains: "Paging" } },
    });
    expect(first.data).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await client.projects.list({
      limit: 2,
      cursor: first.nextCursor as string,
      filter: { name: { contains: "Paging" } },
    });
    expect(second.data[0]?.name).toBe("Paging 2");

    const names: string[] = [];
    for await (const p of client.projects.listAll({
      limit: 2,
      filter: { name: { contains: "Paging" } },
      sort: ["-name"],
    })) {
      names.push(p.name);
    }
    expect(names).toEqual(["Paging 4", "Paging 3", "Paging 2", "Paging 1", "Paging 0"]);
  });

  it("serializes every filter operator in the documented grammar", async () => {
    await client.projects.list({
      filter: {
        name: { eq: "A", ne: "B", contains: "C", in: ["D", "E"] },
        tier_code: { lt: 5, lte: 5, gt: 1, gte: 1 },
        description: { is_null: true },
      },
      fields: "id,name",
      sort: "name",
    });
    const query = server.requests.at(-1)?.query as URLSearchParams;
    expect(query.get("filter[name][in]")).toBe("D,E");
    expect(query.get("filter[tier_code][lte]")).toBe("5");
    expect(query.get("filter[description][is_null]")).toBe("true");
    expect(query.get("fields")).toBe("id,name");
  });

  it("filters with in and is_null", async () => {
    await client.projects.create({ ...project, name: "Filter A", description: null });
    const page = await client.projects.list({
      filter: { name: { in: ["Filter A"] }, description: { is_null: true } },
    });
    expect(page.data.map((p: Project) => p.name)).toEqual(["Filter A"]);
  });

  it("refuses malformed queries before sending them", async () => {
    await expect(
      client.projects.list({ filter: { "Bad Field": { eq: "x" } } as never }),
    ).rejects.toThrow(/field name/);
    await expect(
      client.projects.list({ filter: { name: { like: "x" } } as never }),
    ).rejects.toThrow(/operator/);
    await expect(client.projects.list({ filter: { name: { eq: {} as never } } })).rejects.toThrow(
      /string/,
    );
    await expect(
      client.request(OPERATIONS["projects.get"], { path: { id: "x" }, query: { limit: 1 } }),
    ).rejects.toThrow(/not a paged/);
    await expect(
      client.request(OPERATIONS["projects.create"], { query: { fields: "id" }, body: project }),
    ).rejects.toThrow(/fieldset/);
    await expect(
      client.request(OPERATIONS["projects.list"], { query: { bogus: 1 } }),
    ).rejects.toThrow(/no query parameter/);
    await expect(client.request(OPERATIONS["projects.get"], {})).rejects.toThrow(/path parameter/);
    await expect(client.request(OPERATIONS["canonElements.resolve"], {})).rejects.toThrow(
      /requires the query parameter/,
    );
    await expect(
      client.request(OPERATIONS["projects.delete"], { path: { id: "x" }, body: {} }),
    ).rejects.toThrow(/no request body/);
    await expect(client.request(OPERATIONS["projects.create"], {})).rejects.toThrow(
      /requires a request body/,
    );
    await expect(
      client.requestPage(OPERATIONS["projects.get"], { path: { id: "x" } }),
    ).rejects.toThrow(/not a paged list/);
  });

  it("passes operation-specific query parameters", async () => {
    const result = await client.canonElements.resolve({ query: "stage deck" });
    expect(result.status).toBe(200);
    expect(server.requests.at(-1)?.query.get("query")).toBe("stage deck");
  });
});

describe("problem errors", () => {
  it("raises XosRefusalError with the refusal and reason", async () => {
    const { data } = await client.projects.create(project);
    const error = await client.projects
      .transition(data.id, { expected_state: "Closed", to_state: "Active" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(XosRefusalError);
    const refusal = error as XosRefusalError;
    expect(refusal.refusal).toBe("REFUSE");
    expect(refusal.reason).toMatch(/not Closed/);
    expect(refusal.rule).toBeNull();
    expect(refusal.status).toBe(422);
    expect(refusal.operationId).toBe("projects.transition");
  });

  it("raises XosValidationError with JSON Pointers", async () => {
    const error = await client.projects
      .create({ name: "", tier_code: "04", currency: "usd" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(XosValidationError);
    expect((error as XosValidationError).errors.map((e) => e.pointer).sort()).toEqual([
      "/currency",
      "/name",
    ]);
  });

  it("raises XosAuthenticationError for a bad key", async () => {
    const bad = new XosClient({ baseUrl: server.baseUrl, apiKey: "xos_live_wrong" });
    await expect(bad.projects.list()).rejects.toBeInstanceOf(XosAuthenticationError);
  });

  it("raises XosBadRequestError for an out-of-range limit", async () => {
    await expect(client.projects.list({ limit: 500 })).rejects.toBeInstanceOf(XosBadRequestError);
  });

  it("raises XosRateLimitError after the retries run out, honoring Retry-After", async () => {
    for (let i = 0; i < 3; i++) server.failNext({ status: 429, headers: { "Retry-After": "2" } });
    const error = await client.projects.list().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(XosRateLimitError);
    expect((error as XosRateLimitError).retryAfterSeconds).toBe(2);
    expect(sleeps).toEqual([2000, 2000]);
  });

  it("raises XosServerError for a 500, and a generic XosApiError for other statuses", async () => {
    const noRetry = new XosClient({
      baseUrl: server.baseUrl,
      apiKey: server.apiKey,
      maxRetries: 0,
    });
    server.failNext({ status: 500 });
    await expect(noRetry.projects.list()).rejects.toBeInstanceOf(XosServerError);
    server.failNext({
      status: 418,
      body: "short and stout",
      headers: { "Content-Type": "text/plain" },
    });
    const error = await noRetry.projects.list().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(XosApiError);
    expect((error as XosApiError).problem).toMatchObject({
      type: "about:blank",
      status: 418,
      detail: "short and stout",
    });
  });

  it("maps every documented status to its error class", () => {
    const h = new Headers();
    const p = (status: number, extra: object = {}) => ({
      type: "/problems/x",
      title: "X",
      status,
      ...extra,
    });
    expect(errorForProblem("o", p(400), h)).toBeInstanceOf(XosBadRequestError);
    expect(errorForProblem("o", p(401), h)).toBeInstanceOf(XosAuthenticationError);
    expect(errorForProblem("o", p(404), h)).toBeInstanceOf(XosNotFoundError);
    expect(errorForProblem("o", p(409), h)).toBeInstanceOf(XosConflictError);
    expect(errorForProblem("o", p(412), h)).toBeInstanceOf(XosPreconditionFailedError);
    expect(errorForProblem("o", p(428), h)).toBeInstanceOf(XosPreconditionRequiredError);
    expect(
      errorForProblem("o", p(422, { refusal: "UNRATIFIED", reason: "r", rule: "sod.po" }), h),
    ).toBeInstanceOf(XosRefusalError);
    expect(
      (
        errorForProblem(
          "o",
          p(422, { refusal: "REFUSE", reason: "r", rule: "sod.po" }),
          h,
        ) as XosRefusalError
      ).rule,
    ).toBe("sod.po");
    expect((errorForProblem("o", p(422), h) as XosValidationError).errors).toEqual([]);
    expect(errorForProblem("o", p(429), h)).toBeInstanceOf(XosRateLimitError);
    expect((errorForProblem("o", p(429), h) as XosRateLimitError).retryAfterSeconds).toBeNull();
    expect(errorForProblem("o", p(503), h)).toBeInstanceOf(XosServerError);
    expect(errorForProblem("o", p(418), h).message).toBe("o failed with 418 X");
  });

  it("parses Retry-After as seconds or an HTTP date", () => {
    expect(parseRetryAfter(null, 0)).toBeNull();
    expect(parseRetryAfter("", 0)).toBeNull();
    expect(parseRetryAfter("5", 0)).toBe(5);
    expect(parseRetryAfter("-5", 0)).toBe(0);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 0)).toBe(10);
    expect(parseRetryAfter("soon", 0)).toBeNull();
  });
});

describe("transport failures", () => {
  it("retries network failures, then raises XosNetworkError", async () => {
    const down = new XosClient({
      baseUrl: "http://127.0.0.1:9/api/v1",
      apiKey: "k",
      sleep: async (ms) => void sleeps.push(ms),
    });
    const error = await down.projects.list().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(XosNetworkError);
    expect((error as XosNetworkError).timedOut).toBe(false);
    expect(sleeps).toEqual([500, 1000]);
  });

  it("raises a timed-out XosNetworkError", async () => {
    const slow = new XosClient({
      baseUrl: server.baseUrl,
      apiKey: server.apiKey,
      maxRetries: 0,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    });
    const error = await slow.projects.list(undefined, { timeoutMs: 20 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(XosNetworkError);
    expect((error as XosNetworkError).timedOut).toBe(true);
    expect((error as Error).message).toMatch(/timed out/);
  });

  it("rethrows the caller's own abort without retrying", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stopped by caller"));
    await expect(client.projects.list(undefined, { signal: controller.signal })).rejects.toThrow(
      "stopped by caller",
    );
  });

  it("raises XosNetworkError for malformed JSON and for a page without data", async () => {
    const noRetry = new XosClient({
      baseUrl: server.baseUrl,
      apiKey: server.apiKey,
      maxRetries: 0,
    });
    server.failNext({ status: 200, body: "{", headers: { "Content-Type": "text/plain" } });
    const odd = await noRetry.request(OPERATIONS["home.get"], {});
    expect(odd.data).toBe("{");
    const broken = new XosClient({
      baseUrl: server.baseUrl,
      apiKey: server.apiKey,
      maxRetries: 0,
      fetch: async () =>
        new Response("{not json", { status: 200, headers: { "Content-Type": "application/json" } }),
    });
    await expect(broken.projects.get("x")).rejects.toThrow(/malformed JSON/);
    const pageless = new XosClient({
      baseUrl: server.baseUrl,
      apiKey: server.apiKey,
      fetch: async () => Response.json({ items: [] }),
    });
    await expect(pageless.projects.list()).rejects.toThrow(/without a data array/);
  });

  it("ignores rate limit headers that are not numbers", async () => {
    const odd = new XosClient({
      baseUrl: server.baseUrl,
      apiKey: server.apiKey,
      fetch: async () =>
        Response.json(
          { person_id: "p" },
          {
            headers: { "RateLimit-Limit": "x", "RateLimit-Remaining": "1", "RateLimit-Reset": "1" },
          },
        ),
    });
    expect((await odd.me.get()).rateLimit).toBeNull();
  });
});
