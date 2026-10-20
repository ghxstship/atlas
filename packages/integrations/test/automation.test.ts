import { createHash, createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

/**
 * The Zapier and Make apps (packages/integrations/automation; A83, finding A65-013) against the public API v1: every
 * request they make names an operation of packages/api/openapi/v1.json, sends only fields its request schema
 * defines and every field it requires, and every webhook event they subscribe to is a domain event type the
 * migrations register. No request leaves the test.
 */

type Json = Record<string, unknown>;
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const openapi = JSON.parse(read("../../api/openapi/v1.json")) as {
  paths: Record<string, Record<string, Json>>;
  components: { schemas: Record<string, Json>; parameters: Record<string, Json> };
};

/** Every domain event type code the migrations insert into private.domain_event_types. */
function eventTypes(): Set<string> {
  const codes = new Set<string>();
  const dir = new URL("../../../supabase/migrations/", import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql"))) {
    const sql = readFileSync(new URL(file, dir), "utf8");
    for (const block of sql.matchAll(/insert into private\.domain_event_types[^;]*;/gi)) {
      for (const m of block[0].matchAll(/\(\s*'([a-z_]+\.[a-z_]+)'/g)) codes.add(m[1] as string);
    }
  }
  return codes;
}
const EVENTS = eventTypes();

function resolve(schema: Json | undefined): Json {
  const ref = schema?.["$ref"];
  if (typeof ref === "string")
    return openapi.components.schemas[ref.split("/").pop() as string] as Json;
  return schema ?? {};
}

/** The operation for a method and a concrete or templated path, or undefined. */
function operation(method: string, path: string): { template: string; op: Json } | undefined {
  const clean = path.replace(/\{\{[^}]+\}\}/g, "x").split("?")[0] as string;
  for (const [template, item] of Object.entries(openapi.paths)) {
    const pattern = new RegExp(`^${template.replace(/\{[^}]+\}/g, "[^/]+")}$`);
    const op = item[method.toLowerCase()];
    if (pattern.test(clean) && op) return { template, op };
  }
  return undefined;
}

function requestSchema(op: Json): { properties: string[]; required: string[] } {
  const body = (op["requestBody"] as Json | undefined)?.["content"] as
    Record<string, Json> | undefined;
  const schema = resolve(body?.["application/json"]?.["schema"] as Json | undefined);
  return {
    properties: Object.keys((schema["properties"] as Json | undefined) ?? {}),
    required: (schema["required"] as string[] | undefined) ?? [],
  };
}

/** Properties of the items a list operation returns. */
function listItemProperties(op: Json): string[] {
  const ok = (op["responses"] as Record<string, Json>)["200"] as Json;
  const page = resolve(
    ((ok["content"] as Record<string, Json>)["application/json"] as Json)["schema"] as Json,
  );
  const data = (page["properties"] as Record<string, Json>)["data"] as Json;
  return Object.keys((resolve(data["items"] as Json)["properties"] as Json | undefined) ?? {});
}

function expectBody(method: string, path: string, body: Json, label: string) {
  const found = operation(method, path);
  expect(found, `${label}: ${method} ${path} is an operation of v1`).toBeDefined();
  const schema = requestSchema(found?.op ?? {});
  for (const key of Object.keys(body))
    expect(schema.properties, `${label}: ${key} is a field of the request`).toContain(key);
  return schema;
}

// Zapier -----------------------------------------------------------------------------------------------------------

interface ZRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  params?: Record<string, unknown>;
  body?: Json;
}

class ZError extends Error {
  readonly status: number | undefined;
  constructor(message: string, _type?: string, status?: number) {
    super(message);
    this.status = status;
  }
}

function loadZapier() {
  const source = read("../automation/zapier/index.js");
  const pkg = JSON.parse(read("../automation/zapier/package.json")) as Json;
  const mod: { exports: Json } = { exports: {} };
  const requireFake = (name: string) => {
    if (name === "./package.json") return pkg;
    if (name === "zapier-platform-core")
      return {
        version: pkg["dependencies"] && (pkg["dependencies"] as Json)["zapier-platform-core"],
      };
    throw new Error(`The Zapier app requires ${name}, which a published app cannot load.`);
  };
  const wrapped = new vm.Script(
    `(function (module, exports, require) {${source}\n})`,
  ).runInThisContext() as (m: typeof mod, e: Json, r: typeof requireFake) => void;
  wrapped(mod, mod.exports, requireFake);
  return mod.exports as {
    version: string;
    platformVersion: string;
    authentication: {
      fields: { key: string }[];
      test: (z: unknown, b: unknown) => Promise<unknown>;
    };
    beforeRequest: ((r: ZRequest, z: unknown, b: unknown) => ZRequest)[];
    afterResponse: ((r: { status: number; content: string }, z: unknown) => unknown)[];
    triggers: Record<
      string,
      { operation: Record<string, (z: unknown, b: unknown) => Promise<unknown> | unknown> }
    >;
    creates: Record<
      string,
      {
        operation: {
          inputFields: { key: string; required?: boolean }[];
          perform: (z: unknown, b: unknown) => Promise<unknown>;
        };
      }
    >;
    searches: Record<
      string,
      {
        operation: {
          inputFields: { key: string }[];
          perform: (z: unknown, b: unknown) => Promise<unknown>;
        };
      }
    >;
  };
}

function fakeZ(
  data: unknown = { data: [{ id: "row-1", updated_at: "2027-06-30T12:00:00Z", project_id: "p" }] },
) {
  const calls: ZRequest[] = [];
  const z = {
    calls,
    request: async (request: ZRequest) => {
      calls.push(request);
      return {
        status: 200,
        data,
        content: JSON.stringify(data),
        headers: new Map([["etag", '"v7"']]),
      };
    },
    hash: (algorithm: string, text: string, key?: string) =>
      key === undefined
        ? createHash(algorithm).update(text).digest("hex")
        : createHmac(algorithm, key).update(text).digest("hex"),
    errors: { Error: ZError, HaltedError: ZError },
  };
  return z;
}

const app = loadZapier();
const BASE = "https://api.example.test/v1";
const auth = { api_key: ["xos", "live", "f".repeat(48)].join("_"), base_url: `${BASE}/` };
const pathOf = (url: string) => url.replace(BASE, "");

describe("Zapier app", () => {
  it("loads like a Zapier CLI app and authenticates with an org API key against me.get", async () => {
    expect(app.version).toBe("1.0.0");
    expect(app.platformVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(app.authentication.fields.map((f) => f.key)).toEqual(["api_key", "base_url"]);
    const z = fakeZ({ person_id: "p" });
    await app.authentication.test(z, { authData: auth });
    expect(z.calls[0]?.url).toBe(`${BASE}/me`);
    expect(operation("GET", "/me")?.op["operationId"]).toBe("me.get");
    const signed = app.beforeRequest[0]?.({ method: "GET", url: "x" }, z, { authData: auth });
    expect(signed?.headers?.["Authorization"]).toBe(`Bearer ${auth.api_key}`);
    expect(
      app.beforeRequest[0]?.({ method: "GET", url: "x" }, z, { authData: {} }).headers,
    ).toBeUndefined();
    const defaulted = fakeZ({});
    await app.authentication.test(defaulted, { authData: { api_key: "k" } });
    expect(defaulted.calls[0]?.url).toBe("https://api.ghxstship.tech/v1/me");
  });

  it("turns API problems into errors with their detail", () => {
    const after = app.afterResponse[0] as (
      r: { status: number; content: string },
      z: unknown,
    ) => unknown;
    const z = fakeZ();
    expect(after({ status: 200, content: "{}" }, z)).toEqual({ status: 200, content: "{}" });
    expect(() =>
      after({ status: 422, content: JSON.stringify({ detail: "Title is required." }) }, z),
    ).toThrow("Title is required.");
    expect(() => after({ status: 500, content: "oops" }, z)).toThrow("oops");
  });

  it("subscribes each trigger to a registered event through webhookEndpoints and unsubscribes it", async () => {
    expect(Object.keys(app.triggers)).toHaveLength(7);
    for (const [key, trigger] of Object.entries(app.triggers)) {
      const z = fakeZ({ webhook_endpoint_id: "we-1", signing_secret: "s" });
      const bundle = { authData: auth, targetUrl: "https://hooks.zapier.test/1", inputData: {} };
      expect(await trigger.operation["performSubscribe"]?.(z, bundle)).toEqual({
        webhook_endpoint_id: "we-1",
        signing_secret: "s",
      });
      const subscribe = z.calls[0] as ZRequest;
      const schema = expectBody(subscribe.method, pathOf(subscribe.url), subscribe.body ?? {}, key);
      for (const field of schema.required)
        expect(subscribe.body, `${key} sends ${field}`).toHaveProperty(field);
      expect(subscribe.headers?.["Idempotency-Key"]).toMatch(/^[0-9a-f]{64}$/);
      const events = (subscribe.body?.["events"] as string[]) ?? [];
      expect(events).toHaveLength(1);
      expect(EVENTS.has(events[0] as string), `${events[0]} is a registered domain event`).toBe(
        true,
      );
      await trigger.operation["performUnsubscribe"]?.(z, {
        authData: auth,
        subscribeData: { webhook_endpoint_id: "we-1" },
      });
      expect(operation("DELETE", pathOf(z.calls[1]?.url ?? ""))?.op["operationId"]).toBe(
        "webhookEndpoints.delete",
      );
      const samples = (await trigger.operation["performList"]?.(fakeZ(), {
        authData: auth,
      })) as Json[];
      expect(samples[0]).toMatchObject({ id: "row-1", type: events[0], data: { id: "row-1" } });
    }
  });

  it("samples each trigger from a v1 list operation with real list parameters", async () => {
    for (const [key, trigger] of Object.entries(app.triggers)) {
      const z = fakeZ();
      await trigger.operation["performList"]?.(z, { authData: auth });
      const list = operation("GET", pathOf(z.calls[0]?.url ?? ""));
      expect(String(list?.op["operationId"]), key).toMatch(/\.list$/);
      const params = ((list?.op["parameters"] as Json[]) ?? []).map((p) =>
        String(p["$ref"] ?? p["name"]),
      );
      expect(params).toContain("#/components/parameters/Limit");
      expect(params).toContain("#/components/parameters/Sort");
      expect(listItemProperties(list?.op ?? {})).toContain("updated_at");
    }
  });

  it("accepts only deliveries signed with the endpoint's secret", () => {
    const perform = app.triggers["record_created"]?.operation["perform"] as (
      z: unknown,
      b: unknown,
    ) => unknown[];
    const secret = "whsec-fixture";
    const body = JSON.stringify({ id: "e1", type: "record.created" });
    const t = String(Math.floor(Date.now() / 1000));
    const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
    const bundle = (header: string) => ({
      subscribeData: { signing_secret: secret },
      rawRequest: { headers: { "Http-Xos-Signature": header }, content: body },
      cleanedRequest: JSON.parse(body) as Json,
    });
    const z = fakeZ();
    expect(perform(z, bundle(`t=${t},v1=${"0".repeat(64)},v1=${v1}`))).toEqual([
      { id: "e1", type: "record.created" },
    ]);
    expect(() => perform(z, bundle(`t=${t},v1=${"0".repeat(64)}`))).toThrow("does not match");
    expect(() => perform(z, bundle(`t=${Number(t) - 600},v1=${v1}`))).toThrow("Stale");
    expect(() => perform(z, bundle(""))).toThrow("Stale");
    expect(perform(z, { rawRequest: {}, cleanedRequest: { id: "e2" } })).toEqual([{ id: "e2" }]);
  });

  it("creates only through v1 operations, with every field the request requires", async () => {
    for (const [key, create] of Object.entries(app.creates)) {
      const inputData = Object.fromEntries(
        create.operation.inputFields.map((f) => [f.key, `value-${f.key}`]),
      );
      const z = fakeZ({ id: "new-1" });
      await create.operation.perform(z, { authData: auth, inputData });
      const write = z.calls[z.calls.length - 1] as ZRequest;
      const schema = expectBody(write.method, pathOf(write.url), write.body ?? {}, key);
      const required = create.operation.inputFields.filter((f) => f.required).map((f) => f.key);
      for (const field of schema.required)
        expect(required, `${key} asks for ${field}`).toContain(field);
      if (write.method === "POST")
        expect(write.headers?.["Idempotency-Key"]).toMatch(/^[0-9a-f]{64}$/);
      if (write.method === "PATCH") {
        expect(write.headers?.["If-Match"]).toBe('"v7"');
        expect(operation("GET", pathOf(z.calls[0]?.url ?? ""))?.op["operationId"]).toBe(
          "records.get",
        );
        expect(write.body).not.toHaveProperty("id");
      }
    }
    const z = fakeZ({ id: "new-2" });
    await app.creates["create_venue"]?.operation.perform(z, {
      authData: auth,
      inputData: {
        name: "Pier 9",
        street_address: "",
        jurisdiction_id: "US-FL-MIAMI-DADE",
        time_zone: "America/New_York",
      },
    });
    expect(z.calls[0]?.body).toEqual({
      name: "Pier 9",
      jurisdiction_id: "US-FL-MIAMI-DADE",
      time_zone: "America/New_York",
    });
  });

  it("searches v1 lists by a field the items carry", async () => {
    for (const [key, search] of Object.entries(app.searches)) {
      const field = search.operation.inputFields[0]?.key as string;
      const z = fakeZ({ data: [{ id: "r" }] });
      expect(
        await search.operation.perform(z, { authData: auth, inputData: { [field]: "NWL-24" } }),
      ).toEqual([{ id: "r" }]);
      const call = z.calls[0] as ZRequest;
      const list = operation("GET", pathOf(call.url));
      expect(String(list?.op["operationId"]), key).toMatch(/\.list$/);
      expect(listItemProperties(list?.op ?? {})).toContain(field);
      expect(call.params).toEqual({ [`filter[${field}][eq]`]: "NWL-24", limit: 1 });
    }
  });
});

// Make -------------------------------------------------------------------------------------------------------------

interface MakeCall {
  url: string;
  method: string;
  headers?: Record<string, string>;
  qs?: Record<string, string>;
  body?: Json;
}

const make = JSON.parse(read("../automation/make/xos.make.json")) as {
  base: { baseUrl: string; headers: Record<string, string> };
  connections: { name: string; communication: MakeCall }[];
  webhooks: {
    name: string;
    parameters: { options: { value: string }[] }[];
    attach: MakeCall;
    detach: MakeCall;
  }[];
  modules: {
    name: string;
    type: string;
    webhook?: string;
    connection?: string;
    communication: MakeCall | MakeCall[];
    mappableParameters?: { name: string; required?: boolean }[];
  }[];
};

describe("Make app", () => {
  it("authenticates with an org API key against me.get", () => {
    expect(make.base.headers["Authorization"]).toBe("Bearer {{connection.apiKey}}");
    const test = make.connections[0]?.communication as MakeCall;
    expect(
      operation(test.method, test.url.replace("{{parameters.baseUrl}}", ""))?.op["operationId"],
    ).toBe("me.get");
  });

  it("attaches its instant trigger through webhookEndpoints, for registered events only", () => {
    const hook = make.webhooks[0];
    expect(hook).toBeDefined();
    const schema = expectBody(
      hook?.attach.method ?? "",
      hook?.attach.url ?? "",
      hook?.attach.body ?? {},
      "attach",
    );
    for (const field of schema.required) expect(hook?.attach.body).toHaveProperty(field);
    expect(hook?.attach.headers?.["Idempotency-Key"]).toBe("{{uuid}}");
    expect(operation(hook?.detach.method ?? "", hook?.detach.url ?? "")?.op["operationId"]).toBe(
      "webhookEndpoints.delete",
    );
    for (const option of hook?.parameters[0]?.options ?? []) {
      expect(EVENTS.has(option.value), `${option.value} is a registered domain event`).toBe(true);
    }
    expect(make.modules.filter((m) => m.type === "instant_trigger").map((m) => m.webhook)).toEqual([
      hook?.name,
    ]);
  });

  it("acts and searches only through v1 operations, sending every field the request requires", () => {
    for (const module of make.modules.filter((m) => m.type !== "instant_trigger")) {
      expect(module.connection).toBe("xos-api-key");
      const calls = Array.isArray(module.communication)
        ? module.communication
        : [module.communication];
      const params = (module.mappableParameters ?? []).map((p) => p.name);
      for (const call of calls) {
        const found = operation(call.method, call.url);
        expect(found, `${module.name}: ${call.method} ${call.url}`).toBeDefined();
        if (call.body) {
          const schema = expectBody(call.method, call.url, call.body, module.name);
          for (const field of schema.required)
            expect(call.body, `${module.name} sends ${field}`).toHaveProperty(field);
        }
        if (call.method === "POST") expect(call.headers?.["Idempotency-Key"]).toBe("{{uuid}}");
        if (call.method === "PATCH") expect(call.headers?.["If-Match"]).toBe("{{temp.etag}}");
        for (const key of Object.keys(call.qs ?? {})) {
          const filter = /^filter\[([a-z_]+)\]\[eq\]$/.exec(key)?.[1];
          if (filter !== undefined) expect(listItemProperties(found?.op ?? {})).toContain(filter);
          else expect(key).toBe("limit");
        }
        for (const ref of JSON.stringify(call).matchAll(/parameters\.([a-z_]+)/g)) {
          expect(params, `${module.name} defines ${ref[1]}`).toContain(ref[1]);
        }
      }
    }
  });
});
