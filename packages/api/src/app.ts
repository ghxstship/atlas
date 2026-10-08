/**
 * The v1 Hono app factory. Route definitions are registered for the OpenAPI document only;
 * operation handlers mount module by module as each module is implemented, so no
 * unimplemented operation answers with a stub.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { atlasResources } from "./catalog/atlas.ts";
import { canonResources } from "./catalog/canon.ts";
import { marketplaceResources } from "./catalog/marketplace.ts";
import { platformResources } from "./catalog/platform.ts";
import type { Module, ResourceSpec } from "./catalog/types.ts";
import { MODULES } from "./catalog/types.ts";
import { buildRoutes } from "./build/routes.ts";
import {
  SECURITY_REQUIREMENT,
  registerHeaders,
  registerParameters,
  registerProblemResponses,
  registerSecuritySchemes,
} from "./conventions/components.ts";
import { validationHook } from "./problem.ts";

export const API_VERSION = "1.0.0-draft.1";

/** Every resource in the contract, in module order. */
export const catalog: readonly ResourceSpec[] = [
  ...atlasResources,
  ...marketplaceResources,
  ...canonResources,
  ...platformResources,
];

const TAG_DESCRIPTIONS: Record<Module, string> = {
  Home: "Org dashboard, my work, gate readiness and alerts (Section 4.2).",
  Projects: "Projects, scope tree, jurisdiction and gate evidence (Section 4.2).",
  Activity: "The user-facing activity feed, separate from the audit ledger (Section 4.2).",
  Schedule: "Timeline records, baselines, dependencies, calendars and actuals (Section 4.2).",
  Work: "The record spine for all 26 kinds, and work orders with bids (Sections 3.10 and 4.2).",
  Show: "Run of show, cues, day sheets and call sheets (Section 4.2).",
  Knowledge:
    "SOPs with acknowledgment, documents with versions and controlled vocabulary (Section 4.2).",
  Places:
    "Venues, spaces, zones, capability documents, site plans and reconciliation (Section 4.2).",
  Logistics: "Shipments, dock slots, gate queue, staging and release (Section 4.2).",
  Advancing: "Advance packets, sections, recipients, submissions and riders (Section 4.2).",
  Hospitality: "Lodging, catering, travel and amenity fulfillment and BEOs (Section 4.2).",
  Assets: "Assets at class, unit and lot grain, custody, maintenance and damage (Section 4.2).",
  Opportunities:
    "Opportunities, applications, selection, offers, onboarding, engagements, ratings and pools (Sections 4.2 and 4.4).",
  People: "Role assignments, requisitions, offers and agreements (Section 4.2).",
  Crew: "Shifts, swaps, time, timesheets, rate cards, pay rates and payroll export (Section 4.2).",
  Credentials: "Credential categories, issuance, the Access Grid and scans (Section 4.2).",
  Finance:
    "Budgets, expenses, change orders, ledger, periods and the Universal Posting Line (Sections 3.11 and 4.2).",
  Procurement:
    "RFQs, purchase orders, receipts, three-way match and catalog bindings (Section 4.2).",
  Vendors:
    "Vendors, classes, prequalification, insurance, scorecards and sponsor entitlements (Section 4.2).",
  Safety:
    "Inspections, the permit engine, incidents with dispatch, emergency codes and radio (Section 4.2).",
  Canon:
    "Read-only canon from `xpms`, cached by canon generation, and tenant extension proposals (Sections 4.2 and 7.2).",
  Reports:
    "Report builder, dashboards, scheduled delivery and the built-in analytics reports (Sections 4.2 and 4.6.4).",
  Settings:
    "Organization, access, security, white label, integrations, billing, data and privacy (Sections 4.2 and 8).",
  Gateway:
    "External-party resources: marketplace, saved searches, profile shares, availability, messages, tax and payout details (Section 4.4).",
  Identity:
    "People, organizations, memberships, assignments, representation and profiles (Section 4.8).",
  Platform:
    "Custom objects, imports and exports, approvals, comments, notifications, saved views, trash and templates (Sections 4.6 and 4.10).",
};

export const DOCUMENT_INFO = {
  openapi: "3.1.0",
  info: {
    title: "XOS Public API",
    version: API_VERSION,
    summary: "One API for Atlas, Gateway, Compass, SDKs and third parties.",
    description:
      'Versioned REST API for XOS 4.0 (Section 10.1, ADR 0003). Cursor pagination with `limit` and `cursor`; sparse fieldsets with `fields`; filters with `filter[field][op]=value`; `Idempotency-Key` on every POST; `ETag` and `If-Match` on updates; RFC 9457 problem details; refusals as 422 with `refusal` set to NO_ANSWER, UNRATIFIED or REFUSE. Money is integer minor units with a currency; null is unpriced, never zero. Restricted fields the caller may not read stay present as `{ "masked": true, "reason": "..." }`. The active organization is bound to the credential.',
    license: { name: "AGPL-3.0-only", identifier: "AGPL-3.0-only" },
  },
  servers: [{ url: "/api/v1", description: "This deployment." }],
  security: SECURITY_REQUIREMENT,
  tags: MODULES.map((name) => ({ name, description: TAG_DESCRIPTIONS[name] })),
} as const;

export function createApiApp(): OpenAPIHono {
  const app = new OpenAPIHono({ defaultHook: validationHook });
  const registry = app.openAPIRegistry;
  registerSecuritySchemes(registry);
  registerHeaders(registry);
  registerProblemResponses(registry);
  const params = registerParameters(registry);
  for (const route of buildRoutes(catalog, params)) registry.registerPath(route);
  return app;
}

export function buildOpenApiDocument(): Record<string, unknown> {
  const doc = createApiApp().getOpenAPI31Document(DOCUMENT_INFO as never) as unknown as Record<
    string,
    unknown
  >;
  return doc;
}
