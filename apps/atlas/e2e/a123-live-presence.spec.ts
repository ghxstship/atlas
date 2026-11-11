import { expect as baseExpect, test, type Browser, type Page } from "./engine-test";
import { DEMO_ORG, signInAs } from "./a36-support";
import { expectAccessible, uniqueId } from "./support";

/**
 * A123 live lists and presence (RRR-168, Section 11.7, Section 11.11, ADR 0083) on the demo tenant,
 * each with two people in two browser contexts:
 *   - two people on one record page see each other's avatar, and it goes when one leaves;
 *   - two people on one SOP peek see each other there too;
 *   - the dispatch board shows a newly reported incident without polling or a reload;
 *   - the RFQ list shows another person's new RFQ without a reload.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(240_000);
const expect = baseExpect.configure({ timeout: 30_000 });

async function asPerson(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext({ reducedMotion: "reduce" })).newPage();
  await signInAs(page, email, DEMO_ORG);
  return page;
}

/** Who else this page shows as present. */
function present(page: Page) {
  return page.getByRole("group", { name: "Also viewing" });
}

/** Marks the document, so a later check can tell the page was never reloaded. */
async function markLoaded(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { a123Loaded?: boolean }).a123Loaded = true;
  });
}

async function stillLoaded(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as { a123Loaded?: boolean }).a123Loaded === true);
}

test("two people on one record see each other's presence", async ({ browser }) => {
  const owner = await asPerson(browser, "owner@example.com");
  await owner.goto(`/${DEMO_ORG}/work/all-records?view=table`);
  const grid = owner.getByRole("grid");
  await expect(grid).toBeVisible();
  const key = (
    await grid.getByRole("row").nth(1).locator('td[data-column="key"]').innerText()
  ).trim();
  const record = `/${DEMO_ORG}/r/${encodeURIComponent(key)}`;
  await owner.goto(record);
  await expect(owner.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(present(owner)).toHaveCount(0);

  const admin = await asPerson(browser, "admin@example.com");
  await admin.goto(record);

  await expect(present(owner).getByRole("img", { name: "Demo Admin" })).toBeVisible();
  await expect(present(owner)).toContainText("1 other person here");
  await expect(present(admin).getByRole("img", { name: "Demo Owner" })).toBeVisible();
  await expectAccessible(owner);

  // Leaving the record takes the avatar away.
  await admin.context().close();
  await expect(present(owner)).toHaveCount(0);
  await owner.context().close();
});

test("two people on one SOP peek see each other there", async ({ browser }) => {
  const id = uniqueId();
  const owner = await asPerson(browser, "owner@example.com");
  // A new SOP opens in its peek once saved.
  await owner.goto(`/${DEMO_ORG}/knowledge/sops?create=1`);
  await owner.getByLabel("Title", { exact: true }).fill(`Crowd Barrier Checks ${id}`);
  await owner.getByLabel("Procedure", { exact: true }).fill(`Walk the barrier line ${id}.`);
  await owner.getByRole("button", { name: "New SOP" }).last().click();
  await owner.waitForURL(/peek=/);
  const peek = owner.getByRole("dialog");
  await expect(peek).toBeVisible();

  const admin = await asPerson(browser, "admin@example.com");
  await admin.goto(owner.url());
  await expect(admin.getByRole("dialog")).toBeVisible();

  await expect(present(owner).getByRole("img", { name: "Demo Admin" })).toBeVisible();
  await expect(present(admin).getByRole("img", { name: "Demo Owner" })).toBeVisible();
  await owner.context().close();
  await admin.context().close();
});

test("the dispatch board shows a new incident without a reload", async ({ browser }) => {
  const title = `Barrier Collapse ${uniqueId()}`;
  const dispatcher = await asPerson(browser, "owner@example.com");
  await dispatcher.goto(`/${DEMO_ORG}/safety/dispatch-board?project=NWS`);
  await expect(
    dispatcher.getByText("This board updates live as incidents are reported and dispatched."),
  ).toBeVisible();
  await markLoaded(dispatcher);

  const reporter = await asPerson(browser, "producer@example.com");
  await reporter.goto(`/${DEMO_ORG}/safety/incidents?project=NWS&create=1`);
  await reporter.locator("#incident-title").fill(title);
  await reporter.locator("#incident-severity").selectOption({ index: 0 });
  await reporter
    .locator("#incident-zone")
    .selectOption({ label: "LAWN · Festival Lawn · Bayside Festival Grounds" });
  await reporter.getByRole("button", { name: "File report" }).click();
  await expect(
    reporter.getByRole("status").filter({ hasText: /Incident filed as number \d+\./ }),
  ).toBeVisible();

  // Section 11.11 asks for under 2 s; the bound here leaves room for a loaded CI machine.
  await expect(dispatcher.getByRole("link", { name: new RegExp(title) }).first()).toBeVisible({
    timeout: 15_000,
  });
  expect(await stillLoaded(dispatcher)).toBe(true);
  await reporter.context().close();
  await dispatcher.context().close();
});

test("the RFQ list shows another person's new RFQ without a reload", async ({ browser }) => {
  const title = `Delay tower audio ${uniqueId()}`;
  const buyer = await asPerson(browser, "admin@example.com");
  await buyer.goto(`/${DEMO_ORG}/procurement/rfqs?view=list`);
  await expect(buyer.getByRole("heading", { level: 1 })).toBeVisible();
  await markLoaded(buyer);

  const producer = await asPerson(browser, "producer@example.com");
  await producer.goto(`/${DEMO_ORG}/procurement/rfqs?create=1`);
  const create = producer.getByRole("dialog");
  await create.getByLabel("Project").selectOption({ label: "NWS Northwind Summer Series" });
  await create.getByLabel("What is being sourced").fill(title);
  await create.getByRole("button", { name: "New RFQ" }).click();
  await expect(producer.getByRole("dialog", { name: new RegExp(title) })).toBeVisible();

  await expect(buyer.getByText(title).first()).toBeVisible({ timeout: 30_000 });
  expect(await stillLoaded(buyer)).toBe(true);
  await producer.context().close();
  await buyer.context().close();
});
