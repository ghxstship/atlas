import { databaseEnums } from "@xos/config/database-enums";
import { describe, expect, it } from "vitest";
import { AUTOMATION_ACTION_TYPES, FILTER_OPERATORS } from "../src/automations/model.ts";
import { CAPABILITY_CLASSES, CAPABILITY_REACHES, NAV_GROUPS } from "../src/capabilities/model.ts";
import * as common from "../src/common/enums.ts";
import { NOTIFICATION_CHANNELS } from "../src/notifications/model.ts";
import type { dbValueType } from "../src/settings/model.ts";
import { SHELL_LABELS } from "../src/shortcuts/model.ts";
import { SAVED_VIEW_TYPES } from "../src/views/model.ts";

/**
 * @xos/data depends on this package, so its lists of database enum values cannot read Constants
 * (ADR 0120). Each is held here to the same values as its enum, in any order.
 */
// A Record over a union type must name each member once, so its keys are the union's members.
const valueTypes: Record<ReturnType<typeof dbValueType>, true> = {
  Text: true,
  Boolean: true,
  Integer: true,
  Choice: true,
};

const lists: readonly (readonly [string, readonly string[]])[] = [
  ["xpms.refusal", common.Refusal.options],
  ["app.opportunity_state", common.OpportunityState.options],
  ["app.application_state", common.ApplicationState.options],
  ["app.engagement_state", common.EngagementState.options],
  ["app.accounting_period_state", common.AccountingPeriodState.options],
  ["app.import_row_state", common.ImportRowState.options],
  ["app.reconciliation_result", common.ReconciliationResult.options],
  ["app.external_role_type", common.ExternalRoleType.options],
  ["app.project_role", common.ProjectRole.options],
  ["app.account_role", common.AccountRole.options],
  ["app.opportunity_visibility", common.OpportunityVisibility.options],
  ["app.profile_visibility", common.ProfileVisibility.options],
  ["app.pool_standing", common.PoolLevel.options],
  ["app.rate_type", common.RateType.options],
  ["app.data_classification", common.Classification.options],
  ["app.representation_scope", common.RepresentationScope.options],
  ["app.fulfillment_kind", common.FulfillmentKind.options],
  ["app.export_format", common.ExportFormat.options],
  ["app.filter_operator", FILTER_OPERATORS],
  ["app.automation_action_type", AUTOMATION_ACTION_TYPES],
  ["app.capability_class", CAPABILITY_CLASSES],
  ["app.capability_reach", CAPABILITY_REACHES],
  ["app.nav_group", NAV_GROUPS],
  ["app.notification_channel", NOTIFICATION_CHANNELS],
  ["app.setting_value_type", Object.keys(valueTypes)],
  ["app.shortcut_shell", Object.values(SHELL_LABELS)],
  ["app.view_type", SAVED_VIEW_TYPES],
];

describe("lists that mirror a database enum", () => {
  const enums = databaseEnums();
  it.each(lists)("%s", (name, values) => {
    expect([...values].sort()).toEqual([...(enums[name] ?? [])].sort());
  });
});
