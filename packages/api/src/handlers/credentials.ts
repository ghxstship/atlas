/**
 * Credentials handlers (A14, RRR-26): credential categories, issued credentials, the access grid,
 * scans, certifications and certification holders. Every read and write runs as the caller, so row
 * level security decides; the database sets each credential's issuer, number and project, refuses
 * self-issue (invariant 21), stamps revocation once, and decides every scan from the access grid at
 * its own time (migrations 0352, 0470). B8 (2970, 2972): a scan's direction, the supervisor override and the
 * training a category requires. See packages/api/README.md and ADR 0023.
 */
import { overrideScan, recordScan, revokeCredential } from "@xos/data/credentials";
import { defineHandlers, created, ok } from "../runtime/handler.ts";
import { handlersFor, tableResource, unwrap } from "./support/table.ts";

const categories = tableResource("credentialCategories");
const credentials = tableResource("credentials");
const grid = tableResource("accessGridEntries");
const scans = tableResource("accessScans", { softDelete: false });
const certifications = tableResource("certifications");
const holders = tableResource("certificationHolders");
const requirements = tableResource("credentialCategoryRequirements");

interface ScanBody {
  readonly credential_id: string;
  readonly zone_id: string;
  readonly device_scanned_at?: string | null;
  readonly offline_result?: "Granted" | "Denied" | null;
  readonly direction?: "In" | "Out";
}

export const handlers = defineHandlers("Credentials", {
  ...handlersFor("Credentials", categories),
  ...handlersFor("Credentials", credentials),
  ...handlersFor("Credentials", grid),
  ...handlersFor("Credentials", certifications),
  ...handlersFor("Credentials", holders),
  ...handlersFor("Credentials", requirements),
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
        ...(scan.direction ? { direction: scan.direction } : {}),
      }),
    );
    return created((await scans.read(context, decision.id)) as never);
  },

  // The override is a new Granted In row (app.override_access_scan, 2970): it answers that row.
  "accessScans.override": async ({ params, body }, context) => {
    await scans.read(context, params.id, ["id"]);
    const decision = unwrap(
      await overrideScan(context.db, {
        scanId: params.id,
        reason: body.reason,
        ...(body.id ? { id: body.id } : {}),
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
