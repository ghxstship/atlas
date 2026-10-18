import { appleAssociationFile } from "@/lib/handoff";

/** Universal links to Compass (ADR 0030): Apple reads this file, served as JSON with no extension. */
export const dynamic = "force-dynamic";

export function GET(): Response {
  return appleAssociationFile();
}
