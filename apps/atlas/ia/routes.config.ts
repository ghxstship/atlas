/**
 * How the Atlas route tree is generated from ia/sitemap.yaml (Section 3.15: routes are generated
 * from the sitemap). The generator writes one page file per routed node; this file names the
 * exceptions (hand-written pages are listed in ia/implemented/*.txt and read by ia/implemented.ts), so every route in app/ is accounted for (Section 18, gate 15).
 */

/** Nodes Atlas routes do not serve, with who serves them. */
export const DELEGATED: Readonly<Record<string, string>> = {
  "advance-form": "Served by Gateway (servedBy: gateway, ADR 0006 item 5).",
  "agreement-signing": "Served by Gateway (servedBy: gateway, ADR 0006 item 5).",
};

/**
 * Sitemap nodes Atlas serves with a route handler whose file cannot mirror the route, because a
 * Next segment cannot carry a fixed suffix (ADR 0040 item 1). `/ical/{feedToken}.ics` is served by
 * `app/ical/[feedFile]/route.ts`, which takes the whole file name and answers 404 unless it is
 * `<token>.ics`. Gate 15 checks each file exists and counts it as the node's route file.
 */
export const ROUTE_HANDLER_FILES: Readonly<Record<string, string>> = {
  "calendar-feed": "app/ical/[feedFile]/route.ts",
};

/**
 * Routes outside the sitemap that the shell owns: the entry redirect, the Auth template flows
 * (all under /auth, which private.reserved_org_slugs reserves) and the public API mount. Patterns
 * use the sitemap's `{param}` syntax.
 */
export const SHELL_ROUTES: Readonly<Record<string, string>> = {
  "/": "Entry: sends a signed-in person to their org's Home, everyone else to sign in.",
  "/auth/sign-in": "Auth template: password, magic link and OAuth sign-in.",
  "/auth/sign-up": "Auth template: account creation with legal acceptance.",
  "/auth/check-email": "Auth template: magic link and confirmation sent.",
  "/auth/age": "Auth template: the age question for anyone who has not answered at 18 (ADR 0156).",
  "/auth/age-refused":
    "Auth template: what someone who answered under 18 is told, with no account left (ADR 0156).",
  "/auth/callback": "Route handler: OAuth and PKCE code exchange.",
  "/auth/confirm": "Route handler: email link token verification.",
  "/auth/sign-out": "Route handler: ends the session (POST only).",
  "/auth/session": "Route handler: session expiry for the re-authentication dialog.",
  "/auth/realtime":
    "Route handler: the short-lived access token live updates subscribe with (ADR 0044).",
  "/auth/organization": "Auth template: create an organization.",
  "/auth/network-restricted":
    "Auth template: an org's IP allow-list refused this network; an Owner may take emergency access (A52).",
  "/auth/invite/{token}": "Auth template: preview and accept an invitation.",
  "/auth/act/{token}":
    "Auth template: confirm a one-tap action from a notification email; opening it never acts (A127, ADR 0106).",
  "/auth/mfa":
    "Auth template: the second factor after the first, or setting one up an org requires (A77).",
  "/auth/session-ended":
    "Auth template: an org's session lifetime or idle timeout ended the session; sign in again (A77).",
  "/auth/sso": "Auth template: Enterprise single sign-on by work email domain (A77).",
  "/auth/offline":
    "Auth template: the offline page the service worker shows for a page it has not saved (A96, ADR 0052).",
  "/sw.js": "Route handler: the service worker, served at the origin root (A96, ADR 0052).",
  "/api/product-events":
    "Route handler: consent-gated, first-party product analytics events (A96, Section 11.14).",
  "/support/feedback":
    "Platform staff: the product feedback triage list (A96, Section 11.7); 404 for anyone else.",
  "/oauth/authorize":
    "Route handler: the OAuth 2.1 authorization endpoint the OpenAPI document names; records the capability groups and opens consent (A99, ADR 0055).",
  "/oauth/token":
    "Route handler: the OAuth 2.1 token endpoint (code with PKCE, refresh with rotation), answered by Supabase Auth (A99, ADR 0055).",
  "/oauth/consent":
    "Auth template: an app asks to act for the person in its org; Restricted capability groups need step-up (A99, ADR 0055).",
  "/oauth/integrations/callback":
    "Route handler: Google Drive and OneDrive sign-in returns here; stores the refresh token and connects (B16, ADR 0155 D5).",
  "/oauth/integrations/problem":
    "Auth template: why connecting a storage account did not finish (B16, ADR 0155 D5).",
  "/{org}/export":
    "Route handler: the full org export archive for the Owner (A36, Section 14.7 and 14.8).",
  "/{org}/documents/{kind}/{id}":
    "Route handler: a generated document as tagged PDF/UA (Section 11.9, ADR 0031).",
  "/{org}/documents/badges":
    "Route handler: up to 100 credential badges in one streamed PDF/UA file, on Letter, A4, A6 or CR80 (P5, ADR 0031 amendment).",
  "/{org}/documents/books/{id}":
    "Route handler: a tour or production book, its cover, contents and up to 100 documents, in one streamed PDF/UA file on Letter or A4 (B7, ADR 0146).",
  "/{org}/deletion-certificates/{id}":
    "Route handler: a deletion certificate PDF for the former Owner it was issued to (A79, Section 14.7).",
  "/{org}/forms/{form}/{id}":
    "Route handler: OSHA Forms 300, 300A and 301 and the WH-347 certified payroll as PDF/UA or CSV (Section 14.5, A82).",
  "/share/{token}":
    "Auth template: opens a share link with its access code; no session needed (Section 8.6, A82).",
  "/share/{token}/file":
    "Route handler: opens a share link and sends the file, watermarked when Confidential (Section 8.6).",
  "/share/view/{token}":
    "Public frame: a saved view live link with its access code and device grant; no session needed (P1, ADR 0130).",
  "/share/view/{token}/open":
    "Route handler: opens a saved view live link with its access code and sets the device grant (P1, ADR 0130).",
  "/share/screen/{token}":
    "Display screen: a running order as a room clock, presenter timer or backstage screen; no session needed (P1, ADR 0130).",
  "/share/screen/{token}/open":
    "Route handler: opens a display screen link with its access code and sets the device grant (P1, ADR 0130).",
  "/share/showcaller/{token}":
    "Public frame: a showcaller link's portal for a signed-in person on the project, calling and editing one running order with its access code and device grant; no session needed (B3, ADR 0142).",
  "/share/showcaller/{token}/open":
    "Route handler: opens a showcaller link with its access code and sets the device grant (B3, ADR 0142).",
  "/share/showcaller/{token}/clock":
    "Display screen: a showcaller portal's pop-out room clock and presenter timer, fed by the portal's own read (B3, ADR 0142).",
  "/share/pack/{token}":
    "Public frame: a stakeholder pack with its recipient's access code and device grant; no session needed (B2, ADR 0141).",
  "/share/pack/{token}/open":
    "Route handler: opens a stakeholder pack with the code or a device grant, and sets the grant (B2, ADR 0141).",
  "/share/pack/{token}/items/{itemId}":
    "Public frame: one live item of a stakeholder pack, read as the live link's creator (B2, ADR 0141).",
  "/share/pack/{token}/items/{itemId}/file":
    "Route handler: downloads a stakeholder pack's file item by a single-use ticket (B2, ADR 0141).",
  "/share/pack/{token}/items/{itemId}/sign":
    "Route handler: records a typed-name acknowledgement of a stakeholder pack item (B2, ADR 0141).",
  "/share/pack/unsubscribe/{token}":
    "Public frame: confirm stopping a stakeholder pack's emails; opening never acts (B2, ADR 0141).",
  "/share/pack/unsubscribe/{token}/confirm":
    "Route handler: stops a stakeholder pack's emails on the confirm button's POST (B2, ADR 0141).",
  "/files/{version}":
    "Route handler: a Confidential or Restricted file, logged, held to the export capability and watermarked (Section 8.6).",
  "/files/party/{version}":
    "Route handler: a file a party uploaded to party-uploads (an advance answer's or a supplied sponsor asset's), for a reader app.party_file_object admits, served under the caller's session behind the scan gate (R9).",
  "/api/v1/openapi.json": "Public API: the generated OpenAPI document (A04, ADR 0005 item 3).",
  "/api/v1/{...path}": "Public API: every v1 operation, served by the @xos/api Hono app (A04R).",
  "/api/client-errors": "Route handler: browser error reports, forwarded to Sentry (ADR 0025).",
  "/api/system-banners": "Route handler: the live platform system banners, cached a minute (A90).",
  "/api/mcp":
    "Route handler: the hosted MCP endpoint, stateless Streamable HTTP; writes are proposals (B16, ADR 0155 D1).",
  "/.well-known/apple-app-site-association":
    "Route handler: universal links to Compass for Continue on another device (ADR 0030).",
  "/.well-known/assetlinks.json":
    "Route handler: Android App Links to Compass for Continue on another device (ADR 0030).",
  "/.well-known/security.txt": "The vulnerability disclosure contact (RFC 9116), not a screen",
  "/.well-known/oauth-protected-resource":
    "Route handler: OAuth protected-resource metadata of the hosted MCP endpoint (RFC 9728; B16).",
  "/.well-known/oauth-protected-resource/mcp":
    "Route handler: the same metadata for the API host's /mcp (RFC 9728; B16).",
  "/.well-known/oauth-protected-resource/api/mcp":
    "Route handler: the same metadata for Atlas's /api/mcp (RFC 9728; B16).",
  "/.well-known/oauth-authorization-server":
    "Route handler: OAuth authorization-server metadata of /oauth/authorize and /oauth/token (RFC 8414; B16).",
};

/**
 * Where an empty state's action leads when it names another page ("View invoices"). Pages not
 * listed act on themselves: their action opens the page's create flow (`?create=1`), which the
 * module agent implements with the page.
 */
export const EMPTY_STATE_TARGETS: Readonly<Record<string, string>> = {
  "home.today": "projects.all",
  "home.gate-readiness": "projects.all",
  "home.alerts": "my-work",
  "home.recent": "projects.all",
  inbox: "my-work",
  "my-work": "projects.all",
  "projects.by-phase": "projects.all",
  "projects.portfolio-timeline": "projects.all",
  "advancing.submissions": "advancing.packets",
  "advancing.reconciliation": "advancing.riders",
  "credentials.access-grid": "credentials.categories",
  "credentials.scan-log": "credentials.issued",
  "safety.dispatch-board": "safety.incidents",
  "opportunities.pipeline": "opportunities.postings",
  "opportunities.onboarding": "people.offers",
  "opportunities.ratings": "opportunities.engagements",
  "crew.schedule": "crew.shifts",
  "crew.swaps": "crew.shifts",
  "crew.time-entries": "crew.shifts",
  "crew.timesheets": "crew.time-entries",
  "finance.payments": "finance.invoices",
  "finance.chart-of-accounts": "canon",
  "procurement.receipts": "procurement.purchase-orders",
  "procurement.invoice-matching": "finance.invoices",
  "reports.gate-readiness": "projects.all",
  "reports.coordinate-matrix": "projects.all",
  "reports.budget-versus-actual": "finance.budgets",
  "reports.labor": "crew.timesheets",
  "reports.purchase-order-exposure": "procurement.purchase-orders",
  "reports.incidents": "safety.incidents",
  "reports.final-cost-report": "projects.all",
  "reports.saved-reports": "reports.builder",
  "canon.departments": "canon.disciplines",
  "canon.disciplines": "canon.departments",
  "canon.categories": "canon.disciplines",
  "canon.elements": "canon.categories",
  "canon.phases-and-gates": "canon.record-kinds",
  "canon.record-kinds": "canon.phases-and-gates",
  "canon.roles": "canon.departments",
  "canon.jurisdictions-and-permit-rules": "safety.permits",
  "canon.metrics": "canon.departments",
  "activity.feed": "my-work",
  "activity.audit-log": "settings.members",
  "settings.usage": "settings.members",
  "settings.audit-log": "settings.members",
  "settings.legal": "settings.members",
  "me.connected-apps": "settings.integrations",
  "partner-console.usage": "partner-console.client-orgs",
  "partner-console.wholesale-billing": "partner-console.client-orgs",
};

/** Route parameters that name data rows; a page whose row does not resolve answers 404. */
export const DATA_PARAMS = [
  "projectKey",
  "recordKey",
  "viewId",
  "objectKey",
  "workspaceSlug",
  "teamId",
] as const;

/**
 * Data parameters whose page looks its row up itself and answers 404 when it does not resolve: the workspace
 * and team settings pages (A86, ADR 0006 amendment of 2026-10-21). Project keys resolve in the route guard.
 */
export const PAGE_RESOLVED_PARAMS = ["workspaceSlug", "teamId"] as const;
