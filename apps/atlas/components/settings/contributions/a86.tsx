import {
  ApiKeysPanel,
  MyTokensPanel,
  OrgPersonalTokensPanel,
  ServiceAccountsPanel,
  WebhooksPanel,
} from "../surfaces/developer";
import {
  AutomationsPanel,
  CanonExtensionsPanel,
  CustomFieldsPanel,
  SeparationOfDutiesPanel,
  SpendAuthorityPanel,
} from "../surfaces/governance";
import {
  AuditLogPanel,
  DataRequestsPanel,
  DepartmentsPanel,
  ExportsAndRetentionPanel,
  LegalHoldsPanel,
  LocationDefaultsPanel,
  MeteredUsagePanel,
} from "../surfaces/org";
import { ConnectedAppsPanel, PayoutTaxPanel } from "../surfaces/personal";
import type { SettingsContribution } from "./types";

/**
 * A86's settings panels (RRR-131, finding A65-004): every settings section that rendered only its empty state
 * gets a surface over the backend it already had, or the small model A86 added (migrations 1430 to 1434). The
 * panels live in ../surfaces/ by area; apps/atlas/test/settings-surfaces.test.ts fails if any section ships
 * empty again. Partner and Templates are A61's panels, which landed first; Usage shows A61's usage against the
 * plan, then A86's metered usage.
 */
export const contributions: readonly SettingsContribution[] = [
  // Org settings, Section 4.5.6 items 8 to 40.
  { node: "settings.departments-and-disciplines", order: 10, Panel: DepartmentsPanel },
  { node: "settings.locations-and-venues", order: 10, Panel: LocationDefaultsPanel },
  { node: "settings.canon-extensions", order: 10, Panel: CanonExtensionsPanel },
  { node: "settings.custom-fields", order: 10, Panel: CustomFieldsPanel },
  { node: "settings.automations", order: 10, Panel: AutomationsPanel },
  { node: "settings.spend-authority", order: 10, Panel: SpendAuthorityPanel },
  { node: "settings.separation-of-duties", order: 10, Panel: SeparationOfDutiesPanel },
  { node: "settings.api-keys-and-service-accounts", order: 10, Panel: ServiceAccountsPanel },
  { node: "settings.api-keys-and-service-accounts", order: 20, Panel: ApiKeysPanel },
  { node: "settings.api-keys-and-service-accounts", order: 30, Panel: OrgPersonalTokensPanel },
  { node: "settings.webhooks", order: 10, Panel: WebhooksPanel },
  // A61's usage against the plan comes first; the metered usage by billing month follows it.
  { node: "settings.usage", order: 20, Panel: MeteredUsagePanel },
  { node: "settings.data-and-privacy", order: 10, Panel: DataRequestsPanel },
  { node: "settings.data-and-privacy", order: 20, Panel: LegalHoldsPanel },
  { node: "settings.data-and-privacy", order: 30, Panel: ExportsAndRetentionPanel },
  { node: "settings.audit-log", order: 10, Panel: AuditLogPanel },
  // Personal settings, items 11, 13 and 15.
  { node: "me.payout-and-tax", order: 10, Panel: PayoutTaxPanel },
  { node: "me.connected-apps", order: 10, Panel: ConnectedAppsPanel },
  { node: "me.developer", order: 10, Panel: MyTokensPanel },
];
