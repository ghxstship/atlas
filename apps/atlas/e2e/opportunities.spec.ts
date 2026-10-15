import { expect, test, type Page } from "@playwright/test";
import { expectAccessible } from "./support";

/**
 * RRR-58, org side: the engagement lifecycle in the Atlas Opportunities module from requisition to re-engagement, on
 * the demo tenant seed (supabase/seeds/0010 and 0228). Each page is checked with axe in both themes. The demo
 * Producer (Manager) drives the journeys; the demo crew person is the engaged party.
 */

const ORG = "demo-productions";
const NOT_FOUND_TITLE = "Page not found";
const DEMO_PASSWORD = `xos-demo-${"2026"}`;

async function signInAsProducer(page: Page, email = "producer@example.com") {
  await page.goto(`/auth/sign-in?next=${encodeURIComponent(`/${ORG}/home`)}`);
  await page.locator("#signin-email").fill(email);
  await page.locator("#signin-password").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await page.waitForURL(`**/${ORG}/home`);
}

/** axe in dark (the default) and light (Section 18, gate 8: both themes). */
async function expectAccessibleInBothThemes(page: Page) {
  await expectAccessible(page);
  await page.context().addCookies([{ name: "xos-theme", value: "light", url: page.url() }]);
  await page.reload();
  await expectAccessible(page);
  await page.context().addCookies([{ name: "xos-theme", value: "dark", url: page.url() }]);
  await page.reload();
}

test.describe("Opportunities, org side", () => {
  test.beforeEach(async ({ page }) => {
    await signInAsProducer(page);
  });

  test("requisition to published posting, with the refusal for a posting without a requisition", async ({
    page,
  }) => {
    await page.goto(`/${ORG}/opportunities/requisitions`);
    await expect(page.getByRole("heading", { level: 1, name: "Requisitions" })).toBeVisible();
    await expectAccessibleInBothThemes(page);
    await page.getByRole("link", { name: "Post opportunity" }).first().click();
    await expect(page.getByText("New posting", { exact: true }).first()).toBeVisible();
    const title = `Festival Riggers ${Date.now().toString(36).toUpperCase()}`;
    await page.getByLabel("Title", { exact: true }).fill(title);
    await page.getByLabel("Rate type").selectOption("Day");
    await page.getByLabel("Lowest pay").fill("900.00");
    await page.getByLabel("Highest pay").fill("950.00");
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Draft saved" })).toBeVisible();

    await page.goto(`/${ORG}/opportunities/postings?view=table`);
    await expectAccessibleInBothThemes(page);
    await page.getByRole("link", { name: title }).click();
    await page.waitForURL(/postings\?.*id=/);
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expectAccessibleInBothThemes(page);
    await page.getByLabel("Position", { exact: true }).fill("Rigger 3");
    await page.getByRole("button", { name: "Add position" }).click();
    await expect(page.getByText("Rigger 3", { exact: true })).toBeVisible();

    const moveTo = page.getByRole("form", { name: "Move to" });
    await moveTo.getByLabel("Next state").selectOption("Pending Approval");
    await moveTo.getByLabel("Reason").fill("Ready for approval.");
    await moveTo.getByRole("button", { name: "Move" }).click();
    await expect(page.getByText("Pending Approval").first()).toBeVisible();
    await moveTo.getByLabel("Next state").selectOption("Published");
    await moveTo.getByLabel("Reason").fill("Approved within the requisition.");
    await moveTo.getByRole("button", { name: "Move" }).click();
    await expect(page.getByText("Published").first()).toBeVisible();

    // A Crew posting without a requisition is refused at publishing, with copy that names the fix.
    await page.goto(`/${ORG}/opportunities/postings?create=1`);
    const loose = `Loose Crew Call ${Date.now().toString(36).toUpperCase()}`;
    await page.getByLabel("Title", { exact: true }).fill(loose);
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Draft saved" })).toBeVisible();
    await page.goto(`/${ORG}/opportunities/postings`);
    await page.getByRole("link", { name: loose }).click();
    await page.waitForURL(/postings\?.*id=/);
    const looseMove = page.getByRole("form", { name: "Move to" });
    await looseMove.getByLabel("Next state").selectOption("Pending Approval");
    await looseMove.getByLabel("Reason").fill("Ready.");
    await looseMove.getByRole("button", { name: "Move" }).click();
    await expect(page.getByText("Pending Approval").first()).toBeVisible();
    await looseMove.getByLabel("Next state").selectOption("Published");
    await looseMove.getByLabel("Reason").fill("Publish.");
    await looseMove.getByRole("button", { name: "Move" }).click();
    await expect(page.getByText("publish only from an Approved requisition")).toBeVisible();
    await expectAccessible(page);
  });

  test("pipeline to engagement, onboarding verification, activation and a signing link", async ({
    page,
  }) => {
    await page.goto(`/${ORG}/opportunities/pipeline`);
    await expect(page.getByRole("heading", { level: 1, name: "Pipeline" })).toBeVisible();
    await expectAccessibleInBothThemes(page);
    await page
      .getByRole("link", { name: /Demo Crew Member/ })
      .first()
      .click();
    await expect(page.getByRole("heading", { level: 1, name: "Demo Crew Member" })).toBeVisible();
    await expect(page.getByText("Accepted").first()).toBeVisible();
    await expectAccessibleInBothThemes(page);
    await page.getByRole("link", { name: "Open the engagement" }).click();
    await page.waitForURL(/\/opportunities\/engagements\?id=/);

    await expect(page.getByRole("heading", { level: 1, name: "Demo Crew Member" })).toBeVisible();
    await expectAccessibleInBothThemes(page);
    // Active is refused while the blocking Certificate of Insurance has not passed.
    const moveTo = page.getByRole("form", { name: "Move to" });
    await moveTo.getByLabel("Next state").selectOption("Active");
    await moveTo.getByLabel("Reason").fill("Ready to work.");
    await moveTo.getByRole("button", { name: "Move" }).click();
    await expect(page.getByText("Every blocking onboarding item must pass")).toBeVisible();
    // The Producer verifies the item; the engaged party never verifies their own.
    await page.getByRole("button", { name: "Record verification" }).first().click();
    await expect(page.getByText("Passes", { exact: true }).first()).toBeVisible();
    await moveTo.getByLabel("Next state").selectOption("Active");
    await moveTo.getByLabel("Reason").fill("Onboarding complete.");
    await moveTo.getByRole("button", { name: "Move" }).click();
    await expect(page.getByText("Active").first()).toBeVisible();
    // A signing link for the Sent agreement, shown once.
    await page.getByLabel("Recipient email").fill("crew@example.com");
    await page.getByRole("button", { name: "Issue signing link" }).click();
    await expect(page.getByText(/^\/sign\/xdoc_/)).toBeVisible();
    await expect(page.getByText(/Access code: \d{6}/)).toBeVisible();
    await expectAccessible(page);
  });

  test("onboarding, pools, ratings, marketplace settings and the project Engagements tab", async ({
    page,
  }) => {
    await page.goto(`/${ORG}/opportunities/onboarding`);
    await expect(page.getByRole("heading", { level: 1, name: "Onboarding" })).toBeVisible();
    await expectAccessibleInBothThemes(page);

    await page.goto(`/${ORG}/opportunities/pools`);
    await expect(page.getByRole("heading", { level: 1, name: "Pools" })).toBeVisible();
    await expectAccessibleInBothThemes(page);
    await page.getByRole("link", { name: "Trusted Riggers" }).click();
    await expect(page.getByText("Pools are internal.")).toBeVisible();
    await expect(page.getByText("Demo Crew Member")).toBeVisible();
    await expectAccessibleInBothThemes(page);

    await page.goto(`/${ORG}/opportunities/ratings`);
    await expect(page.getByRole("heading", { level: 1, name: "Ratings" })).toBeVisible();
    await expectAccessibleInBothThemes(page);

    await page.goto(`/${ORG}/opportunities/marketplace-settings`);
    await expect(
      page.getByRole("heading", { level: 1, name: "Marketplace settings" }),
    ).toBeVisible();
    await expect(page.getByText("No placement can be bought.")).toBeVisible();
    await expectAccessibleInBothThemes(page);

    await page.goto(`/${ORG}/opportunities/engagements?view=board`);
    await expect(page.getByRole("heading", { level: 1, name: "Engagements" })).toBeVisible();
    await expectAccessibleInBothThemes(page);
  });

  test("the project Engagements tab lists the project's engagements for a project overseer", async ({
    page,
  }) => {
    await page.context().clearCookies();
    await signInAsProducer(page, "owner@example.com");
    await page.goto(`/${ORG}/p/NWS/engagements`);
    await expect(page.getByRole("heading", { level: 1, name: "Engagements" })).toBeVisible();
    await expect(page.getByRole("cell", { name: /Demo Crew Member/ })).toBeVisible();
    await expectAccessibleInBothThemes(page);
  });

  test("a hidden posting shows the not-found page, never a forbidden one", async ({ page }) => {
    // The region streams behind its loading skeleton, so the status is already sent; the not-found page renders.
    await page.goto(`/${ORG}/opportunities/postings?id=0192f1e2-7c3a-7b4d-9e8f-000000000999`);
    await expect(page.getByText(NOT_FOUND_TITLE)).toBeVisible();
    await expectAccessible(page);
  });
});
