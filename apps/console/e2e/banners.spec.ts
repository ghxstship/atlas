import { expect, test, type Page } from "@playwright/test";
import {
  ATLAS_URL,
  DEMO,
  DEMO_PASSWORD,
  GATEWAY_URL,
  expectAccessibleInBothThemes,
  newOperator,
  signInOperator,
  sql,
  uniqueId,
} from "./support";

/**
 * System banners (A90, Section 4.10): Support publishes a banner in the console; Atlas and Gateway show it after the
 * page loads (their route caches it up to a minute); a person dismisses a dismissible one on their device; ending it
 * takes it off every shell. Atlas and Gateway run against the same local stack (E2E_ATLAS_URL, E2E_GATEWAY_URL).
 */

async function expectBanner(page: Page, url: string, text: string) {
  // The shells cache the answer up to a minute; reload until the new banner arrives.
  await expect(async () => {
    await page.goto(url);
    await expect(page.getByTestId("system-banners").getByText(text)).toBeVisible({
      timeout: 5_000,
    });
  }).toPass({ timeout: 90_000, intervals: [2_000, 5_000, 10_000] });
}

test("a banner published in the console shows in Atlas and Gateway and can be dismissed", async ({
  page,
  browser,
}) => {
  // End any banner an earlier run left live, so this one is the only one.
  await sql(`update app.system_banners set ended_at = now() where ended_at is null`);
  const message = `Scheduled maintenance tonight, sync may pause (${uniqueId()}).`;
  const email = await newOperator("Support", "Bea Banner");
  await signInOperator(page, email, "/banners");
  const form = page.getByTestId("banner-form");
  await form.getByLabel("Severity").selectOption("Warning");
  await form.getByLabel("Message (English)").fill(message);
  await form.getByRole("button", { name: "Publish" }).click();
  await expect(form.getByText("Banner saved.")).toBeVisible();
  await expect(page.getByTestId("banners").getByText(message)).toBeVisible();
  await expectAccessibleInBothThemes(page);

  // Atlas: the demo Owner sees it on the org's pages.
  const atlas = await browser.newPage({ baseURL: ATLAS_URL });
  await atlas.goto(`/auth/sign-in?next=${encodeURIComponent(`/${DEMO.orgSlug}/home`)}`);
  await atlas.locator("#signin-email").fill("owner@example.com");
  if (!(await atlas.locator("#signin-password").isVisible())) {
    await atlas.getByRole("button", { name: "Use a password" }).click();
  }
  await atlas.locator("#signin-password").fill(DEMO_PASSWORD);
  await atlas.getByRole("button", { name: "Sign in with password" }).click();
  await atlas.waitForURL(`**/${DEMO.orgSlug}/home`);
  await expectBanner(atlas, `/${DEMO.orgSlug}/home`, message);

  // Gateway: the demo crew person sees it, dismisses it, and it stays hidden on this device.
  const gateway = await browser.newPage({ baseURL: GATEWAY_URL });
  await gateway.goto(`/auth/sign-in?next=${encodeURIComponent("/home")}`);
  await gateway.locator("#signin-email").fill("crew@example.com");
  await gateway.getByRole("button", { name: "Use a password" }).click();
  await gateway.locator("#signin-password").fill(DEMO_PASSWORD);
  await gateway.getByRole("button", { name: "Sign in with password" }).click();
  await gateway.waitForURL("**/home");
  await expectBanner(gateway, "/home", message);
  await gateway.getByTestId("system-banners").getByRole("button", { name: "Dismiss" }).click();
  await expect(gateway.getByTestId("system-banners")).toHaveCount(0);
  await gateway.reload();
  await gateway.waitForTimeout(3_000);
  await expect(gateway.getByText(message)).toHaveCount(0);

  // Ending it in the console takes it off the shells once their cache turns over.
  const [banner] = await sql<{ id: string }>(
    `select id from app.system_banners where message = $1`,
    [message],
  );
  await page.reload();
  await page
    .getByTestId("banners")
    .locator("li", { hasText: message })
    .getByRole("button", { name: "End now" })
    .click();
  await expect(
    page.getByTestId("banners").locator("li", { hasText: message }).getByTestId("banner-state"),
  ).toHaveText("Ended");
  const [ended] = await sql<{ ended: boolean }>(
    `select ended_at is not null as ended from app.system_banners where id = $1`,
    [banner?.id],
  );
  expect(ended?.ended).toBe(true);
  await atlas.close();
  await gateway.close();
});
