/**
 * The Section 17 connector catalog, mirroring `private.integration_providers` (migration 0600). The
 * database is the source of truth: a connection to a provider outside this list, or without the plan
 * feature listed here, is refused there. Display names live in the `integrations` i18n namespace.
 */

export const INTEGRATION_CATEGORIES = [
  "Accounting",
  "Calendar",
  "Storage",
  "Communication",
  "Payroll",
  "Shipping",
  "Ticketing",
] as const;
export type IntegrationCategory = (typeof INTEGRATION_CATEGORIES)[number];

export type PlanFeature = "upl_export" | "payroll_export";

export interface ProviderEntry {
  readonly code: string;
  readonly category: IntegrationCategory;
  readonly sortOrder: number;
  readonly requiredFeature: PlanFeature | null;
  readonly needsCredential: boolean;
}

export const PROVIDERS = [
  {
    code: "xero",
    category: "Accounting",
    sortOrder: 10,
    requiredFeature: "upl_export",
    needsCredential: true,
  },
  {
    code: "quickbooks_online",
    category: "Accounting",
    sortOrder: 11,
    requiredFeature: "upl_export",
    needsCredential: true,
  },
  {
    code: "netsuite",
    category: "Accounting",
    sortOrder: 12,
    requiredFeature: "upl_export",
    needsCredential: true,
  },
  {
    code: "ramp",
    category: "Accounting",
    sortOrder: 13,
    requiredFeature: "upl_export",
    needsCredential: true,
  },
  {
    code: "google_calendar",
    category: "Calendar",
    sortOrder: 20,
    requiredFeature: null,
    needsCredential: true,
  },
  {
    code: "microsoft_365",
    category: "Calendar",
    sortOrder: 21,
    requiredFeature: null,
    needsCredential: true,
  },
  {
    code: "google_drive",
    category: "Storage",
    sortOrder: 30,
    requiredFeature: null,
    needsCredential: true,
  },
  {
    code: "onedrive_sharepoint",
    category: "Storage",
    sortOrder: 31,
    requiredFeature: null,
    needsCredential: true,
  },
  {
    code: "dropbox",
    category: "Storage",
    sortOrder: 32,
    requiredFeature: null,
    needsCredential: true,
  },
  {
    code: "slack",
    category: "Communication",
    sortOrder: 40,
    requiredFeature: null,
    needsCredential: true,
  },
  {
    code: "microsoft_teams",
    category: "Communication",
    sortOrder: 41,
    requiredFeature: null,
    needsCredential: true,
  },
  {
    code: "gusto",
    category: "Payroll",
    sortOrder: 50,
    requiredFeature: "payroll_export",
    needsCredential: true,
  },
  {
    code: "adp",
    category: "Payroll",
    sortOrder: 51,
    requiredFeature: "payroll_export",
    needsCredential: true,
  },
  {
    code: "rippling",
    category: "Payroll",
    sortOrder: 52,
    requiredFeature: "payroll_export",
    needsCredential: true,
  },
  {
    code: "ups",
    category: "Shipping",
    sortOrder: 60,
    requiredFeature: null,
    needsCredential: true,
  },
  {
    code: "fedex",
    category: "Shipping",
    sortOrder: 61,
    requiredFeature: null,
    needsCredential: true,
  },
  {
    code: "dhl",
    category: "Shipping",
    sortOrder: 62,
    requiredFeature: null,
    needsCredential: true,
  },
  {
    code: "ticketing_csv",
    category: "Ticketing",
    sortOrder: 70,
    requiredFeature: null,
    needsCredential: false,
  },
  {
    code: "ticketing_api",
    category: "Ticketing",
    sortOrder: 71,
    requiredFeature: null,
    needsCredential: true,
  },
] as const satisfies readonly ProviderEntry[];

export type ProviderCode = (typeof PROVIDERS)[number]["code"];

export const SYNC_SCOPES = [
  "Ledger Export",
  "Payment Sync",
  "Calendar Sync",
  "File Import",
  "Notification Delivery",
  "Payroll Export",
  "Tracking Refresh",
  "Attendance Import",
] as const;
export type SyncScope = (typeof SYNC_SCOPES)[number];

export type SyncDirection = "Inbound" | "Outbound" | "Two Way";

export type SyncRunState = "Queued" | "Running" | "Succeeded" | "Retrying" | "Failed" | "Canceled";

export type ConnectionState = "Pending" | "Connected" | "Error" | "Paused" | "Disconnected";

export type IntegrationEntity =
  | "Record"
  | "Shift"
  | "Payment"
  | "Invoice"
  | "Journal Entry"
  | "Journal Line"
  | "Document"
  | "Shipment"
  | "Payroll Run"
  | "Counterparty"
  | "Membership"
  | "Earning Code";

/** The category a sync scope belongs to (mirrors `private.integration_scope_category`). */
export const SCOPE_CATEGORY: Readonly<Record<SyncScope, IntegrationCategory>> = {
  "Ledger Export": "Accounting",
  "Payment Sync": "Accounting",
  "Calendar Sync": "Calendar",
  "File Import": "Storage",
  "Notification Delivery": "Communication",
  "Payroll Export": "Payroll",
  "Tracking Refresh": "Shipping",
  "Attendance Import": "Ticketing",
};

export function providerEntry(code: string): ProviderEntry | undefined {
  return PROVIDERS.find((p) => p.code === code);
}

export function isProviderCode(code: string): code is ProviderCode {
  return providerEntry(code) !== undefined;
}

const CLIENT_CREDENTIAL_PROVIDERS: readonly string[] = ["ups", "fedex"] satisfies ProviderCode[];

/**
 * Whether the provider's connection stores a developer app's client ID and secret instead of a token (UPS and
 * FedEx, ADR 0065): the connector mints its access tokens from the pair with the client-credentials grant.
 */
export function usesClientCredentials(code: string): boolean {
  return CLIENT_CREDENTIAL_PROVIDERS.includes(code);
}

/** Scopes a provider can run, by its category. */
export function scopesFor(code: ProviderCode): readonly SyncScope[] {
  const entry = providerEntry(code);
  return SYNC_SCOPES.filter((scope) => SCOPE_CATEGORY[scope] === entry?.category);
}

/** Providers in numeric catalog order, optionally limited to one category. */
export function providersIn(category?: IntegrationCategory): readonly ProviderEntry[] {
  return [...PROVIDERS]
    .filter((p) => category === undefined || p.category === category)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}
