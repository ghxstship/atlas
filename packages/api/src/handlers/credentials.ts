/**
 * Credentials handlers (A14, RRR-26): credential categories, issued credentials, the access grid,
 * scans, certifications and certification holders. Every read and write runs as the caller, so row
 * level security decides; the database sets each credential's issuer, number and project, refuses
 * self-issue (invariant 21), stamps revocation once, and decides every scan from the access grid at
 * its own time (migrations 0352, 0470). See packages/api/README.md and ADR 0023.
 */
import { recordScan, revokeCredential } from "@xos/data/credentials";
import { defineHandlers, created, ok } from "../runtime/handler.ts";
import { handlersFor, tableResource, unwrap } from "./support/table.ts";

const categories = tableResource("credentialCategories");
const credentials = tableResource("credentials");
const grid = tableResource("accessGridEntries");
const scans = tableResource("accessScans", { softDelete: false });
const certifications = tableResource("certifications");
const holders = tableResource("certificationHolders");

interface ScanBody {
  readonly credential_id: string;
  readonly zone_id: string;
  readonly device_scanned_at?: string | null;
  readonly offline_result?: "Granted" | "Denied" | null;
}

export const handlers = defineHandlers("Credentials", {
  ...handlersFor("Credentials", categories),
  ...handlersFor("Credentials", credentials),
  ...handlersFor("Credentials", grid),
  ...handlersFor("Credentials", certifications),
  ...handlersFor("Credentials", holders),
  "accessScans.list": scans.handlers["accessScans.list"] as never,
  "accessScans.get": scans.handlers["accessScans.get"] as never,

  // A scan goes through app.record_scan: the database decides the result, and an
  // Idempotency-Key replay is answered by the runtime before this runs.
  "accessScans.create": async ({ body }, context) => {
    const scan = body as unknown as ScanBody;
    const decision = unwrap(
      await recordScan(context.db, {
        zoneId: scan.zone_id,
        credentialId: scan.credential_id,
        ...(scan.device_scanned_at ? { deviceAt: scan.device_scanned_at } : {}),
        ...(scan.offline_result ? { offlineResult: scan.offline_result } : {}),
      }),
    );
    return created((await scans.read(context, decision.id)) as never);
  },

  "credentials.revoke": async ({ params }, context) => {
    await credentials.read(context, params.id, ["id"]);
    unwrap(await revokeCredential(context.db, params.id));
    return ok((await credentials.read(context, params.id)) as never);
  },
});
