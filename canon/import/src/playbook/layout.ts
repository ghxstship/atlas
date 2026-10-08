/**
 * Destination of every Playbook sheet (Section 2.1). Every sheet lands in
 * exactly one destination; the Cover Page becomes the template's metadata.
 */

export type Destination =
  "canon-mirror" | "standard-library" | "production-template" | "template-metadata";

const MIRROR = [
  "Categories & URID Master",
  "Cost Centers",
  "Counterparty Types",
  "Departments",
  "Disciplines",
  "GL Accounts",
  "Procurement Catalog",
  "Teams",
] as const;

const STANDARD_LIBRARY = [
  "Document & Asset Library",
  "Emergency Codes",
  "Enumerations",
  "Labor Rate Cards",
  "Radio Channels",
  "Roles Library",
  "SOP Library",
  "Vendor Classes",
  "Vendor Entitlements",
  "Verbiage Library",
] as const;

const PRODUCTION_TEMPLATE = [
  "Access Grid",
  "Activity Log",
  "Advance Requests",
  "Asset Assignments",
  "Asset Inventory",
  "Budget Expenses",
  "Change Orders",
  "Credential Issuance",
  "Crew Shifts",
  "Crew Timesheets",
  "Hospitality Fulfillment",
  "Incident CAD Log",
  "Inspection Compliance",
  "Locations",
  "Marshalling Yard Log",
  "Personnel Roster",
  "PO Line Items",
  "Production Schedule",
  "Production Tasks",
  "Projects",
  "Purchase Orders",
  "Run of Show",
  "Shipping Manifest",
  "Staffing Requisition",
  "Universal Posting Line",
  "Vendor Directory",
  "Work Orders",
] as const;

export const COVER_SHEET = "Cover Page";

export const DESTINATIONS: ReadonlyMap<string, Destination> = new Map<string, Destination>([
  [COVER_SHEET, "template-metadata"],
  ...MIRROR.map((s) => [s, "canon-mirror"] as const),
  ...STANDARD_LIBRARY.map((s) => [s, "standard-library"] as const),
  ...PRODUCTION_TEMPLATE.map((s) => [s, "production-template"] as const),
]);

export function destinationOf(sheet: string): Destination {
  const d = DESTINATIONS.get(sheet);
  if (!d) throw new Error(`Playbook sheet "${sheet}" has no destination in Section 2.1`);
  return d;
}

/** The Cover Page is a layout without a header row; every other sheet has its header on row 1. */
export function headerRowOf(sheet: string): number | null {
  return sheet === COVER_SHEET ? null : 1;
}

/** Stable snake_case key for SQL object names: "Categories & URID Master" is categories_urid_master. */
export function sheetKey(sheet: string): string {
  return sheet
    .toLowerCase()
    .replace(/&/g, " ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Every workbook sheet must have a destination and every destination must name a sheet. */
export function checkSheetCoverage(sheetNames: readonly string[]): string[] {
  const problems: string[] = [];
  const names = new Set(sheetNames);
  for (const name of sheetNames) {
    if (!DESTINATIONS.has(name)) problems.push(`Sheet "${name}" is not assigned a destination`);
  }
  for (const name of DESTINATIONS.keys()) {
    if (!names.has(name)) problems.push(`Destination sheet "${name}" is missing from the workbook`);
  }
  return problems;
}
