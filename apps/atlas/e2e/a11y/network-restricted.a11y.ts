import { expect, test } from "@playwright/test";
import {
  axeProblems,
  cognitiveLoadProblems,
  focusProblems,
  overflowProblems,
  setTheme,
  type Theme,
} from "./checks";
import { triage } from "./known";
import { activeRoles, DEMO_ORG, storageStatePath } from "./roles";

/**
 * The page the proxy sends a member to when an org's IP allow-list refuses their network (A52,
 * migration 1201). It sits outside the sitemap, so the sweep does not reach it. The Owner sees the
 * emergency access form (migration 1203); every other role sees only the explanation.
 */
const THEMES: readonly Theme[] = ["dark", "light"];
const PATH = `/auth/network-restricted?org=${DEMO_ORG}`;

for (const { role } of activeRoles().filter((r) => r.role === "owner" || r.role === "field")) {
  test.describe(`${role}`, () => {
    test.use({ storageState: storageStatePath(role) });
    test(`network-restricted ${PATH}`, async ({ page }, info) => {
      const response = await page.goto(PATH);
      expect(response?.status()).toBe(200);
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
      if (role === "owner") {
        await expect(page.getByRole("form", { name: "Emergency access" })).toBeVisible();
      } else {
        await expect(page.getByRole("form", { name: "Emergency access" })).toHaveCount(0);
      }
      const problems: string[] = [];
      for (const theme of THEMES) {
        await setTheme(page, theme);
        problems.push(...(await axeProblems(page)).map((p) => `${theme}: ${p}`));
      }
      if ((page.viewportSize()?.width ?? 1280) < 400) {
        problems.push(...(await overflowProblems(page)));
      }
      problems.push(...(await cognitiveLoadProblems(page)));
      problems.push(...(await focusProblems(page, { skipLink: false })));
      const result = triage(problems, {
        route: "/auth/network-restricted",
        project: info.project.name,
        role,
      });
      expect(result.open).toEqual([]);
    });
  });
}
