import { expect, test, type Page } from "@playwright/test";
import { DEMO_ORG, signInAs } from "./a36-support";
import { createOrganization, expectAccessible, signUp, testEmail, uniqueId } from "./support";

/**
 * A60's shell and layout fixes from the A59 visual review: project tabs that do not fit collect
 * under More (A59-003), help cards wait while a drawer is open (A59-002), and at phone width the
 * top bar keeps two crumbs (A59-004), settings open on a collapsed section picker (A59-005) and
 * tables become stacked cards (A59-013).
 */

const PHONE = { width: 375, height: 812 };

async function settled(page: Page) {
  await page.waitForLoadState("networkidle");
}

test("project tabs past the bar's width sit under More, and the current tab stays shown", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signInAs(page, "owner@example.com", DEMO_ORG);
  await page.goto(`/${DEMO_ORG}/p/NWS/procurement`);
  await settled(page);
  const tabs = page.getByRole("navigation", { name: "Project tabs" });
  await expect(tabs.getByRole("link", { name: "Procurement" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(tabs.getByRole("link", { name: "Procurement" })).toBeInViewport();
  const more = tabs.getByRole("button", { name: "More tabs" });
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(more).toHaveAttribute("aria-expanded", "true");
  const settings = tabs.getByRole("link", { name: "Settings", exact: true });
  await expect(settings).toBeVisible();
  await expectAccessible(page);
  await page.keyboard.press("Escape");
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await expect(more).toBeFocused();
  await more.click();
  await tabs.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/${DEMO_ORG}/p/NWS/settings`));
  await expect(tabs.getByRole("link", { name: "Settings", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
});

test("a help card waits while a drawer is open and comes back when it closes", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const id = uniqueId();
  const slug = `tips-${id}`;
  await signUp(page, { name: "Tia Tips", email: testEmail("tips", id) });
  await createOrganization(page, { name: `Tips ${id}`, slug });
  await page.goto(`/${slug}/projects/all`);
  const card = page.locator("[data-help-card]");
  await expect(card).toBeVisible({ timeout: 15_000 });
  await page.goto(`/${slug}/projects/all?create=1`);
  const drawer = page.getByRole("dialog", { name: "New project" });
  await expect(drawer).toBeVisible();
  await settled(page);
  await expect(card).toHaveCount(0);
  await expect(drawer.getByRole("button", { name: "Create project" })).toBeInViewport();
  await drawer.getByRole("button", { name: "Close" }).click();
  await expect(drawer).toBeHidden();
  await expect(card).toBeVisible();
});

test.describe("at phone width", () => {
  test.use({ viewport: PHONE });

  test("the top bar keeps two crumbs, settings start at the form, tables are cards", async ({
    page,
  }) => {
    await signInAs(page, "owner@example.com", DEMO_ORG);

    // A59-004: only the parent and the current page show in the top bar.
    await page.goto(`/${DEMO_ORG}/p/NWS/advancing`);
    await settled(page);
    const crumbs = page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("listitem");
    const shown = await crumbs.evaluateAll((items) =>
      items.filter((li) => li.getBoundingClientRect().width > 0).map((li) => li.textContent),
    );
    expect(shown).toEqual(["NWS", "Advancing"]);

    // A59-005: a section page opens on a collapsed picker naming the section.
    await page.goto(`/${DEMO_ORG}/settings/numbering`);
    await settled(page);
    const sections = page.getByRole("navigation", { name: "Settings sections" });
    const picker = sections.getByRole("button", { name: "Numbering" });
    await expect(picker).toHaveAttribute("aria-expanded", "false");
    await expect(sections.getByRole("link", { name: "General" })).toBeHidden();
    await expect(page.getByLabel("Number padding")).toBeInViewport();
    await expectAccessible(page);
    await picker.click();
    await expect(sections.getByRole("link", { name: "General" })).toBeVisible();

    // A59-013: a table view is stacked cards; a card opens its record.
    await page.goto(`/${DEMO_ORG}/projects/all?view=table`);
    await settled(page);
    await expect(page.getByRole("grid")).toHaveCount(0);
    const card = page.getByRole("button", { name: "Northwind Summer Series" });
    await expect(card).toBeVisible();
    await expectAccessible(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
