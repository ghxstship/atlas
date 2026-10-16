import { readFileSync } from "node:fs";
import { DOCUMENT_FILE } from "@/lib/openapi.ts";

export const dynamic = "force-static";

/** The OpenAPI 3.1 document the reference is built from, for download and for code generators. */
export function GET(): Response {
  return new Response(readFileSync(DOCUMENT_FILE, "utf8"), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
