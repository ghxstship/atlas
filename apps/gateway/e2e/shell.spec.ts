import { expect, test } from "./engine-test";
import { DEMO, expectAccessible, expectAccessibleInBothThemes, signIn } from "./support";

/**
 * The Gateway shell and navigation (Section 4.5.8, gate 23): the five destinations, Home with Up
 * Next and the Needs You feed, the command menu, both themes, engagement tabs per role type and
 * 404 for anything outside the person's set.
 */
test("a crew member signs in and moves through the five destinations", async ({ page }) => {
  await signIn(page, "crew@example.com");
  await expect(page.getByRole("heading", { level: 1, name: /Hi, Demo/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Up next" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Needs you" })).toBeVisible();
  await expect(page.getByText("Sign Crew Agreement 2027")).toBeVisible();
  await expectAccessibleInBothThemes(page);

  const nav = page.getByRole("navigation", { name: "Primary navigation" }).first();
  for (const [name, path] of [
    ["Explore", "/explore"],
    ["Work", "/work/upcoming"],
    ["Money", "/money/overview"],
    ["Messages", "/messages"],
  ] as const) {
    await nav.getByRole("link", { name }).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expectAccessible(page);
  }

  // Command menu: Cmd or Ctrl+K, type, Enter.
  await page.keyboard.press("ControlOrMeta+k");
  // The menu loads on first use, as in Atlas; typing before it opens would be lost.
  await expect(page.getByRole("dialog").filter({ has: page.getByRole("combobox") })).toBeVisible();
  await page.keyboard.type("Tax Documents");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/money\/tax-documents$/);
});

test("engagement tabs follow the role type and hidden tabs answer 404", async ({ page }) => {
  await signIn(page, "crew@example.com");
  await page.goto(`/work/engagements/${DEMO.crewEngagementKey}/overview`);
  const tabs = page.getByRole("navigation", { name: "Engagement sections" });
  for (const name of [
    "Overview",
    "Offer",
    "Onboarding",
    "Shifts",
    "Timesheets",
    "Travel and Lodging",
    "Per Diem",
    "Credentials",
    "Documents",
    "Messages",
  ]) {
    await expect(tabs.getByRole("link", { name, exact: true })).toBeVisible();
  }
  await expect(tabs.getByRole("link", { name: "Purchase Orders" })).toHaveCount(0);
  await expectAccessibleInBothThemes(page);

  const response = await page.goto(`/work/engagements/${DEMO.crewEngagementKey}/purchase-orders`);
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();

  const unknown = await page.goto("/work/engagements/ENG-0000000000000000000000ZZZZ/overview");
  expect(unknown?.status()).toBe(404);
});

test("signed-out visitors go to sign in and come back afterwards", async ({ page }) => {
  await page.goto("/money/payments");
  await expect(page).toHaveURL(/\/auth\/sign-in\?next=%2Fmoney%2Fpayments$/);
  await expectAccessible(page);
  await page.locator("#signin-email").fill("crew@example.com");
  await page.locator("#signin-password").fill(["xos", "demo", "2026"].join("-"));
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await expect(page).toHaveURL(/\/money\/payments$/);
});

test("personal settings save and show where the value comes from", async ({ page }) => {
  await signIn(page, "crew@example.com", "/settings/preferences");
  await expect(page.getByRole("heading", { level: 1, name: "Preferences" })).toBeVisible();
  await expectAccessible(page);
  const firstSave = page.getByRole("button", { name: "Save" }).first();
  await firstSave.click();
  await expect(page.getByText("Your own setting.").first()).toBeVisible();
});
