import * as enums from "./enums.generated.ts";
import type { Database, XosClient } from "./client.ts";
import { blankToNull, deletedNow, insertedId, readRows, touched } from "./commercial-common.ts";
import { type Result } from "./result.ts";

/**
 * Maintenance schedules (B11, RRR-235, G-95, migration 6534). A plan says what is due and how often, on one unit or on
 * every serviceable unit of a class. The due date and status are computed (app.asset_maintenance_due) on the org's
 * calendar; a log entry naming the plan moves the next due date.
 */

type Tables = Database["app"]["Tables"];
export type MaintenanceIntervalUnit = Database["app"]["Enums"]["maintenance_interval_unit"];

export const MAINTENANCE_INTERVAL_UNITS: readonly MaintenanceIntervalUnit[] =
  enums.maintenanceIntervalUnit;

/** The computed statuses of app.asset_maintenance_due. */
export const MAINTENANCE_DUE_STATUSES = ["Pending", "Overdue", "Completed"] as const;
export type MaintenanceDueStatus = (typeof MAINTENANCE_DUE_STATUSES)[number];

export interface MaintenanceDue {
  readonly planId: string;
  readonly unitId: string;
  readonly assetTag: string;
  readonly className: string;
  readonly title: string;
  readonly instructions: string | null;
  readonly everyCount: number | null;
  readonly everyUnit: MaintenanceIntervalUnit | null;
  readonly lastPerformedOn: string | null;
  readonly dueOn: string | null;
  readonly status: MaintenanceDueStatus;
}

/** Plans by unit, the soonest due first; one unit's when it is named. */
export async function listMaintenanceDue(
  db: XosClient,
  scope: { readonly orgId: string } | { readonly unitId: string },
): Promise<Result<MaintenanceDue[]>> {
  const query =
    "unitId" in scope
      ? db.from("asset_maintenance_due").select("*").eq("asset_unit_id", scope.unitId)
      : db.from("asset_maintenance_due").select("*").eq("org_id", scope.orgId);
  return readRows(query.order("due_on", { nullsFirst: false }).order("asset_tag"), (row) => ({
    planId: row.plan_id ?? "",
    unitId: row.asset_unit_id ?? "",
    assetTag: row.asset_tag ?? "",
    className: row.class_name ?? "",
    title: row.title ?? "",
    instructions: row.instructions,
    everyCount: row.every_count,
    everyUnit: row.every_unit,
    lastPerformedOn: row.last_performed_on,
    dueOn: row.due_on,
    status: (row.due_status ?? "Pending") as MaintenanceDueStatus,
  }));
}

export interface MaintenancePlanInput {
  readonly assetUnitId: string | null;
  readonly assetClassId: string | null;
  readonly title: string;
  readonly instructions: string | null;
  readonly firstDueOn: string;
  readonly everyCount: number | null;
  readonly everyUnit: MaintenanceIntervalUnit | null;
}

export async function createMaintenancePlan(
  db: XosClient,
  orgId: string,
  input: MaintenancePlanInput,
): Promise<Result<{ id: string }>> {
  return insertedId(
    db
      .from("asset_maintenance_plans")
      .insert({
        org_id: orgId,
        asset_unit_id: input.assetUnitId,
        asset_class_id: input.assetClassId,
        title: input.title.trim(),
        instructions: blankToNull(input.instructions),
        first_due_on: input.firstDueOn,
        every_count: input.everyCount,
        every_unit: input.everyUnit,
      } as Tables["asset_maintenance_plans"]["Insert"])
      .select("id")
      .single(),
  );
}

export async function deleteMaintenancePlan(db: XosClient, id: string): Promise<Result<null>> {
  return touched(db.from("asset_maintenance_plans").update(deletedNow()).eq("id", id).select("id"));
}
