/**
 * Every operation in the OpenAPI document is reachable through the generated client, sends a
 * request the contract accepts, and gets a response that validates against its schema.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPERATIONS, XosClient } from "../src/index.ts";
import type { ContractServer } from "./contract/server.ts";
import { startContractServer } from "./contract/server.ts";
import { inputFor } from "./contract/inputs.ts";
import { camelCase } from "../codegen/names.ts";

let server: ContractServer;
let client: XosClient;

beforeAll(async () => {
  server = await startContractServer({ seedOnMiss: true });
  client = new XosClient({ baseUrl: server.baseUrl, apiKey: server.apiKey, maxRetries: 0 });
});

afterAll(async () => {
  await server.close();
});

describe("every operation", () => {
  it("covers all operations in the document with a generated method", () => {
    expect(Object.keys(OPERATIONS)).toHaveLength(server.operations.length);
    const missing = server.operations.filter((op) => {
      const resource = (client as unknown as Record<string, Record<string, unknown>>)[
        camelCase(op.resource)
      ];
      return typeof resource?.[camelCase(op.verb)] !== "function";
    });
    expect(missing.map((op) => op.id)).toEqual([]);
  });

  it("calls each operation through its generated method and validates the response", async () => {
    const failures: string[] = [];
    for (const op of server.operations) {
      const input = inputFor(op);
      const resource = (
        client as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>
      )[camelCase(op.resource)] as Record<string, (...args: unknown[]) => unknown>;
      const method = resource[camelCase(op.verb)] as (...args: unknown[]) => Promise<unknown>;
      const args: unknown[] = op.pathParams.map((p) => input.path[p.name]);
      let body = input.body;
      if (op.verb === "transition") {
        // Compare-and-set: name the state the row is in now.
        const read = (await resource["get"]?.call(resource, ...args)) as {
          data: Record<string, unknown>;
        };
        const field = Object.keys(read.data).find((k) => k.endsWith("_state")) as string;
        body = { ...(body as object), expected_state: read.data[field] };
      }
      if (op.body) args.push(body);
      const hasParams = op.paged || op.fields || op.queryParams.length > 0;
      if (hasParams) args.push(Object.keys(input.query).length > 0 ? input.query : undefined);
      let ifMatch: string | undefined;
      if (op.ifMatch) {
        const getter = server.operations.find(
          (o) => o.resource === op.resource && o.verb === "get",
        );
        const read = (await resource["get"]?.call(
          resource,
          ...op.pathParams.map((p) => input.path[p.name]),
        )) as { etag: string | null } | undefined;
        ifMatch = read?.etag ?? undefined;
        if (!getter || !ifMatch) failures.push(`${op.id}: no ETag to update with`);
      }
      args.push(op.ifMatch ? { ifMatch } : undefined);
      try {
        await method.apply(resource, args);
      } catch (error) {
        failures.push(`${op.id}: ${String(error)}`);
      }
    }
    expect(failures).toEqual([]);
    expect(server.violations).toEqual([]);
    const called = new Set(server.requests.map((r) => r.operationId));
    expect(server.operations.filter((op) => !called.has(op.id)).map((op) => op.id)).toEqual([]);
  });
});
