/**
 * Section 18, gate 5: every documented operation that has a handler is exercised by a contract
 * test, and coverage reporting shows which operations have handlers.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { catalogOperationIds, handledOperations } from "../src/app.ts";
import { MODULES } from "../src/catalog/types.ts";
import { formatCoverage, operationCoverage, operationModules } from "../src/operation-coverage.ts";
import { contractOperations } from "./support/contract.ts";

const TEST_DIR = fileURLToPath(new URL("./", import.meta.url));

/** operationIds named in an `expectContract(response, "<operationId>"...)` call in any test file. */
function exercisedOperations(): Set<string> {
  const found = new Set<string>();
  for (const file of readdirSync(TEST_DIR).filter((f) => f.endsWith(".test.ts"))) {
    const text = readFileSync(`${TEST_DIR}${file}`, "utf8");
    for (const match of text.matchAll(
      /expectContract\(\s*[^,]+,\s*"([A-Za-z0-9]+\.[A-Za-z0-9]+)"/g,
    )) {
      found.add(match[1] as string);
    }
  }
  return found;
}

describe("operation coverage", () => {
  it("exercises every handled operation with a contract test", () => {
    const exercised = exercisedOperations();
    const unexercised = handledOperations().filter((id) => !exercised.has(id));
    expect(unexercised, "handled operations without an expectContract test").toEqual([]);
  });

  it("names only documented operations in contract tests", () => {
    for (const id of exercisedOperations()) expect(contractOperations.has(id), id).toBe(true);
  });

  it("reports handled and missing operations for every module", () => {
    const rows = operationCoverage();
    expect(rows.map((r) => r.module)).toEqual([...MODULES]);
    const total = rows.reduce((n, r) => n + r.documented, 0);
    expect(total).toBe(catalogOperationIds().length);
    expect(rows.flatMap((r) => r.handled)).toEqual(expect.arrayContaining(handledOperations()));
    const canon = rows.find((r) => r.module === "Canon");
    expect(canon?.handled).toContain("canonDepartments.list");
    expect(canon?.missing).not.toContain("canonDepartments.list");
    const table = formatCoverage(rows);
    expect(table).toMatch(/^Module/);
    expect(table).toMatch(/Total\s+\d+ \/ \d+/);
    expect(formatCoverage([{ module: "Home", documented: 0, handled: [], missing: [] }])).toContain(
      "0.0%",
    );
    expect(operationModules().get("canonDepartments.list")).toBe("Canon");
  });
});
