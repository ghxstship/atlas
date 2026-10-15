/**
 * Canon handlers. Add one entry per operationId of the Canon module; operations left out stay
 * document-only. See "Adding handlers" in packages/api/README.md.
 *
 * Canon is read through the caller's client (`client.schema("xpms")`), so grants decide access.
 */
import type { Components } from "../contract/operations.generated.ts";
import { notFound } from "../problem.ts";
import { defineHandlers, ok } from "../runtime/handler.ts";
import { listPage } from "../runtime/listing.ts";
import { selectColumns } from "../runtime/pagination.ts";

type Department = Components["CanonDepartment"];

const DEPARTMENT_COLUMNS = ["dept_code", "department", "source", "note"] as const;

export const handlers = defineHandlers("Canon", {
  // Coded list: the default order is numeric code order by dept_code (ADR 0003).
  "canonDepartments.list": async ({ query }, { db }) =>
    ok(
      await listPage<Department>(db.schema("xpms").from("dim_department"), query, {
        columns: DEPARTMENT_COLUMNS,
        key: "dept_code",
        defaultOrder: ["dept_code"],
      }),
    ),

  "canonDepartments.get": async ({ params, query }, { db }) => {
    const columns = selectColumns(query.fields, DEPARTMENT_COLUMNS, "dept_code");
    const { data, error } = await db
      .schema("xpms")
      .from("dim_department")
      .select(columns.join(","))
      .eq("dept_code", String(params.dept_code))
      .maybeSingle();
    if (error !== null) throw error;
    if (data === null) {
      throw notFound(`No department with code ${params.dept_code} is visible to you.`);
    }
    return ok(data as unknown as Department);
  },
});
