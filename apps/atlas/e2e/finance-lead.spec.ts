import { expect as baseExpect, test } from "@playwright/test";
import { ORG, signIn } from "./a16-support";
import { expectAccessible } from "./support";

/**
 * Journey 51 (Section 20.2, Section 4.5.2). A Finance Lead (seed 1080: a Manager whose persona is
 * finance-lead) signs in for the first time and sees Commercial expanded and every other module
 * group collapsed. An Admin then turns Hospitality off: its pages leave the sidebar and the
 * command menu (Atlas's search), and come back when it is turned on again. The Help article about
 * Hospitality stays searchable, so the probe is one of the module's pages, Accommodation Blocks.
 * settings.spec.ts covers the switch on a fresh org; this covers the persona layout and the
 * command menu on the demo org.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(180_000);
const expect = baseExpect.configure({ timeout: 20_000 });

const GROUPS = ["Production", "Operations", "People", "Commercial", "Knowledge"];
const PAGE = "Accommodation Blocks";

test("journey 51: the Finance Lead's first sign-in opens Commercial only", async ({ page }) => {
  await signIn(page, "finance@example.com");
  const nav = page.getByRole("navigation", { name: "Main" });
  for (const group of GROUPS) {
    await expect(nav.getByRole("button", { name: group, exact: true })).toHaveAttribute(
      "aria-expanded",
      group === "Commercial" ? "true" : "false",
    );
  }
  await expect(nav.getByRole("link", { name: "Finance", exact: true })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Hospitality", exact: true })).toBeHidden();
  await expectAccessible(page);
});

test("journey 51: Hospitality turned off leaves the sidebar and the command menu", async ({
  page,
}) => {
  await signIn(page, "admin@example.com");
  const commandFinds = async () => {
    await page.keyboard.press("ControlOrMeta+k");
    const dialog = page.getByRole("dialog", { name: "Command menu" });
    await dialog.getByRole("combobox").fill(PAGE);
    const found = await dialog.getByRole("option", { name: new RegExp(PAGE) }).count();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    return found;
  };
  const operations = page.getByRole("navigation", { name: "Main" }).getByRole("button", {
    name: "Operations",
    exact: true,
  });
  await page.goto(`/${ORG}/home`);
  expect(await commandFinds()).toBeGreaterThan(0);

  await page.goto(`/${ORG}/settings/modules`);
  await page.getByRole("checkbox", { name: "Hospitality" }).uncheck();
  await page.getByRole("button", { name: "Save modules" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  try {
    await page.goto(`/${ORG}/home`);
    if ((await operations.getAttribute("aria-expanded")) === "false") await operations.click();
    await expect(page.locator(`a[href="/${ORG}/logistics"]`).first()).toBeVisible();
    await expect(page.locator(`a[href="/${ORG}/hospitality"]`)).toHaveCount(0);
    expect(await commandFinds()).toBe(0);
    await expectAccessible(page);
  } finally {
    await page.goto(`/${ORG}/settings/modules`);
    await page.getByRole("checkbox", { name: "Hospitality" }).check();
    await page.getByRole("button", { name: "Save modules" }).click();
    await expect(page.getByText("Saved.")).toBeVisible();
  }
  await page.goto(`/${ORG}/home`);
  expect(await commandFinds()).toBeGreaterThan(0);
});
