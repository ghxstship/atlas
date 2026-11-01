import type { Page } from "@playwright/test";
import { expect, settle, test } from "./engine-test";
import { ORG, signIn } from "./operations-support";
import { expectAccessible } from "./support";

/**
 * P7 (RRR-221, gap G-290): the org's own inventory in the command menu, on the demo tenant seed (0112). A
 * producer, who reads assets org-wide, finds a unit by its tag or serial and a class by its name under the
 * Inventory group, and Enter opens the page's peek. The field lead reads assets at assigned reach (1111): they
 * find the unit checked out to them, but not a unit that is not theirs, nor anything by a class name. pgTAP
 * covers the database side (supabase/tests/2840_inventory_search.test.sql).
 */
test.use({ reducedMotion: "reduce" });
// Each journey opens pages a development server may compile on first visit.
test.describe.configure({ mode: "serial", timeout: 480_000 });

async function openMenu(page: Page) {
  await page.locator("html[data-shell-ready]").waitFor({ state: "attached" });
  await page.keyboard.press("ControlOrMeta+k");
  const menu = page.getByRole("dialog").filter({ has: page.getByRole("combobox") });
  await expect(menu).toBeVisible({ timeout: 30_000 });
  return menu;
}

test("a producer finds units by tag or serial and classes by name, and opens their peeks", async ({
  page,
}) => {
  await signIn(page, "producer@example.com");
  await settle(page);

  // A tag typed in full: the unit first under Inventory, titled by its class, with the tag as its code.
  let menu = await openMenu(page);
  await page.keyboard.type("MH-002");
  let inventory = menu.getByRole("group", { name: "Inventory" });
  const first = inventory.getByRole("option").first();
  await expect(first).toContainText("Spot Fixture", { timeout: 60_000 });
  await expect(first).toContainText("MH-002");
  await expectAccessible(page);
  await first.click();
  await expect(page).toHaveURL(new RegExp(`/${ORG}/assets/units\\?peek=MH-002`), {
    timeout: 60_000,
  });
  const unitPeek = page.getByRole("dialog", { name: "MH-002" });
  await expect(unitPeek).toBeVisible({ timeout: 60_000 });
  await page.keyboard.press("Escape");
  await expect(unitPeek).toBeHidden({ timeout: 30_000 });

  // A serial typed in full finds its unit.
  menu = await openMenu(page);
  await page.keyboard.type("SPX-48810");
  inventory = menu.getByRole("group", { name: "Inventory" });
  await expect(inventory.getByRole("option").first()).toContainText("MH-001", { timeout: 60_000 });

  // A class by its name opens the asset classes page's peek.
  await menu.getByRole("combobox").fill("radio");
  inventory = menu.getByRole("group", { name: "Inventory" });
  const radio = inventory
    .getByRole("option")
    .filter({ hasText: "Digital Two-Way Radio · Asset class" });
  await expect(radio).toBeVisible({ timeout: 60_000 });
  await radio.click();
  await expect(page).toHaveURL(new RegExp(`/${ORG}/assets/asset-classes\\?peek=[0-9a-f-]{36}`), {
    timeout: 60_000,
  });
  await expect(page.getByRole("dialog", { name: /Digital Two-Way Radio/ })).toBeVisible({
    timeout: 60_000,
  });
});

test("the field lead finds the unit checked out to them, and nothing else of the inventory", async ({
  page,
}) => {
  await signIn(page, "field@example.com");
  await settle(page);

  const menu = await openMenu(page);
  await page.keyboard.type("MH-002");
  const inventory = menu.getByRole("group", { name: "Inventory" });
  await expect(inventory.getByRole("option").first()).toContainText("MH-002", { timeout: 60_000 });

  // MH-001 is not theirs, and they cannot read the Spot Fixture class, so neither shows any inventory.
  // The server action's reply is read, so the check waits for the search rather than passing before it.
  for (const query of ["MH-001", "spot"]) {
    const reply = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        r.request().headers()["next-action"] !== undefined &&
        (r.request().postData() ?? "").includes(query),
      { timeout: 60_000 },
    );
    await menu.getByRole("combobox").fill(query);
    expect(await (await reply).text(), query).not.toContain('"inventory"');
    await expect(menu.getByRole("group", { name: "Inventory" })).toHaveCount(0);
  }
});
