import { expect, test } from "@playwright/test";
import { triage } from "./known";
import { axeProblems, focusProblems, overflowProblems, setTheme, type Theme } from "./checks";

/**
 * Pages anyone may open: the Auth template (sign in, sign up) and public legal documents, which
 * the sitemap marks `auth: public`. No session.
 */
const PAGES = [
  "/auth/sign-in",
  "/auth/sign-up",
  "/legal/accessibility-statement",
  "/legal/privacy-policy",
];

const THEMES: readonly Theme[] = ["dark", "light"];

for (const path of PAGES) {
  test(`public ${path}`, async ({ page }, info) => {
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    const problems: string[] = [];
    for (const theme of THEMES) {
      await setTheme(page, theme);
      problems.push(...(await axeProblems(page)).map((p) => `${theme}: ${p}`));
    }
    if ((page.viewportSize()?.width ?? 1280) < 400)
      problems.push(...(await overflowProblems(page)));
    problems.push(...(await focusProblems(page, { skipLink: false })));
    const result = triage(problems, { route: path, project: info.project.name, role: "anonymous" });
    for (const k of result.known) info.annotations.push({ type: "known", description: k });
    expect(result.open).toEqual([]);
  });
}
