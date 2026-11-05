import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { issueAdvanceLink, issueSigningLink } from "../fixtures";
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
import { PEOPLE, storageStatePath } from "./roles";
import { PUBLIC_PAGES, sweepRoutesFor } from "./routes";

/**
 * Every Gateway sitemap route each external person may open (Section 4.5.8), the public profile
 * pages, and both token flows (routes.ts), checked like the Atlas sweep.
 */
const THEMES: readonly Theme[] = ["dark", "light"];

async function checkPage(
  page: Page,
  info: TestInfo,
  route: string,
  who: string,
  skipLink = true,
): Promise<void> {
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
  const problems: string[] = [];
  for (const theme of THEMES) {
    await setTheme(page, theme);
    problems.push(...(await axeProblems(page)).map((p) => `${theme}: ${p}`));
  }
  if ((page.viewportSize()?.width ?? 1280) < 400) problems.push(...(await overflowProblems(page)));
  problems.push(...(await iconControlProblems(page)));
  problems.push(...(await cognitiveLoadProblems(page)));
  problems.push(...(await focusProblems(page, { skipLink })));
  const result = triage(problems, { route, project: info.project.name, role: who });
  for (const k of result.known) info.annotations.push({ type: "known", description: k });
  expect(result.open).toEqual([]);
}

for (const person of PEOPLE) {
  test.describe(person.person, () => {
    test.use({ storageState: storageStatePath(person.person) });
    for (const route of sweepRoutesFor(person)) {
      test(`${route.id} ${route.path}`, async ({ page }, info) => {
        const response = await page.goto(route.path);
        expect(response?.status(), `${route.path} answered ${response?.status()}`).toBe(200);
        await checkPage(page, info, route.id, person.person);
      });
    }
  });
}

test.describe("anonymous", () => {
  for (const path of PUBLIC_PAGES) {
    test(`public ${path}`, async ({ page }, info) => {
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      await checkPage(page, info, path, "anonymous", false);
    });
  }

  test("token /sign/{token}", async ({ page }, info) => {
    const link = await issueSigningLink();
    await page.goto(`/sign/${link.token}`);
    await checkPage(page, info, "agreement-signing", "token", false);
  });

  test("token /advance/{token}", async ({ page }, info) => {
    const link = await issueAdvanceLink();
    await page.goto(`/advance/${link.token}`);
    await checkPage(page, info, "advance-form", "token", false);
  });
});
