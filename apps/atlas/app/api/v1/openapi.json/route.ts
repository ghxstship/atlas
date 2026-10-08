/**
 * GET /api/v1/openapi.json: the generated OpenAPI 3.1 document (Section 10.1).
 * The document is generated in `packages/api` and served as built; no operation handlers are
 * mounted here until their modules implement them.
 */
import document from "@xos/api/openapi/v1.json" with { type: "json" };

export const dynamic = "force-static";

export function GET(): Response {
  return Response.json(document, {
    headers: { "Cache-Control": "public, max-age=300, stale-while-revalidate=86400" },
  });
}
