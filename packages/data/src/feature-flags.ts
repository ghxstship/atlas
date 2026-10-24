import type { XosClient } from "./client.ts";
import { rpc, str, type Raw } from "./platform-common.ts";
import type { Result } from "./result.ts";

/**
 * Feature flags as an org's members see them (A18, migration 0540; infra/runbooks/progressive-delivery.md). The server
 * reads app.org_feature_flags once per request and hides a feature whose flag is off. The database refuses that
 * feature's writes on its own through private.flag_enabled, so a flag is never enforced only in the UI.
 */

/**
 * The OSHA Forms 300, 300A and 301 and the WH-347 certified payroll (ADR 0041). Off by default until counsel answers
 * ADR 0041's open questions (ADR 0033 decision 54, migration 1593).
 */
export const US_COMPLIANCE_FORMS_FLAG = "compliance.us_forms";

/** The keys of the flags that are on for an org; none for someone who is not a member of it. */
export function enabledFlags(db: XosClient, orgId: string): Promise<Result<ReadonlySet<string>>> {
  return rpc(
    db,
    "org_feature_flags",
    { p_org_id: orgId },
    (d) =>
      new Set(
        ((d as Raw[] | null) ?? [])
          .filter((r) => r["enabled"] === true)
          .map((r) => str(r["flag_key"])),
      ),
  );
}
