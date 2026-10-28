/**
 * The archived filter on the v1 list operations (A124, migration 2180): records, work orders,
 * documents, venues, vendors and custom object records leave archived rows out of their lists unless
 * `archived=include` or `archived=only` asks for them. The parameter is added through a module's
 * `listQuery`, which applyAdditions keeps additive: optional, after the frozen parameters, on the
 * module's own list operations.
 */
import { describe, expect, it } from "vitest";
import { z } from "@hono/zod-openapi";
import { buildOpenApiDocument, frozenCatalog } from "../src/app.ts";
import { applyAdditions, defineAdditions } from "../src/catalog/additions.ts";
import { archivedListQuery } from "../src/catalog/modules/parts/archived-filter.ts";
import { handlers as knowledge } from "../src/handlers/knowledge.ts";
import { handlers as places } from "../src/handlers/places.ts";
import { contractApp, expectContract, testContext } from "./support/contract.ts";
import { memoryDb, tenantRow } from "./support/memory-db.ts";
import type { Row } from "./support/memory-db.ts";

const ORG = testContext().org?.id as string;
const id = (n: number) => `0192f1e2-7c3a-7b4d-9e8f-${String(12400 + n).padStart(12, "0")}`;
const ARCHIVED_AT = "2026-10-20T15:00:00Z";

type Doc = { paths: Record<string, Record<string, { operationId?: string; parameters?: Row[] }>> };

describe("archived filter in the document", () => {
  const doc = buildOpenApiDocument() as unknown as Doc;
  const parameters = (operationId: string) =>
    Object.values(doc.paths)
      .flatMap((item) => Object.values(item))
      .find((op) => op.operationId === operationId)?.parameters ?? [];

  it.each([
    "records.list",
    "workOrders.list",
    "documents.list",
    "venues.list",
    "vendors.list",
    "objects.list",
  ])("adds an optional archived parameter to %s", (operationId) => {
    const archived = parameters(operationId).find((p) => p["name"] === "archived");
    expect(archived).toMatchObject({
      in: "query",
      required: false,
      schema: { enum: ["include", "only"] },
    });
  });

  it("adds it to no read operation", () => {
    expect(parameters("records.get").some((p) => p["name"] === "archived")).toBe(false);
  });
});

describe("listQuery additions", () => {
  const venues = (query: z.ZodObject) =>
    applyAdditions(frozenCatalog, [defineAdditions("Places", { listQuery: { venues: query } })]);

  it("appends the parameters to the module's list operation", () => {
    expect(
      Object.keys(venues(archivedListQuery).find((s) => s.op === "venues")?.listQuery?.shape ?? {}),
    ).toEqual(["archived"]);
  });

  it("refuses a parameter that is not additive or not the module's", () => {
    expect(() => venues(z.object({ archived: z.enum(["only"]) }))).toThrow(/must be optional/);
    expect(() => venues(z.object({ limit: z.number().optional() }))).toThrow(/already has/);
    expect(() =>
      applyAdditions(frozenCatalog, [
        defineAdditions("Places", { listQuery: { venues: archivedListQuery } }),
        defineAdditions("Places", { listQuery: { venues: archivedListQuery } }),
      ]),
    ).toThrow(/already has/);
    expect(() =>
      applyAdditions(frozenCatalog, [
        defineAdditions("Work", { listQuery: { venues: archivedListQuery } }),
      ]),
    ).toThrow(/belongs to Places/);
    expect(() =>
      applyAdditions(frozenCatalog, [
        defineAdditions("Places", { listQuery: { nothing: archivedListQuery } }),
      ]),
    ).toThrow(/no list operation/);
  });
});

describe("archived filter in the handlers", () => {
  const LIVE = id(1);
  const OLD = id(2);
  const DOC = id(3);
  const OLD_DOC = id(4);
  const venue = (key: string, name: string, archivedAt: string | null) =>
    tenantRow(key, ORG, {
      name,
      street_address: null,
      locality: "Miami",
      postal_code: null,
      jurisdiction_id: "US-FL-MIAMI-DADE",
      time_zone: "America/New_York",
      venue_latitude: null,
      venue_longitude: null,
      archived_at: archivedAt,
    });
  const app = contractApp({
    handlers: [places, knowledge],
    db: memoryDb({
      venues: [
        venue(LIVE, "Northwind Pier Pavilion", null),
        venue(OLD, "Old Warehouse", ARCHIVED_AT),
      ],
      documents: [
        tenantRow(DOC, ORG, { title: "Rigging Plan", project_id: null, archived_at: null }),
        tenantRow(OLD_DOC, ORG, {
          title: "2025 Rigging Plan",
          project_id: null,
          archived_at: ARCHIVED_AT,
        }),
      ],
    }),
  });
  const ids = async (path: string, op: string) =>
    ((await expectContract(await app.request(path), op)) as { data: Row[] }).data.map(
      (r) => r["id"],
    );

  it("lists live venues by default, every venue with include and the archived ones with only", async () => {
    expect(await ids("/venues", "venues.list")).toEqual([LIVE]);
    expect((await ids("/venues?archived=include", "venues.list")).sort()).toEqual(
      [LIVE, OLD].sort(),
    );
    expect(await ids("/venues?archived=only", "venues.list")).toEqual([OLD]);
  });

  it("reads an archived venue by id", async () => {
    const read = (await expectContract(await app.request(`/venues/${OLD}`), "venues.get")) as Row;
    expect(read["id"]).toBe(OLD);
  });

  it("filters documents the same way", async () => {
    expect(await ids("/documents", "documents.list")).toEqual([DOC]);
    expect(await ids("/documents?archived=only", "documents.list")).toEqual([OLD_DOC]);
  });

  it("refuses a value it does not know", async () => {
    expect((await app.request("/venues?archived=yes")).status).toBe(422);
  });
});
