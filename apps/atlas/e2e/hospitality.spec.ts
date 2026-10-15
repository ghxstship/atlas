import { expect, test, type Page } from "@playwright/test";
import { expectAccessible } from "./support";
import { expectAccessibleInBothThemes, ORG, signIn } from "./operations-support";

/**
 * A11 Hospitality journeys (Section 20.2, RRR-57): journey 21, assign lodging and catering, generate
 * a BEO and confirm it, on the demo tenant seed (supabase/seeds/0010, 0107 and 0111). The Owner
 * authors; the Producer approves the BEO, because its author never may. Accommodation blocks refuse
 * a room beyond the rooms held. Every page is checked with axe in both themes.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(240_000);
expect.configure({ timeout: 20_000 });

async function newFulfillment(page: Page, kind: string, title: string) {
  await page.goto(`/${ORG}/hospitality/fulfillments`);
  await page.getByRole("link", { name: "New fulfillment" }).first().click();
  const drawer = page.getByRole("dialog", { name: "New fulfillment" });
  await drawer.getByLabel("Project").selectOption({ label: "NWS Northwind Summer Series" });
  await drawer.getByLabel("Kind").selectOption(kind);
  await drawer.getByLabel("What is fulfilled").fill(title);
  await drawer.getByRole("button", { name: "New fulfillment" }).click();
  await page.waitForURL(/peek=NWS-\d+/);
  return new URL(page.url()).searchParams.get("peek") ?? "";
}

test("fulfillments, BEOs and accommodation blocks render in every view", async ({ page }) => {
  await signIn(page, "producer@example.com");
  for (const view of ["list", "table", "board", "calendar"]) {
    await page.goto(`/${ORG}/hospitality/fulfillments?view=${view}&month=2027-03`);
    await expect(page.getByRole("heading", { level: 1, name: "Fulfillments" })).toBeVisible();
    await expectAccessibleInBothThemes(page);
  }
  for (const view of ["list", "table", "calendar"]) {
    await page.goto(`/${ORG}/hospitality/beos?view=${view}&month=2027-03`);
    await expect(page.getByRole("heading", { level: 1, name: "BEOs" })).toBeVisible();
    await expectAccessibleInBothThemes(page);
    await page.goto(`/${ORG}/hospitality/accommodation-blocks?view=${view}&month=2027-03`);
    await expect(
      page.getByRole("heading", { level: 1, name: "Accommodation blocks" }),
    ).toBeVisible();
    await expectAccessibleInBothThemes(page);
  }
  await page.goto(`/${ORG}/p/NWS/hospitality?section=blocks`);
  await expect(page.getByRole("heading", { level: 1, name: "Accommodation blocks" })).toBeVisible();
  await page.getByRole("button", { name: "Open" }).first().click();
  await expect(page.getByRole("heading", { name: "Rooms by night" })).toBeVisible();
  await expectAccessibleInBothThemes(page);
});

test("journey 21: assign lodging and catering, generate a BEO and confirm it", async ({
  page,
  browser,
}) => {
  const run = Date.now().toString(36).toUpperCase();
  await signIn(page, "owner@example.com");

  // Lodging with a priced line for a guest, confirmed.
  const lodging = await newFulfillment(page, "Lodging", `Artist Lodging ${run}`);
  const lodgingPeek = page.getByRole("dialog", { name: `Artist Lodging ${run}` });
  await lodgingPeek.getByLabel("What is provided").fill("King Room");
  await lodgingPeek.getByLabel("Guest").selectOption({ label: "Demo Field Lead" });
  await lodgingPeek.getByLabel("Quantity").fill("2");
  await lodgingPeek.getByLabel("Unit price").fill("189.00");
  await lodgingPeek.getByRole("button", { name: "Add line" }).click();
  await expect(lodgingPeek.getByText("2 King Room")).toBeVisible();
  await expect(lodgingPeek.getByText("$378.00").first()).toBeVisible();
  await lodgingPeek.getByLabel("Move to").selectOption("Active");
  await lodgingPeek.getByLabel("Reason").fill("Room list confirmed.");
  await lodgingPeek.getByRole("button", { name: "Move", exact: true }).click();
  await expect(lodgingPeek.getByText("Room list confirmed.")).toBeVisible();
  await expectAccessibleInBothThemes(page);
  expect(lodging).toMatch(/^NWS-\d+$/);

  // Catering, and a BEO generated from it with a priced and an unpriced line.
  await newFulfillment(page, "Catering", `Artist Dinner ${run}`);
  const cateringPeek = page.getByRole("dialog", { name: `Artist Dinner ${run}` });
  await cateringPeek.getByRole("link", { name: "Generate BEO" }).click();
  const beoDrawer = page.getByRole("dialog", { name: "Generate BEO" });
  await beoDrawer.getByLabel("Meal service").fill("2027-03-13T19:00");
  await beoDrawer.getByLabel("Guaranteed guests").fill("40");
  await expectAccessible(page);
  await beoDrawer.getByRole("button", { name: "Generate BEO" }).click();
  await page.waitForURL(/beos\?peek=NWS-\d+/);
  const beoKey = new URL(page.url()).searchParams.get("peek") ?? "";
  const beo = page.getByRole("dialog", { name: `BEO for Artist Dinner ${run}` });
  await beo.getByLabel("Menu item or service").fill("Plated Dinner");
  await beo.getByLabel("Quantity").fill("40");
  await beo.getByLabel("Unit price").fill("45.00");
  await beo.getByRole("button", { name: "Add line" }).click();
  await expect(beo.getByText("40 Plated Dinner")).toBeVisible();
  await beo.getByLabel("Menu item or service").fill("Coffee Service");
  await beo.getByLabel("Unit price").fill("");
  await beo.getByLabel("Quantity").fill("1");
  await beo.getByRole("button", { name: "Add line" }).click();
  await expect(beo.getByText("1 line unpriced")).toBeVisible();
  // The author cannot approve their own BEO.
  await expect(beo.getByRole("button", { name: "Approve BEO" })).toHaveCount(0);
  await expect(
    beo.getByText("You wrote this BEO, so someone else with approval rights must approve it."),
  ).toBeVisible();
  await expectAccessibleInBothThemes(page);

  // The Producer approves it, then confirms the catering.
  const producer = await (await browser.newContext()).newPage();
  await signIn(producer, "producer@example.com");
  await producer.goto(`/${ORG}/hospitality/beos?peek=${beoKey}`);
  const approving = producer.getByRole("dialog", { name: `BEO for Artist Dinner ${run}` });
  await approving.getByRole("button", { name: "Approve BEO" }).click();
  await expect(approving.getByText(/Approved .* by Demo Producer/)).toBeVisible();
  await expectAccessibleInBothThemes(producer);
  await producer.goto(`/${ORG}/hospitality/fulfillments?view=table`);
  await producer.getByRole("gridcell", { name: `Artist Dinner ${run}` }).dblclick();
  const confirm = producer.getByRole("dialog", { name: `Artist Dinner ${run}` });
  await expect(confirm.getByText("Approved")).toBeVisible();
  await confirm.getByLabel("Move to").selectOption("Active");
  await confirm.getByLabel("Reason").fill("BEO approved and sent to the caterer.");
  await confirm.getByRole("button", { name: "Move", exact: true }).click();
  await expect(confirm.getByText("BEO approved and sent to the caterer.")).toBeVisible();

  // A one-room block refuses a second guest on the same nights.
  await page.goto(`/${ORG}/hospitality/accommodation-blocks?create=1`);
  const blockDrawer = page.getByRole("dialog", { name: "New block" });
  await blockDrawer.getByLabel("Project").selectOption({ label: "NWS Northwind Summer Series" });
  await blockDrawer.getByLabel("Block name").fill(`Green Room Suite ${run}`);
  await blockDrawer.getByLabel("Check-in").fill("2027-03-12");
  await blockDrawer.getByLabel("Check-out").fill("2027-03-14");
  await blockDrawer.getByLabel("Rooms held each night").fill("1");
  await blockDrawer.getByRole("button", { name: "New block" }).click();
  const block = page.getByRole("dialog", { name: `Green Room Suite ${run}` });
  await block.getByLabel("Guest").selectOption({ label: "Demo Field Lead" });
  await block.getByRole("button", { name: "Assign room" }).click();
  await expect(block.getByText("0 of 2 room nights assigned")).toHaveCount(0);
  await expect(block.getByRole("button", { name: "Remove Demo Field Lead" })).toBeVisible();
  await block.getByLabel("Guest").selectOption({ label: "Demo Admin" });
  await block.getByRole("button", { name: "Assign room" }).click();
  await expect(
    block.getByText(
      "Every room in the block is taken on at least one of those nights. Shorten the stay or add rooms to the block.",
    ),
  ).toBeVisible();
  await expectAccessibleInBothThemes(page);
});
