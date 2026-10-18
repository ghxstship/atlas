import { expect, test } from "@playwright/test";
import { fillRoute, flattenRoutes, isNodeVisible } from "@xos/ia";
import { DELEGATED } from "../../ia/routes.config";
import { sitemap } from "../../ia/sitemap.generated";
import {
  axeProblems,
  cognitiveLoadProblems,
  focusProblems,
  iconControlProblems,
  overflowProblems,
  setTheme,
  type Theme,
} from "./checks";
import { triage } from "./known";
import { activeRoles, DEMO_ORG, storageStatePath } from "./roles";

/**
 * Every Atlas sitemap route each demo role may open (Section 4.5.9 visibility), checked with axe in
 * both themes, focus indicators, icon-only control names and tooltips, and at 375 px horizontal
 * overflow. Seeded rows fill the data params: project NWS and its record NWS-1, and the Manager's
 * saved view. Custom objects have no seeded type, so `/{org}/objects/{objectKey}` is left to the
 * manual audit.
 */
const PARAMS: Readonly<Record<string, string>> = {
  org: DEMO_ORG,
  projectKey: "NWS",
  recordKey: "NWS-1",
  viewId: "01920000-0000-7000-8000-000002310003",
};

const THEMES: readonly Theme[] = ["dark", "light"];

const routes = flattenRoutes(sitemap).filter(
  (r) =>
    r.auth === "session" &&
    r.servedBy === undefined &&
    !(r.id in DELEGATED) &&
    r.params.every((p) => p in PARAMS),
);

for (const { role } of activeRoles()) {
  test.describe(`${role}`, () => {
    test.use({ storageState: storageStatePath(role) });
    const ctx = { role, conditions: ["desktop" as const] };
    const visible = routes.filter((r) => isNodeVisible(sitemap, r.id, ctx));
    for (const route of visible) {
      const path = fillRoute(route.route, PARAMS);
      test(`${route.id} ${path}`, async ({ page }, info) => {
        const phone = info.project.name === "phone-375";
        // Desktop-only nodes (conditions: [desktop]) answer 404 on a phone by design.
        if (phone && !isNodeVisible(sitemap, route.id, { role })) test.skip();
        const problems: string[] = [];
        const response = await page.goto(path);
        const status = response?.status() ?? 0;
        if (status === 404 && route.params.some((p) => p !== "org")) {
          // The role cannot see the seeded row (the Manager's private view, projects outside a
          // Viewer's reach): data access, not page access, so the route has nothing to audit here.
          info.annotations.push({ type: "no-access", description: `${path} answered 404` });
          test.skip();
        }
        // Any other status is a problem, but the page it rendered is still audited.
        if (status !== 200) problems.push(`status: ${path} answered ${status}`);
        const h1 = page.getByRole("heading", { level: 1 }).first();
        await h1.waitFor({ state: "visible", timeout: 10_000 }).catch(() => undefined);
        if (!(await h1.isVisible())) problems.push("structure: the page has no visible h1");
        for (const theme of THEMES) {
          await setTheme(page, theme);
          problems.push(...(await axeProblems(page)).map((p) => `${theme}: ${p}`));
        }
        if ((page.viewportSize()?.width ?? 1280) < 400) {
          problems.push(...(await overflowProblems(page)));
        }
        problems.push(...(await iconControlProblems(page)));
        problems.push(...(await cognitiveLoadProblems(page)));
        problems.push(...(await focusProblems(page)));
        const result = triage(problems, { route: route.id, project: info.project.name, role });
        for (const k of result.known) info.annotations.push({ type: "known", description: k });
        expect(result.open).toEqual([]);
      });
    }
  });
}
