/**
 * The archived filter (A124, migration 2180, Section 4.10): records, work orders, documents, venues,
 * vendors and custom object records keep `archived_at`, and their lists leave archived rows out
 * unless the request asks for them. Each module spreads `archivedListQuery` onto its list operations
 * through `listQuery`: one optional parameter, so a request without it reads what it read before.
 */
import { z } from "@hono/zod-openapi";

export const archivedListQuery = z.object({
  archived: z.enum(["include", "only"]).optional().meta({
    description:
      "Archived rows: left out when absent, listed with the others with `include`, or listed alone with `only`. Archived rows stay readable by id either way.",
    example: "include",
  }),
});
