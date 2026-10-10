import { expect, test } from "@playwright/test";
import { createOrganization, expectAccessible, signUp, testEmail, uniqueId } from "./support";

test("sign up, create an org with legal acceptance, and land on an empty Home", async ({
  page,
}) => {
  const id = uniqueId();
  await signUp(page, { name: "Avery Producer", email: testEmail("owner", id) });
  await createOrganization(page, { name: `Northlight ${id}`, slug: `northlight-${id}` });

  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
  await expect(page.getByRole("heading", { name: `Get Northlight ${id} ready` })).toBeVisible();
  await expect(page.getByText("0 of 8 done")).toBeVisible();
  await expect(page.getByText(`Northlight ${id} is on the Access plan.`)).toBeVisible();
  await expectAccessible(page);
});

test("signed-out visitors are sent to sign in and the form keeps the email on failure", async ({
  page,
}) => {
  await page.goto("/some-org/home");
  await expect(page).toHaveURL(/\/auth\/sign-in\?next=%2Fsome-org%2Fhome/);
  await page.locator("#signin-email").fill("nobody@atlas-e2e.test");
  await page.locator("#signin-password").fill("wrong-password");
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "do not match" })).toBeVisible();
  await expect(page.locator("#signin-email")).toHaveValue("nobody@atlas-e2e.test");
  await expectAccessible(page);
});
