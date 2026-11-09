import { listRoleCapabilities } from "@xos/data";
import type { LoadOptions } from "@xos/data/documents/sources";
import type { XosClient } from "@xos/data/client";
import type { OrgContext } from "@/lib/shell/context";
import { getShellSettings } from "@/lib/shell/org-settings";
import { projectJurisdictionUnits, unitSystemFor } from "@/lib/workforce/units";

/**
 * What the wrap-up report's loader needs from the shell (B7, ADR 0146 decision 5): whether the reader holds
 * finance.journal.read across the org, the org capability check Atlas already makes from the reader's roles
 * (posted actuals are ledger rows, so the budget section and the summary need it), and the reader's units
 * (locale.units, following the project's jurisdiction as the measurement report does, A97).
 */
export async function wrapUpLoadOptions(
  ctx: OrgContext,
  db: XosClient,
  locale: string,
  projectId: string | null,
): Promise<Pick<LoadOptions, "ledgerRead" | "unitPreference">> {
  const [capabilities, shell, jurisdiction] = await Promise.all([
    listRoleCapabilities(
      db,
      ctx.org.roles.map((r) => r.id),
    ),
    getShellSettings(db, ctx.org.id, null),
    projectId ? projectJurisdictionUnits(db, projectId) : Promise.resolve(null),
  ]);
  return {
    ledgerRead: capabilities.ok && capabilities.data.get("finance.journal.read") === "organization",
    unitPreference: unitSystemFor(shell.preferences.units, jurisdiction, locale),
  };
}
