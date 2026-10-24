import type { XosClient } from "@xos/data";
import { enabledFlags, US_COMPLIANCE_FORMS_FLAG } from "@xos/data/feature-flags";
import { cache } from "react";
import type { OrgContext } from "@/lib/shell/context";

/**
 * Whether the org offers the OSHA Forms 300, 300A and 301 and the WH-347 certified payroll (ADR 0041). ADR 0033
 * decision 54 defers them past launch behind the compliance.us_forms flag, off by default (migration 1593): while it is
 * off, the three panels render nothing, their actions refuse and the forms route answers 404. The flags are read once
 * per request; the database refuses the forms' writes on its own, so this only shapes what Atlas shows.
 */
const flagsOf = cache((db: XosClient, orgId: string) => enabledFlags(db, orgId));

export async function usComplianceFormsOn(ctx: OrgContext): Promise<boolean> {
  const flags = await flagsOf(ctx.viewer.db, ctx.org.id);
  return flags.ok && flags.data.has(US_COMPLIANCE_FORMS_FLAG);
}
