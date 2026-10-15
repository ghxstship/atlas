import { expect, type Page } from "@playwright/test";
import { expectAccessible } from "./support";

/** Shared steps of the A16 journeys on the demo tenant (seeds 0010, 0107 and 0116). */

export const ORG = "demo-productions";
const DEMO_PASSWORD = `xos-demo-${"2026"}`;

export async function signIn(page: Page, email = "owner@example.com") {
  await page.goto(`/auth/sign-in?next=${encodeURIComponent(`/${ORG}/home`)}`);
  await page.locator("#signin-email").fill(email);
  await page.locator("#signin-password").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await page.waitForURL(`**/${ORG}/home`);
}

async function hydrated(page: Page) {
  await page.waitForLoadState("networkidle");
  // Drawers mount after hydration and slide in; axe measures contrast once they settle.
  await page.waitForTimeout(400);
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== "running"),
  );
  await page.waitForFunction(() =>
    [...document.querySelectorAll<HTMLElement>(".overscroll-x-contain")].every(
      (e) => e.scrollWidth <= e.clientWidth + 1 || e.tabIndex === 0,
    ),
  );
}

/** axe in the dark theme (the default) and in light (Section 18, gate 8). */
export async function expectAccessibleInBothThemes(page: Page) {
  await hydrated(page);
  await expectAccessible(page);
  await page.context().addCookies([{ name: "xos-theme", value: "light", url: page.url() }]);
  await page.reload();
  await hydrated(page);
  await expectAccessible(page);
  await page.context().addCookies([{ name: "xos-theme", value: "dark", url: page.url() }]);
  await page.reload();
}

/** Opens a collection page and checks its heading. */
export async function openPage(page: Page, path: string, heading: string) {
  await page.goto(`/${ORG}/${path}`);
  await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
}

/** Opens a row's peek from the list view, where every row has an Open button. */
export async function openRow(page: Page, text: string) {
  const url = new URL(page.url());
  url.searchParams.set("view", "list");
  await page.goto(url.toString());
  await page
    .getByRole("row")
    .filter({ hasText: text })
    .first()
    .getByRole("button", { name: "Open" })
    .click();
}

/** Runs a dialog-confirmed action: clicks the button, types a reason when asked, confirms. */
export async function act(
  page: Page,
  scope: ReturnType<Page["locator"]>,
  label: string,
  reason?: string,
) {
  await scope.getByRole("button", { name: label, exact: true }).first().click();
  const dialog = page.getByRole("dialog").last();
  if (reason !== undefined) await dialog.getByLabel("Reason").fill(reason);
  await dialog.getByRole("button", { name: label, exact: true }).click();
}
