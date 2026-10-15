/**
 * Runtime fixes made with the A04P parity work: the router order is a total order, so a static
 * segment always wins over a parameter whatever order the routes arrive in, and an integer path
 * key is converted from its path string for validation while the document keeps it an integer.
 */
import { describe, expect, it } from "vitest";
import { handlers } from "../src/handlers/canon.ts";
import { compareRoutes, coercePathParams } from "../src/runtime/mount.ts";
import type { OperationRoute } from "../src/runtime/mount.ts";
import { contractApp, contractDocument, expectContract } from "./support/contract.ts";
import { memoryDb, requests, success } from "./support/memory-db.ts";
import { sample } from "./support/samples.ts";

const route = (path: string, method = "get") => ({ path, method }) as unknown as OperationRoute;

describe("compareRoutes", () => {
  it("puts a static segment before a parameter at the same position", () => {
    const routes = [route("/canon/elements/{element_id}"), route("/canon/elements/resolve")];
    expect(routes.sort(compareRoutes).map((r) => r.path)).toEqual([
      "/canon/elements/resolve",
      "/canon/elements/{element_id}",
    ]);
  });

  it("sorts to the same order whatever the input order", () => {
    const paths = [
      "/canon/acts/{act_code}",
      "/canon/elements/{element_id}",
      "/canon/element-gtins/resolve",
      "/canon/elements/resolve",
      "/canon/elements",
      "/canon/element-gtins/{gtin}",
      "/projects/{id}/archive",
      "/projects/{id}",
    ];
    const expected = paths
      .map((p) => route(p))
      .sort(compareRoutes)
      .map((r) => r.path);
    for (let shift = 1; shift < paths.length; shift += 1) {
      const rotated = [...paths.slice(shift), ...paths.slice(0, shift)].reverse();
      expect(
        rotated
          .map((p) => route(p))
          .sort(compareRoutes)
          .map((r) => r.path),
      ).toEqual(expected);
    }
    expect(expected.indexOf("/canon/elements/resolve")).toBeLessThan(
      expected.indexOf("/canon/elements/{element_id}"),
    );
    expect(compareRoutes(route("/projects", "get"), route("/projects", "post"))).toBeLessThan(0);
    expect(compareRoutes(route("/projects"), route("/projects"))).toBe(0);
  });
});

describe("integer path keys", () => {
  it("validates /canon/assertion-ranks/{rank} with the rank converted from the path", async () => {
    const rank = sample("CanonAssertionRank", { rank: 4 });
    const app = contractApp({
      handlers: [handlers],
      db: memoryDb({ "xpms.dim_assertion_rank": [rank] }),
    });
    const http = requests(app);
    const response = await http.get("/canon/assertion-ranks/4");
    const body = await expectContract(await success(response), "canonAssertionRanks.get");
    expect(body).toMatchObject({ rank: 4 });
    expect((await http.get("/canon/assertion-ranks/four")).status).toBe(422);
  });

  it("keeps the documented parameter an integer", () => {
    const op = contractDocument.paths["/canon/assertion-ranks/{rank}"]?.["get"] as {
      parameters: { name: string; schema: { type: string } }[];
    };
    expect(op.parameters.find((p) => p.name === "rank")?.schema.type).toBe("integer");
    expect(coercePathParams(undefined)).toBeUndefined();
  });
});
