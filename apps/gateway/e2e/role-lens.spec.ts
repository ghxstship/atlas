import type { Page } from "@playwright/test";
import { expect, settle, test } from "./engine-test";
import { expectAccessible, signIn } from "./support";

/**
 * Gateway's role lens (Section 4.8.1, A128, ADR 0089), in the Switch org dialog. Demo Multi-Role
 * (multi@example.com, seed 1080_a38) is crew for Demo Harbor Events and an artist for Demo Night Festival.
 * Choosing Artist narrows Work and the switcher's orgs to the artist engagement; All roles restores both.
 */

test.use({ reducedMotion: "reduce" });

async function chooseRole(page: Page, role: string) {
  await page.getByRole("button", { name: /Open the account menu/ }).click();
  await page.getByRole("button", { name: "Switch Org", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Switch org" });
  await expect(dialog.getByRole("group", { name: "Role" })).toBeVisible();
  await dialog.getByRole("button", { name: role, exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

test("the Artist lens narrows Work to the artist engagement, and All roles restores the crew one", async ({
  page,
}) => {
  test.setTimeout(180_000);
  // The phone layout puts the account menu, and the switcher in it, one tap away.
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, "multi@example.com", "/work/engagements");
  await settle(page);
  await expect(page.getByText("Demo Harbor Events").first()).toBeVisible();
  await expect(page.getByText("Demo Night Festival").first()).toBeVisible();

  await chooseRole(page, "Artist");
  await expect(page.getByText("Demo Night Festival").first()).toBeVisible();
  await expect(page.getByText("Demo Harbor Events")).toHaveCount(0);
  await expectAccessible(page);

  // The switcher lists only the orgs the lens shows, and marks the lens chosen.
  await page.getByRole("button", { name: /Open the account menu/ }).click();
  await page.getByRole("button", { name: "Switch Org", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Switch org" });
  await expect(dialog.getByRole("button", { name: "Demo Harbor Events" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Artist", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.keyboard.press("Escape");

  await chooseRole(page, "All roles");
  await expect(page.getByText("Demo Harbor Events").first()).toBeVisible();
  await expect(page.getByText("Demo Night Festival").first()).toBeVisible();
});

test("a person with one role type is offered no lens", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, "crew@example.com", "/work/engagements");
  await settle(page);
  await page.getByRole("button", { name: /Open the account menu/ }).click();
  await page.getByRole("button", { name: "Switch Org", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Switch org" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("group", { name: "Role" })).toHaveCount(0);
});
