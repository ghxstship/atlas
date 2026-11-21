import { expect as baseExpect, test, type Page } from "./engine-test";
import { expectAccessible, PASSWORD, testEmail, uniqueId } from "./support";

/**
 * Issue 115 (docs/sign-up-links.md): a buyer who chose a plan on the marketing site arrives at
 * /auth/sign-up?plan=<code>. The plan rides in `next` through sign-up and the organization step, and the new Owner
 * lands on Billing and Plan with that plan named and its card marked. Nothing is charged and the org starts its
 * 14-day Pro trial as every new org does. A value that is not a self-serve plan signs up exactly as before.
 */

const expect = baseExpect.configure({ timeout: 30_000 });

async function signUpWith(page: Page, query: string, id: string) {
  await page.goto(`/auth/sign-up${query}`);
  await page.getByLabel(/^Full name$/).fill("Pia Plan");
  await page.locator("#signup-email").fill(testEmail("plan", id));
  await page.locator("#signup-password").fill(PASSWORD);
  await page.locator("#signup-age").check();
}

async function fillOrganization(page: Page, name: string, slug: string) {
  await page.getByLabel("Organization name").fill(name);
  await page.getByLabel("Web address").fill(slug);
  await page
    .getByLabel("Country where your organization is established", { exact: true })
    .selectOption("US");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create organization" }).click();
}

test("a plan named at sign-up is marked on Billing and Plan for the new Owner", async ({
  page,
}) => {
  const id = uniqueId();
  const slug = `plan-${id}`;
  await signUpWith(page, "?plan=core", id);
  await expect(page.getByTestId("plan-intent")).toContainText("You selected the Core plan.");
  await expectAccessible(page);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL("**/auth/organization?plan=core");
  await expect(page.getByTestId("plan-intent")).toContainText("You selected the Core plan.");
  await fillOrganization(page, `Plan Co ${id}`, slug);
  await page.waitForURL(`**/${slug}/settings/billing-and-plan?plan=core*`);
  await expect(page.getByText("You arrived with the Core plan selected.")).toBeVisible();
  await expect(page.getByTestId("plan-intent-mark")).toHaveCount(1);
  await expect(page.locator("#plan-core").getByTestId("plan-intent-mark")).toBeVisible();
  // The trial is the one every new org starts, and nothing was reviewed or bought.
  await expect(page.locator("#plan-pro")).toContainText("Your trial plan");
  await expect(page.getByTestId("renewal-statement")).toHaveCount(0);
  await expectAccessible(page);
});

test("a value that is not a self-serve plan signs up as before", async ({ page }) => {
  const id = uniqueId();
  const slug = `noplan-${id}`;
  await signUpWith(page, "?plan=enterprise", id);
  await expect(page.getByTestId("plan-intent")).toHaveCount(0);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL("**/auth/organization");
  await fillOrganization(page, `No Plan Co ${id}`, slug);
  await page.waitForURL(`**/${slug}/home`);
});
