/**
 * Contract tests for A50's handlers (Section 18, gate 5, RRR-94): the operations that had no
 * handler after Wave 6, module by module. Requests run through `contractApp` against the in-memory
 * client and every success is checked against openapi/v1.json with `expectContract`. Row level
 * security, the column guards and the lifecycle RPCs are the database's; here RPCs are stand-ins
 * that refuse the way the database does, so refusals (422) and hidden rows (404) are covered too.
 */
import { describe, expect, it } from "vitest";
import { handlers as finance } from "../src/handlers/finance.ts";
import { contractApp, expectContract, testContext } from "./support/contract.ts";
import { memoryDb, requests, success, tenantRow } from "./support/memory-db.ts";

const ORG = testContext().org?.id as string;
const id = (n: number) => `0192f1e2-7c3a-7b4d-9e8f-${String(50000 + n).padStart(12, "0")}`;
const MISSING = id(9999);

describe("Finance: price books", () => {
  const BOOK = id(101);

  function world() {
    const db = memoryDb({
      price_books: [tenantRow(BOOK, ORG, { name: "Standard Client Rates", currency_code: "USD" })],
    });
    return { db, http: requests(contractApp({ handlers: [finance], db })) };
  }

  it("lists, reads, creates, updates and deletes price books", async () => {
    const { http } = world();
    const page = (await expectContract(
      await success(http.get("/price-books")),
      "priceBooks.list",
    )) as { data: { name: string }[] };
    expect(page.data.map((b) => b.name)).toEqual(["Standard Client Rates"]);
    await expectContract(await success(http.get(`/price-books/${BOOK}`)), "priceBooks.get");
    expect((await http.get(`/price-books/${MISSING}`)).status).toBe(404);
    const create = await success(
      http.post("/price-books", { name: "Euro Rates", currency_code: "EUR" }),
    );
    const made = (await expectContract(create, "priceBooks.create")) as { currency_code: string };
    expect(made.currency_code).toBe("EUR");
    const update = await success(http.patch(`/price-books/${BOOK}`, { name: "Client Rates 2027" }));
    await expectContract(update, "priceBooks.update");
    await expectContract(await success(http.delete(`/price-books/${BOOK}`)), "priceBooks.delete");
    expect((await http.get(`/price-books/${BOOK}`)).status).toBe(404);
  });
});
