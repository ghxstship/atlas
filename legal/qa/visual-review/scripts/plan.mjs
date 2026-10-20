// Who the A59 review signs in as, and which sitemap routes each one visits. Mirrors the a11y sweeps
// (apps/{atlas,gateway}/e2e/a11y): flattenRoutes, then isNodeVisible for the person's role.

/** Atlas demo people (seeds 0010, 0011, 1060, 1080). `scope` narrows the Finance Lead to her group. */
export const atlasRoles = [
  { role: "owner", email: "owner@example.com", org: "demo-productions" },
  { role: "manager", label: "producer", email: "producer@example.com", org: "demo-productions" },
  {
    role: "manager",
    label: "finance",
    email: "finance@example.com",
    org: "demo-productions",
    scope: ["group.workspace", "group.commercial", "group.account", "group.footer"],
  },
  { role: "field", email: "field@example.com", org: "demo-productions" },
  { role: "viewer", email: "viewer@example.com", org: "demo-productions" },
  {
    role: "owner",
    label: "partner",
    email: "partner@example.com",
    org: "demo-partner",
    conditions: ["partner-org"],
    scope: ["group.workspace", "group.routes", "group.account", "settings.partner"],
  },
];

export const ATLAS_PARAMS = {
  projectKey: "NWS",
  recordKey: "NWS-1",
  viewId: "01920000-0000-7000-8000-000002310003",
  partnerSlug: "demo-partner",
};

/** Gateway external people (seeds 0010 and 1080). Engagements are discovered from /work. */
export const gatewayPeople = [
  { person: "crew", email: "crew@example.com", standing: "individual" },
  { person: "vendor", email: "vendor@example.com", standing: "account-owner" },
  { person: "artist", email: "artist@example.com", standing: "individual" },
  { person: "client", email: "client@example.com", standing: "account-owner" },
  { person: "sponsor", email: "sponsor@example.com", standing: "account-owner" },
  { person: "staff", email: "staff.one@example.com", standing: "account-member" },
];

function underScope(ia, sitemap, id, scope) {
  if (!scope) return true;
  const index = ia.indexSitemap(sitemap);
  const entry = index.byId.get(id);
  if (!entry) return false;
  const chain = [entry.node.id, ...entry.ancestors.map((a) => a.node.id)];
  return chain.some((c) => scope.includes(c));
}

export function atlasRoutes(ia, sitemap, who) {
  const params = { ...ATLAS_PARAMS, org: who.org };
  const ctx = { role: who.role, conditions: ["desktop", ...(who.conditions ?? [])] };
  return ia
    .flattenRoutes(sitemap)
    .filter(
      (r) =>
        r.auth === "session" &&
        r.servedBy === undefined &&
        r.params.every((p) => p in params) &&
        r.id !== "calendar-feed" &&
        ia.isNodeVisible(sitemap, r.id, ctx) &&
        underScope(ia, sitemap, r.id, who.scope),
    )
    .map((r) => ({ id: r.id, path: ia.fillRoute(r.route, params) }));
}

/** Top-level Gateway routes for the person's standing; engagement tabs come from the page itself. */
export function gatewayRoutes(ia, sitemap, who) {
  const params = { handle: "demo-crew", companyHandle: "demo-productions" };
  const ctx = { role: who.standing, conditions: ["desktop"] };
  return ia
    .flattenRoutes(sitemap)
    .filter(
      (r) =>
        r.auth === "session" &&
        r.params.every((p) => p in params) &&
        ia.isNodeVisible(sitemap, r.id, ctx),
    )
    .map((r) => ({ id: r.id, path: ia.fillRoute(r.route, params) }));
}
