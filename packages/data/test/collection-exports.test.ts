import { describe, expect, it } from "vitest";
import type { XosClient } from "../src/client.ts";
import { requestCollectionExport } from "../src/collection-exports.ts";

/**
 * Asking for an export (A102, migrations 2030 and 2381): every filter reaches app.request_export in the shape it
 * reads, and a null test (a page's default, such as Projects hiding archived projects) names its column and no value.
 */
describe("requestCollectionExport", () => {
  it("sends each filter as app.request_export reads it, a null test without a value", async () => {
    const calls: unknown[][] = [];
    const db = {
      rpc: async (...args: unknown[]) => {
        calls.push(args);
        return { data: "exp-1", error: null };
      },
    } as unknown as XosClient;
    const result = await requestCollectionExport(db, {
      orgId: "org-1",
      format: "CSV",
      label: "Projects",
      relation: "app.projects",
      columns: ["project_key", "name"],
      headers: ["Key", "Name"],
      filters: [
        { operator: "is_null", column: "archived_at" },
        { operator: "not_null", column: "venue_id" },
        { operator: "in", column: "project_state", value: "Active,Planning" },
        { operator: "search", value: "summer" },
      ],
    });
    expect(result).toEqual({ ok: true, data: "exp-1" });
    expect(calls).toStrictEqual([
      [
        "request_export",
        {
          p_org_id: "org-1",
          p_format: "CSV",
          p_source_label: "Projects",
          p_columns: ["app.projects.project_key", "app.projects.name"],
          p_headers: ["Key", "Name"],
          p_filters: [
            { operator: "is_null", column: "archived_at" },
            { operator: "not_null", column: "venue_id" },
            { operator: "in", column: "project_state", value: "Active,Planning" },
            { operator: "search", value: "summer" },
          ],
        },
      ],
    ]);
  });
});
