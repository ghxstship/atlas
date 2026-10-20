import { expect, test, type Page, type TestInfo } from "@playwright/test";
import {
  axeProblems,
  cognitiveLoadProblems,
  iconControlProblems,
  overflowProblems,
  setTheme,
  type Theme,
} from "./checks";
import { triage } from "./known";
import { PEOPLE, storageStatePath } from "./roles";

/**
 * The Gateway help panel (Section 11.16) checked like a page: an open dialog is its own screen for
 * gate 27, so the panel's home, an article and Contact Support each get axe in both themes, the icon
 * control check, the cognitive load check and, on a phone, the overflow check.
 */
const THEMES: readonly Theme[] = ["dark", "light"];

async function checkPanel(page: Page, info: TestInfo, view: string, who: string): Promise<void> {
  await expect(page.getByRole("dialog", { name: "Help" })).toBeVisible();
  const problems: string[] = [];
  for (const theme of THEMES) {
    await setTheme(page, theme);
    problems.push(...(await axeProblems(page)).map((p) => `${theme}: ${p}`));
  }
  if ((page.viewportSize()?.width ?? 1280) < 400) problems.push(...(await overflowProblems(page)));
  problems.push(...(await iconControlProblems(page)));
  problems.push(...(await cognitiveLoadProblems(page)));
  const result = triage(problems, { route: `help ${view}`, project: info.project.name, role: who });
  for (const k of result.known) info.annotations.push({ type: "known", description: k });
  expect(result.open).toEqual([]);
}

for (const person of PEOPLE) {
  test.describe(person.person, () => {
    test.use({ storageState: storageStatePath(person.person) });

    test(`help panel on the engagement overview`, async ({ page }, info) => {
      await page.goto(`/work/engagements/${person.engagementKey}/overview`);
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
      await page.getByRole("heading", { level: 1 }).first().click();
      await page.keyboard.press("?");
      const help = page.getByRole("dialog", { name: "Help" });
      await checkPanel(page, info, "home", person.person);

      await help
        .getByRole("region", { name: "For this page" })
        .getByRole("button", { name: /^An engagement/ })
        .click();
      await expect(help.getByRole("heading", { name: "An engagement" })).toBeVisible();
      await expect(help.getByText(/Four stages/)).toBeVisible();
      await checkPanel(page, info, "article", person.person);

      await help.getByRole("button", { name: "Back to help" }).click();
      await help.getByRole("button", { name: "Contact support", exact: true }).click();
      await expect(help.getByRole("button", { name: "Send request" })).toBeVisible();
      await help.getByRole("checkbox", { name: "Attach diagnostics" }).check();
      await checkPanel(page, info, "contact", person.person);
    });
  });
}
