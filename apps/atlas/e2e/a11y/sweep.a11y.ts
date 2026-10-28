import { expect, test } from "@playwright/test";
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
import { activeRoles, storageStatePath } from "./roles";
import { noAccess, sweepRoutesFor, visibleOnPhone } from "./routes";

/**
 * Every Atlas sitemap route each demo role may open (Section 4.5.9 visibility; the list is in
 * routes.ts), checked with axe in both themes, focus indicators, icon-only control names and
 * tooltips, and at 375 px horizontal overflow.
 */
const THEMES: readonly Theme[] = ["dark", "light"];

for (const { role } of activeRoles()) {
  test.describe(`${role}`, () => {
    test.use({ storageState: storageStatePath(role) });
    for (const { route, path } of sweepRoutesFor(role)) {
      test(`${route.id} ${path}`, async ({ page }, info) => {
        const phone = info.project.name === "phone-375";
        // Desktop-only nodes (conditions: [desktop]) answer 404 on a phone by design.
        if (phone && !visibleOnPhone(route, role)) test.skip();
        const problems: string[] = [];
        const response = await page.goto(path);
        const status = response?.status() ?? 0;
        if (noAccess(route, status)) {
          // The role cannot see the seeded row: data access, not page access (routes.ts).
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
