import { assetLinksFile } from "@/lib/handoff";

/** App Links to Compass (ADR 0030): Android verifies the app against this file. */
export const dynamic = "force-dynamic";

export function GET(): Response {
  return assetLinksFile();
}
