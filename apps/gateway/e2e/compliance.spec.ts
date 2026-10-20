import { expect, test, type Browser } from "./engine-test";
import { expectAccessible } from "./support";

/**
 * A82 compliance journeys on Gateway (RRR-127, finding A65-014): the cookie banner with equal
 * choices, the server-side record, Cookie settings, and Global Privacy Control (Section 14.3). The
 * config sends Global Privacy Control so the banner stays out of other journeys; these tests open
 * their own contexts. The "16 or older" question is covered in sign-up.spec.ts and
 * google-sign-in.spec.ts.
 */

async function plainContext(browser: Browser) {
  return browser.newContext({ extraHTTPHeaders: {} });
}

test("the cookie banner asks once and Cookie settings changes the choice", async ({ browser }) => {
  const context = await plainContext(browser);
  const page = await context.newPage();
  await page.goto("/auth/sign-in");
  const banner = page.getByRole("region", { name: "Cookies" });
  await expect(banner).toBeVisible();
  await expect(
    banner.getByText(/remember your language and theme for 12 months/).first(),
  ).toBeVisible();
  await expectAccessible(page);
  await banner.getByRole("button", { name: "Accept all" }).click();
  await expect(banner).toHaveCount(0);
  const consent = (await context.cookies()).find((c) => c.name === "xos-consent")?.value;
  expect(consent).toMatch(/^1\.[0-9a-f]{32}\.11\.0$/);

  await page.goto("/legal/cookie-settings");
  await expect(page.getByRole("heading", { level: 1, name: "Cookie settings" })).toBeVisible();
  await expect(page.getByText("Your choice: Preferences on, Performance on.")).toBeVisible();
  await expect(page.getByRole("rowheader", { name: "xos-acting" })).toBeVisible();
  await expectAccessible(page);
  await page.getByRole("button", { name: "Reject all" }).click();
  await expect(page.getByText("Your choice: Preferences off, Performance off.")).toBeVisible();
  await page.goto("/legal/cookie-policy");
  await expect(page.getByRole("heading", { level: 1, name: "Cookie Policy" })).toBeVisible();
  await context.close();
});

test("Global Privacy Control replaces the banner on Gateway", async ({ browser }) => {
  const context = await browser.newContext({ extraHTTPHeaders: { "Sec-GPC": "1" } });
  const page = await context.newPage();
  await page.goto("/auth/sign-in");
  await expect(page.getByRole("region", { name: "Cookies" })).toHaveCount(0);
  const consent = (await context.cookies()).find((c) => c.name === "xos-consent")?.value;
  expect(consent).toMatch(/\.00\.1$/);
  await context.close();
});
