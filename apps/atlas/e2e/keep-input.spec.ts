import { expect, test } from "@playwright/test";
import { expectAccessible, signUp, testEmail, uniqueId } from "./support";

/**
 * Input kept after refusal. React 19 resets a form after its action finishes, which would erase
 * what a person typed when the server refuses the save. Every Atlas form submits through
 * keepInputOnSubmit (packages/testing form audit); these journeys prove it end to end on forms the
 * server refuses: a wrong password, and an organization web address that is already taken.
 */
test.use({ reducedMotion: "reduce" });

test("input kept after refusal: sign in with a wrong password keeps the email", async ({
  page,
}) => {
  await page.goto("/auth/sign-in");
  const email = page.locator("#signin-email");
  await email.fill("owner@example.com");
  await page.locator("#signin-password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await expect(page.getByRole("alert").filter({ hasText: /\S/ }).first()).toBeVisible();
  await expect(email).toHaveValue("owner@example.com");
  await expect(page).toHaveURL(/\/auth\/sign-in/);
  await expectAccessible(page);
});

test("input kept after refusal: a taken web address keeps the organization name", async ({
  page,
}) => {
  const id = uniqueId();
  await signUp(page, { name: "Kim Keep", email: testEmail("keep", id) });
  await page.waitForURL("**/auth/organization");
  const name = page.getByLabel("Organization name");
  const slug = page.getByLabel("Web address");
  await name.fill(`Keep Input ${id}`);
  await slug.fill("demo-productions");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create organization" }).click();
  await expect(page.getByText(/already|taken|in use/i).first()).toBeVisible();
  await expect(name).toHaveValue(`Keep Input ${id}`);
  await expect(slug).toHaveValue("demo-productions");
  await expect(page).toHaveURL(/\/auth\/organization/);
  await expectAccessible(page);
});
