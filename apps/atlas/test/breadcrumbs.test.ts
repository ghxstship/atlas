import { fillRoute, flattenRoutes } from "@xos/ia";
import { describe, expect, it } from "vitest";
import { clientSitemap } from "../ia/sitemap.client.generated";
import { sitemap } from "../ia/sitemap.generated";
import { breadcrumbItems } from "../lib/shell/breadcrumbs";

const org = { name: "Demo Productions", slug: "demo-productions" };
const t = (key: string) => `t:${key}`;
const PARAMS: Readonly<Record<string, string>> = {
  org: "demo-productions",
  projectKey: "NWS",
  recordKey: "NWS-1",
  viewId: "01920000-0000-7000-8000-000002310002",
  teamId: "01920000-0000-7000-8000-000000000501",
  workspaceSlug: "miami",
  objectKey: "gear-requests",
  partnerSlug: "demo-partner",
};

describe("breadcrumbItems", () => {
  it("names the org, the pages above and the project of a page", () => {
    expect(breadcrumbItems(sitemap, "/demo-productions/p/NWS/overview", { org }, t)).toEqual([
      { label: "Demo Productions", href: "/demo-productions/home" },
      expect.objectContaining({ label: "NWS", href: "/demo-productions/p/NWS" }),
      { label: "t:nav.atlas.projectTabs.overview", href: "/demo-productions/p/NWS/overview" },
    ]);
  });

  it("adds the workspace in view after the org", () => {
    const [, workspace] = breadcrumbItems(
      sitemap,
      "/demo-productions/projects",
      { org, workspace: "Miami" },
      t,
    );
    expect(workspace).toEqual({ label: "Miami" });
  });

  // The server shell builds the first page's trail from the full sitemap and the browser every
  // later one from the client sitemap: both must read the same.
  it("reads every route the same from the full and the client sitemap", () => {
    const routes = flattenRoutes(sitemap).filter((r) => r.params.every((p) => p in PARAMS));
    expect(routes.length).toBeGreaterThan(200);
    for (const route of routes) {
      const path = fillRoute(route.route, PARAMS);
      expect(breadcrumbItems(clientSitemap, path, { org }, t), path).toEqual(
        breadcrumbItems(sitemap, path, { org }, t),
      );
    }
  });
});
