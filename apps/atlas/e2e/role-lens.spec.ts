import type { Page } from "@playwright/test";
import { expect, test } from "./engine-test";
import { expectAccessibleInBothThemes } from "./a16-support";
import { signInAs as signIn } from "./a36-support";

/**
 * The role lens under the org switcher (Section 4.8.1, A128, ADR 0086). Demo Multi-Role (multi@example.com) is a
 * Producer and a Member of Demo Productions, and an Admin and a Field user of Demo Bayside Studios (seeds 1080_a38
 * and 2210_a128). Choosing one role hides the other role's navigation and Inbox items, All roles restores them,
 * and a lens never shows more than the person's own roles do.
 */

test.use({ reducedMotion: "reduce" });

const TIMESHEET = "Approval requested: Timesheet for Demo Road Crew";
const MENTION = /mentioned you on Load-in plan/;

async function chooseRole(page: Page, role: string) {
  const lens = page.getByTestId("role-lens");
  await lens.locator("summary").click();
  await lens.getByRole("button", { name: role, exact: true }).click();
  await expect(lens.locator("summary")).toContainText(role);
}

test("the Member lens hides the Producer's Inbox items, and All roles brings them back", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signIn(page, "multi@example.com", "demo-productions");
  await page.goto("/demo-productions/inbox");
  await expect(page.getByText(TIMESHEET)).toBeVisible();
  await expect(page.getByText(MENTION)).toBeVisible();
  const lens = page.getByTestId("role-lens");
  await expect(lens.locator("summary")).toContainText("All roles");

  await chooseRole(page, "Member");
  // The approval request reached them through the Producer role only; the mention is theirs under every lens.
  await expect(page.getByText(TIMESHEET)).toHaveCount(0);
  await expect(page.getByText(MENTION)).toBeVisible();
  await expectAccessibleInBothThemes(page);

  // The choice holds for the session, page to page.
  await page.goto("/demo-productions/home");
  await expect(lens.locator("summary")).toContainText("Member");

  await chooseRole(page, "All roles");
  await page.goto("/demo-productions/inbox");
  await expect(page.getByText(TIMESHEET)).toBeVisible();
});

test("the Field lens hides the Admin's navigation, a link still opens, and All roles restores it", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signIn(page, "multi@example.com", "demo-bayside-studios");
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: "Finance", exact: true })).toBeVisible();

  await chooseRole(page, "Field");
  await expect(nav.getByRole("link", { name: "Finance", exact: true })).toHaveCount(0);
  // The lens narrows navigation, not access: a link to a page the Admin may open still opens it.
  await page.goto("/demo-bayside-studios/finance");
  await expect(page.getByRole("heading", { level: 1, name: "Finance" })).toBeVisible();

  await chooseRole(page, "All roles");
  await expect(nav.getByRole("link", { name: "Finance", exact: true })).toBeVisible();
});

test("a person with one role is offered no lens", async ({ page }) => {
  await signIn(page, "producer@example.com", "demo-productions");
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  await expect(page.getByTestId("role-lens")).toHaveCount(0);
});
