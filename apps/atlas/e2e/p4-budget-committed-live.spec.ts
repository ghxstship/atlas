import { readFileSync } from "node:fs";
import { expect as baseExpect, settle, test, type Browser, type Page } from "./engine-test";
import { act, ORG, signIn } from "./a16-support";
import { expectAccessible, uniqueId } from "./support";

/**
 * P4 planned, committed and actual on every budget line, and live co-editing of a budget (RRR-218,
 * gaps G-204 and G-216, Section 4.2 and Section 11.7) on the demo tenant, project NWS:
 *   a  a purchase order line drawing on a budget line through the new Budget line select, approved by
 *      someone other than its creator, fills Committed on that line and in the Committed figure of
 *      a grid already open, without a reload; the budget versus actual report and its CSV carry it;
 *   b  two people on one budget see each other, a description saved by one appears in the other's
 *      grid live, and an open cell shows the others who is editing which line;
 *   c  both pages pass axe.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(300_000);
const expect = baseExpect.configure({ timeout: 30_000 });
const PROJECT = "NWS";

async function asPerson(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext({ reducedMotion: "reduce" })).newPage();
  await signIn(page, email);
  return page;
}

async function markLoaded(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { p4Loaded?: boolean }).p4Loaded = true;
  });
}

async function stillLoaded(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as { p4Loaded?: boolean }).p4Loaded === true);
}

const grid = (page: Page) => page.getByRole("grid", { name: "Budget lines" });
const present = (page: Page) => page.getByRole("group", { name: "Also viewing" });

/** Creates a working budget on NWS with one priced line and opens its grid; returns its id. */
async function budgetWithLine(page: Page, name: string, line: string): Promise<string> {
  await page.goto(`/${ORG}/finance/budgets?project=${PROJECT}&create=1`);
  const sheet = page.getByRole("dialog", { name: "New budget" });
  await sheet.getByLabel("Budget name").fill(name);
  await sheet.getByRole("button", { name: "New budget" }).click();
  await page.waitForURL(/peek=/);
  const id = new URL(page.url()).searchParams.get("peek") ?? "";
  await page.goto(`/${ORG}/finance/budgets?project=${PROJECT}&budget=${id}`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Add line" }).click();
  const add = page.getByRole("dialog", { name: "Add line" });
  await add.getByLabel("Description").fill(line);
  await add.getByLabel("URID").fill("4000.01.01");
  await expect(page.getByRole("listbox").getByRole("option").first()).toContainText("4000.01.01");
  await add.getByLabel("URID").press("Enter");
  await add.getByLabel("Unit price").fill("2000.00");
  await add.getByRole("button", { name: "Add line" }).click();
  await expect(add).toBeHidden();
  await expect(grid(page)).toContainText(line);
  return id;
}

/** Approves the step an order's approval waits on, as the signed-in approver, from Approvals. */
async function decideStep(page: Page, poNumber: string, step: string) {
  await page.goto(`/${ORG}/approvals`);
  const heading = page.getByRole("heading", { name: `Purchase order ${poNumber}`, exact: true });
  const item = page.getByRole("listitem").filter({ has: heading });
  await expect(item.getByText(step).first()).toBeVisible();
  await page.waitForLoadState("networkidle");
  await item.getByRole("button", { name: "Approve step" }).click();
  await expect(item.getByRole("button", { name: "Approve step" })).toHaveCount(0);
}

test("an approved purchase order line fills Committed live, and the report carries it", async ({
  page,
  browser,
}) => {
  const id = uniqueId();
  const budgetName = `P4 Committed ${id}`;
  const lineName = `Delay towers ${id}`;
  await signIn(page, "producer@example.com");
  const budget = await budgetWithLine(page, budgetName, lineName);
  await expect(page.getByText("No lines committed", { exact: false })).toBeVisible();
  await markLoaded(page);

  // The producer raises the order in a second tab, drawing its line on the budget line.
  const buyer = await asPerson(browser, "producer@example.com");
  await buyer.goto(`/${ORG}/procurement/purchase-orders?create=1`);
  const create = buyer.getByRole("dialog");
  await create.getByLabel("Project").selectOption({ label: "NWS Northwind Summer Series" });
  await create.getByLabel("Vendor").selectOption({ label: "Demo Staging Supply" });
  await create.getByRole("button", { name: "New purchase order" }).click();
  await expect(buyer.getByRole("heading", { level: 2, name: "Lines" })).toBeVisible();
  const orderUrl = buyer.url();
  await buyer.waitForLoadState("networkidle");
  const lineForm = buyer.locator("form", { has: buyer.getByLabel("Budget line") });
  await lineForm.getByLabel("Description").fill(`Delay tower system ${id}`);
  await lineForm.getByLabel("Quantity").fill("2");
  await lineForm.getByLabel("Unit price").fill("750.00");
  await lineForm
    .getByLabel("Budget line")
    .selectOption({ label: `${budgetName} · 1 · ${lineName} (USD)` });
  await lineForm.getByRole("button", { name: "Add line" }).click();
  await expect(buyer.getByRole("table", { name: "Lines" })).toContainText(budgetName);
  const poNumber = /PO\D*(\d+)/.exec(await buyer.locator("header").first().innerText())?.[1] ?? "";
  expect(poNumber).not.toBe("");

  // The demo approval policy (seed 1030): Finance review and Owner sign-off, then approval by
  // someone other than the creator (sod_po_creator) within spend authority.
  await buyer.goto(`/${ORG}/approvals`);
  const submit = buyer.getByRole("form", { name: "Submit a document for approval" });
  const document = `Purchase order: NWS PO ${poNumber} (NWS)`;
  await submit.getByLabel("Document").selectOption({ label: document });
  await submit.getByRole("button", { name: "Submit for approval" }).click();
  await expect(buyer.getByRole("option", { name: document })).toHaveCount(0);
  const admin = await asPerson(browser, "admin@example.com");
  await decideStep(admin, poNumber, "Finance review");
  const owner = await asPerson(browser, "owner@example.com");
  await decideStep(owner, poNumber, "Owner sign-off");
  await admin.goto(orderUrl);
  await act(admin, admin.locator("header"), "Approve", "Within budget and spend authority.");
  await expect(admin.getByText("Approved", { exact: true }).first()).toBeVisible();

  // The grid open since before the order shows the commitment on the line and in the figure.
  const row = grid(page).getByRole("row").filter({ hasText: lineName });
  await expect(row).toContainText("$1,500.00");
  await expect(page.getByText("1 line committed", { exact: false })).toBeVisible();
  expect(await stillLoaded(page)).toBe(true);
  await expectAccessible(page);

  // Budget versus actual: Committed sits after Revised, and the CSV carries it.
  await page.goto(`/${ORG}/reports/budget-versus-actual?project=${PROJECT}`);
  const table = page.getByRole("table", { name: "Budget versus actual" }).first();
  await expect(table.getByRole("columnheader", { name: "Committed" })).toBeVisible();
  await settle(page);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV", exact: true }).click();
  const csv = readFileSync((await (await download).path()) ?? "", "utf8");
  expect(csv.split("\n")[0]).toContain("Committed");
  await expectAccessible(page);

  await page.goto(`/${ORG}/finance/budgets?project=${PROJECT}&budget=${budget}`);
  await expect(grid(page).getByRole("columnheader", { name: "Committed" })).toBeVisible();
  for (const p of [buyer, admin, owner]) await p.context().close();
});

test("two people on one budget see each other, and each other's edits live", async ({
  page,
  browser,
}) => {
  const id = uniqueId();
  const lineName = `Barricade run ${id}`;
  await signIn(page, "producer@example.com");
  const budget = await budgetWithLine(page, `P4 Live ${id}`, lineName);
  await markLoaded(page);

  const owner = await asPerson(browser, "owner@example.com");
  await owner.goto(`/${ORG}/finance/budgets?project=${PROJECT}&budget=${budget}`);
  await owner.waitForLoadState("networkidle");
  await expect(present(page).getByRole("img", { name: "Demo Owner" })).toBeVisible();
  await expect(present(owner).getByRole("img", { name: "Demo Producer" })).toBeVisible();

  // The owner saves a new description; the producer, with no cell open, sees it without a reload.
  await grid(owner)
    .getByRole("gridcell", { name: new RegExp(lineName) })
    .dblclick();
  await owner.keyboard.press("ControlOrMeta+a");
  await owner.keyboard.type(`${lineName}, two rows`);
  await owner.keyboard.press("Enter");
  await expect(grid(page)).toContainText(`${lineName}, two rows`);
  expect(await stillLoaded(page)).toBe(true);

  // While the producer has a cell open, the owner sees which line they are editing.
  await grid(page)
    .getByRole("gridcell", { name: new RegExp(lineName) })
    .dblclick();
  await expect(owner.getByText("Demo Producer is editing line 1")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(owner.getByText("Demo Producer is editing line 1")).toHaveCount(0);
  await expectAccessible(owner);
  await owner.context().close();
  await expect(present(page)).toHaveCount(0);
});
