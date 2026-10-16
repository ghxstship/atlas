import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { toDisplayKey } from "@xos/data/gateway-keys";
import { fillRoute, flattenRoutes, isNodeVisible } from "@xos/ia";
import { sitemap } from "../../ia/sitemap.generated";
import { issueAdvanceLink, issueSigningLink } from "../fixtures";
import {
  axeProblems,
  focusProblems,
  iconControlProblems,
  overflowProblems,
  setTheme,
  type Theme,
} from "./checks";
import { triage } from "./known";
import { PEOPLE, storageStatePath } from "./roles";

/**
 * Every Gateway sitemap route each external person may open (standing and engagement role type,
 * Section 4.5.8), the public profile pages, and both token flows, checked like the Atlas sweep.
 */
const THEMES: readonly Theme[] = ["dark", "light"];

const SHARED_PARAMS: Readonly<Record<string, string>> = {
  handle: "demo-crew",
  companyHandle: "demo-productions",
};

/**
 * Rows each person can see in the seed: the published opportunity is invited to the crew member and
 * the seeded thread sits on the crew engagement. The vendor has neither, so its opportunity detail
 * and thread routes are left to the manual audit.
 */
const PERSON_PARAMS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  crew: {
    opportunityKey: toDisplayKey("opportunity", "01920000-0000-7000-8000-000000228101"),
    threadKey: toDisplayKey("thread", "01920000-0000-7000-8000-000000227002"),
  },
  vendor: {},
};

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
  problems.push(...(await focusProblems(page, { skipLink })));
  const result = triage(problems, { route, project: info.project.name, role: who });
  for (const k of result.known) info.annotations.push({ type: "known", description: k });
  expect(result.open).toEqual([]);
}

const sessionRoutes = flattenRoutes(sitemap).filter((r) => r.auth === "session");

for (const person of PEOPLE) {
  test.describe(person.person, () => {
    test.use({ storageState: storageStatePath(person.person) });
    const ctx = {
      role: person.standing,
      roleType: person.roleType,
      conditions: ["desktop" as const],
    };
    const params = {
      ...SHARED_PARAMS,
      ...PERSON_PARAMS[person.person],
      engagementKey: person.engagementKey,
    };
    const visible = sessionRoutes.filter(
      (r) => isNodeVisible(sitemap, r.id, ctx) && r.params.every((p) => p in params),
    );
    for (const route of visible) {
      const path = fillRoute(route.route, params);
      test(`${route.id} ${path}`, async ({ page }, info) => {
        const response = await page.goto(path);
        expect(response?.status(), `${path} answered ${response?.status()}`).toBe(200);
        await checkPage(page, info, route.id, person.person);
      });
    }
  });
}

test.describe("anonymous", () => {
  for (const path of ["/auth/sign-in", "/auth/sign-up", "/u/demo-crew", "/c/demo-productions"]) {
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
