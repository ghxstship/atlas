/**
 * The v1 Hono app factory. Every route definition is registered for the OpenAPI document;
 * operation handlers from `src/handlers/<module>.ts` mount onto their routes when the app is
 * created with dependencies, so no unimplemented operation answers with a stub.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { loadCapabilityRegistry } from "@xos/schemas/capabilities";
import { atlasResources } from "./catalog/atlas.ts";
import { canonResources } from "./catalog/canon.ts";
import { marketplaceResources } from "./catalog/marketplace.ts";
import { platformResources } from "./catalog/platform.ts";
import { applyAdditions } from "./catalog/additions.ts";
import {
  CONTRACT_CORRECTIONS,
  applyCorrections,
  resolveCorrections,
} from "./catalog/corrections.ts";
import type { ResolvedCorrection } from "./catalog/corrections.ts";
import { MODULE_ADDITIONS } from "./catalog/modules/index.generated.ts";
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
import { MODULE_HANDLERS } from "./handlers/index.generated.ts";
import { notFound, problemResponse, validationHook } from "./problem.ts";
import type { AnyModuleHandlers } from "./runtime/handler.ts";
import { mountHandlers } from "./runtime/mount.ts";
import type { MountOptions } from "./runtime/mount.ts";

/** The v1 draft. Each draft that adds contract corrections takes the next number (ADR 0023). */
export const API_VERSION = "1.0.0-draft.2";

/** The v1 catalog exactly as frozen (ADR 0014), in module order. Gate 20 compares it with the freeze. */
export const uncorrectedFrozenCatalog: readonly ResourceSpec[] = [
  ...atlasResources,
  ...marketplaceResources,
  ...canonResources,
  ...platformResources,
];

/**
 * Every correction to the frozen catalog (ADR 0023), resolved and in the order applied: the
 * contract-wide entries, then each module's entries in `MODULES` order.
 */
export const CORRECTIONS: readonly ResolvedCorrection[] = resolveCorrections(
  uncorrectedFrozenCatalog,
  [...CONTRACT_CORRECTIONS, ...MODULE_ADDITIONS.flatMap((m) => m.corrections)],
);

/** The frozen v1 catalog with its corrections applied. */
export const frozenCatalog: readonly ResourceSpec[] = applyCorrections(
  uncorrectedFrozenCatalog,
  CORRECTIONS,
);

/** Every resource in the contract: the frozen catalog plus each module's additive operations. */
export const catalog: readonly ResourceSpec[] = applyAdditions(frozenCatalog, MODULE_ADDITIONS);

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
  Workforce:
    "Groups, chat, the directory, the feed, polls, surveys, recognition, events, forms, training, the handbook, the help desk and site operations (Section 4.9).",
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
  // `servers` is document metadata, outside the frozen operations and components (ADR 0023), so
  // adding a server is not a contract correction. The relative entry stays first: every deployment,
  // self-hosted ones included, serves the API at its own /api/v1.
  servers: [
    { url: "/api/v1", description: "This deployment." },
    { url: "https://api.ghxstship.tech/v1", description: "GHXSTSHIP hosted production." },
  ],
  security: SECURITY_REQUIREMENT,
  tags: MODULES.map((name) => ({ name, description: TAG_DESCRIPTIONS[name] })),
} as const;

/** What the runtime needs to serve requests. Without it the app carries the document only. */
export interface ApiDeps extends MountOptions {
  /** Module handler sets; defaults to every file in `src/handlers`. */
  readonly handlers?: readonly AnyModuleHandlers[];
  /**
   * Mount prefix stripped before routing, such as `/api/v1` in Atlas. A list names every prefix
   * the app is reached under, tried in order: Atlas serves `/api/v1` on its own host and `/v1` on
   * the API host, whose requests keep their original path after the proxy rewrites them.
   */
  readonly basePath?: string | readonly string[];
}

/** The path the routes see: the request path without the first mount prefix it starts with. */
export function stripBasePath(path: string, bases: readonly string[]): string {
  for (const base of bases) {
    if (path === base) return "/";
    if (path.startsWith(`${base}/`)) return path.slice(base.length);
  }
  return path;
}

export function createApiApp(
  deps?: ApiDeps,
  specs: readonly ResourceSpec[] = catalog,
): OpenAPIHono {
  const bases = (typeof deps?.basePath === "string" ? [deps.basePath] : (deps?.basePath ?? []))
    .map((base) => base.replace(/\/$/, ""))
    .filter((base) => base !== "");
  const app = new OpenAPIHono({
    defaultHook: validationHook,
    ...(bases.length === 0
      ? {}
      : { getPath: (request: Request) => stripBasePath(new URL(request.url).pathname, bases) }),
  });
  const registry = app.openAPIRegistry;
  registerSecuritySchemes(registry, loadCapabilityRegistry());
  registerHeaders(registry);
  registerProblemResponses(registry);
  const params = registerParameters(registry);
  const routes = buildRoutes(specs, params);
  for (const route of routes) registry.registerPath(route);
  if (deps !== undefined) {
    mountHandlers(app, routes, deps.handlers ?? MODULE_HANDLERS, deps);
    app.notFound((c) =>
      problemResponse({
        ...notFound("No operation is served at this path.").body,
        instance: new URL(c.req.url).pathname,
      }),
    );
  }
  return app;
}

/** operationIds that have a handler, in document order (Section 18, gate 5 coverage). */
export function handledOperations(
  modules: readonly AnyModuleHandlers[] = MODULE_HANDLERS,
): string[] {
  const handled = new Set(
    modules.flatMap((m) =>
      Object.entries(m.handlers)
        .filter(([, h]) => h !== undefined)
        .map(([id]) => id),
    ),
  );
  return catalogOperationIds().filter((id) => handled.has(id));
}

/** Every operationId in the contract, in document order. */
export function catalogOperationIds(): string[] {
  const params = registerParameters(new OpenAPIHono().openAPIRegistry);
  return buildRoutes(catalog, params).map((r) => (r as { operationId: string }).operationId);
}

/** The OpenAPI document of `specs`; the full catalog unless a test passes another set. */
export function buildOpenApiDocument(
  specs: readonly ResourceSpec[] = catalog,
): Record<string, unknown> {
  const doc = createApiApp(undefined, specs).getOpenAPI31Document(
    DOCUMENT_INFO as never,
  ) as unknown as Record<string, unknown>;
  return doc;
}
