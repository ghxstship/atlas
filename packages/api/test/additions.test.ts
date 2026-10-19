/**
 * Additive module operations (Section 10.1) never change a frozen operation (Section 18, gate 20).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "@hono/zod-openapi";
import { identity } from "@xos/schemas";
import { buildOpenApiDocument, catalog, frozenCatalog } from "../src/app.ts";
import { applyAdditions, defineAdditions } from "../src/catalog/additions.ts";
import { collectionQuery, itemAction, resource } from "../src/catalog/define.ts";
import {
  ADDITIONS_INDEX_FILE,
  handlerModules,
  ADDITIONS_DIR,
  renderAdditionsIndex,
} from "../src/codegen/handlers.ts";
import { MODULES } from "../src/catalog/types.ts";

type Json = Record<string, unknown>;
type Doc = { paths: Record<string, Record<string, Json>>; components: Record<string, Json> };

const METHODS = ["get", "post", "put", "patch", "delete"];

function operations(doc: Doc): Map<string, Json> {
  const out = new Map<string, Json>();
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of METHODS) {
      const op = item[method] as Json | undefined;
      if (op !== undefined) out.set(`${method} ${path}`, op);
    }
  }
  return out;
}

/** Every frozen operation and component is present, unchanged, in `doc`. */
function expectAdditive(frozen: Doc, doc: Doc): void {
  const before = operations(frozen);
  const after = operations(doc);
  for (const [key, op] of before) expect(after.get(key), key).toEqual(op);
  for (const [kind, entries] of Object.entries(frozen.components)) {
    for (const [name, value] of Object.entries(entries)) {
      expect(doc.components[kind]?.[name], `${kind}/${name}`).toEqual(value);
    }
  }
  const ids = [...after.values()].map((o) => o["operationId"]);
  expect(new Set(ids).size, "one operation per path and method").toBe(ids.length);
}

const frozenDoc = buildOpenApiDocument(frozenCatalog) as unknown as Doc;

const sample = defineAdditions("Identity", {
  resources: [
    resource("Identity", "/sample-blocks", identity.Block, {
      verbs: ["list", "get"],
      actions: [
        collectionQuery("resolve", {
          summary: "Resolve a sample block",
          description: "Resolves a sample block by subject.",
          query: z.object({
            subject: z
              .string()
              .min(1)
              .meta({ param: { name: "subject", in: "query" }, example: "x" }),
          }),
          paged: true,
        }),
      ],
    }),
  ],
  actions: {
    blocks: [
      itemAction("lift", {
        summary: "Lift a block",
        description: "Lifts a block before it expires.",
      }),
    ],
  },
  capabilities: {
    sampleBlocks: { read: "me.account.write", write: "me.account.write" },
    blocks: { actions: { lift: "me.account.write" } },
  },
});

describe("additive operations", () => {
  it("keeps the module additions index fresh, one file per module", async () => {
    expect(readFileSync(ADDITIONS_INDEX_FILE, "utf8")).toBe(await renderAdditionsIndex());
    expect(handlerModules(ADDITIONS_DIR)).toEqual([...MODULES]);
  });

  it("leaves every frozen operation unchanged in the published document", () => {
    expectAdditive(frozenDoc, buildOpenApiDocument() as unknown as Doc);
    expect(catalog.length).toBeGreaterThanOrEqual(frozenCatalog.length);
  });

  it("adds resources and actions without touching frozen operations", () => {
    const specs = applyAdditions(frozenCatalog, [sample]);
    const doc = buildOpenApiDocument(specs) as unknown as Doc;
    expectAdditive(frozenDoc, doc);
    const ops = operations(doc);
    expect(ops.get("get /sample-blocks/resolve")?.["operationId"]).toBe("sampleBlocks.resolve");
    expect(ops.get("post /blocks/{id}/lift")?.["x-xos-capability"]).toBe("me.account.write");
    expect(frozenCatalog.find((s) => s.op === "blocks")?.actions).toHaveLength(0);
  });

  it("refuses additions that would change or shadow the frozen contract", () => {
    const block = resource("Identity", "/blocks", identity.Block);
    expect(() =>
      applyAdditions(frozenCatalog, [defineAdditions("Identity", { resources: [block] })]),
    ).toThrow(/existing resource/);
    const samePath = resource("Identity", "/blocks", identity.Block, { op: "otherBlocks" });
    expect(() =>
      applyAdditions(frozenCatalog, [defineAdditions("Identity", { resources: [samePath] })]),
    ).toThrow(/existing path/);
    const wrongTag = resource("Finance", "/x-blocks", identity.Block);
    expect(() =>
      applyAdditions(frozenCatalog, [defineAdditions("Identity", { resources: [wrongTag] })]),
    ).toThrow(/tagged Finance/);
    const lift = itemAction("create", { summary: "s", description: "d." });
    expect(() =>
      applyAdditions(frozenCatalog, [
        defineAdditions("Identity", { actions: { joinRequests: [lift] } }),
      ]),
    ).toThrow(/collides/);
    expect(() =>
      applyAdditions(frozenCatalog, [defineAdditions("Identity", { actions: { nope: [] } })]),
    ).toThrow(/does not exist/);
    expect(() =>
      applyAdditions(frozenCatalog, [defineAdditions("Finance", { actions: { blocks: [] } })]),
    ).toThrow(/belongs to Identity/);
    expect(() =>
      applyAdditions(frozenCatalog, [
        defineAdditions("Identity", {
          actions: { blocks: [] },
          capabilities: { blocks: { read: "me.account.write" } },
        }),
      ]),
    ).toThrow(/only add action capabilities/);
    expect(() =>
      applyAdditions(frozenCatalog, [
        defineAdditions("Identity", {
          actions: { blocks: [] },
          capabilities: { blocks: { actions: { fly: "me.account.write" } } },
        }),
      ]),
    ).toThrow(/does not add/);
    expect(() =>
      applyAdditions(frozenCatalog, [
        defineAdditions("Identity", { capabilities: { ghosts: { read: "me.account.write" } } }),
      ]),
    ).toThrow(/does not add/);
  });
});
