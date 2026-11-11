import { expect as baseExpect, settle, test, type Browser, type Page } from "./engine-test";
import { ORG, signIn } from "./a16-support";
import { expectAccessible, uniqueId } from "./support";

/**
 * B12 payables, credits, reimbursements and act costs (RRR-236, gaps G-184, G-186, G-195, G-223, G-224 and G-228) on the
 * demo tenant, project NWS:
 *   a  a producer files an expense they paid themselves; it is Recorded, the owner approves it and it is Owed, with no
 *      Mark paid; the finance lead records its reimbursement from a sheet of at most three fields, and the row's result
 *      shows as a page-level notice that survives the refresh; voiding returns it to Owed;
 *   b  the Due tab lists what is owed, and none of the tabs adds a primary action or a control that says it pays;
 *   c  an approved charge takes a credit, shown negative with Credited and Net on the charge;
 *   d  a viewer does not reach the tabs;
 *   e  the pages pass axe.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(300_000);
const expect = baseExpect.configure({ timeout: 30_000 });
const PROJECT = "NWS";
const expenses = (query: string) => `/${ORG}/finance/expenses?project=${PROJECT}&${query}`;
const payments = (query: string) => `/${ORG}/finance/payments?project=${PROJECT}&${query}`;

async function asPerson(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext({ reducedMotion: "reduce" })).newPage();
  await signIn(page, email);
  return page;
}

/** Files an expense on NWS from the form and returns its id. */
async function fileExpense(
  page: Page,
  input: { description: string; amount: string; paidMyself: boolean },
): Promise<string> {
  await page.goto(expenses("create=1"));
  const create = page.getByRole("dialog", { name: "New expense" });
  await create.locator("#expense-line").click();
  await expect(page.getByRole("listbox").getByRole("option").first()).toBeVisible();
  await create.locator("#expense-line").press("Enter");
  await create.getByLabel("Description", { exact: true }).fill(input.description);
  await create.locator("#expense-amount").fill(input.amount);
  // A day in a seeded period that is open (seed 0115), since approval posts in the period of the date.
  await create.locator("#expense-date").fill("2026-10-15");
  if (input.paidMyself) {
    await create.getByRole("switch", { name: "I paid this myself" }).check();
  }
  await expect(async () => {
    await create.getByRole("button", { name: "New expense", exact: true }).click();
    await expect(page).toHaveURL(/peek=/, { timeout: 5_000 });
  }).toPass();
  return new URL(page.url()).searchParams.get("peek") ?? "";
}

/** Runs a transition button's reason dialog on the current peek. */
async function transition(page: Page, label: string): Promise<void> {
  await settle(page);
  await expect(async () => {
    await page.getByRole("button", { name: label, exact: true }).first().click();
    await expect(page.getByRole("dialog", { name: label })).toBeVisible({ timeout: 3_000 });
  }).toPass();
  const dialog = page.getByRole("dialog", { name: label });
  await dialog.getByLabel("Reason").fill("Checked against the receipt.");
  await dialog.getByRole("button", { name: label, exact: true }).click();
  await expect(dialog).toBeHidden();
}

test("a reimbursement is recorded, says so, and can be voided", async ({ browser }) => {
  const id = uniqueId();
  const description = `Gaffer tape ${id}`;
  const producer = await asPerson(browser, "producer@example.com");
  const owner = await asPerson(browser, "owner@example.com");

  const expenseId = await fileExpense(producer, {
    description,
    amount: "42.50",
    paidMyself: true,
  });
  await expect(producer.getByText("Recorded", { exact: true }).first()).toBeVisible();

  await owner.goto(expenses(`peek=${expenseId}`));
  await transition(owner, "Approve");
  await owner.goto(expenses(`peek=${expenseId}`));
  await expect(owner.getByText("Owed", { exact: true }).first()).toBeVisible();
  // A reimbursable charge offers no Mark paid, and points at its payee's row instead.
  await expect(owner.getByRole("button", { name: "Mark paid", exact: true })).toHaveCount(0);
  await owner.getByRole("link", { name: "Open reimbursements" }).click();
  await owner.waitForURL(/tab=reimbursements/);
  await expect(owner.getByRole("grid")).toContainText("Demo Producer");

  await owner.getByRole("link", { name: /^Record reimbursement in USD/ }).click();
  const sheet = owner.getByRole("dialog", { name: "Record reimbursement" });
  await expect(sheet.getByText("XOS records this payment. It moves no money.")).toBeVisible();
  await expect(sheet.getByText("Net total")).toBeVisible();
  await sheet.getByLabel("Bank or card reference", { exact: true }).fill(`ACH-${id}`);
  await expect(async () => {
    await sheet.getByRole("button", { name: "Record reimbursement", exact: true }).click();
    await expect(owner).toHaveURL(/notice=reimbursementRecorded/, { timeout: 5_000 });
  }).toPass();
  // The only owed charge was recorded, so its sheet left with the refresh: the notice and the cleared flags came with it.
  const recorded = owner.getByText("Reimbursement recorded.");
  await expect(recorded).toBeVisible();
  await expect(owner).not.toHaveURL(/[?&](record|currency)=/);
  await expect(sheet).toBeHidden();
  await owner.reload();
  await expect(recorded).toBeVisible();
  await expect(owner.getByText(`ACH-${id}`)).toBeVisible();

  await owner.getByRole("link", { name: "Void reimbursement" }).first().click();
  const voiding = owner.getByRole("dialog", { name: "Void reimbursement" });
  await voiding.getByLabel("Reason").fill("The bank returned the transfer.");
  await expect(async () => {
    await voiding.getByRole("button", { name: "Void reimbursement", exact: true }).click();
    await expect(owner).toHaveURL(/notice=reimbursementVoided/, { timeout: 5_000 });
  }).toPass();
  await expect(owner.getByText("Reimbursement voided.")).toBeVisible();
  await expect(owner).not.toHaveURL(/voidReimbursement=/);
  await owner.goto(expenses(`peek=${expenseId}`));
  await expect(owner.getByText("Owed", { exact: true }).first()).toBeVisible();
});

test("the Due and Act costs tabs add no primary action and say nothing pays", async ({ page }) => {
  await signIn(page, "owner@example.com");
  await page.goto(payments("tab=due"));
  await expect(page.getByRole("link", { name: "Due", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByRole("button", { name: "Record payment", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Pay\b/ })).toHaveCount(0);
  await expectAccessible(page);

  await page.goto(payments("tab=act-costs"));
  await expect(page.getByRole("link", { name: "Act costs", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByRole("button", { name: "Record payment", exact: true })).toHaveCount(0);
  await expectAccessible(page);
});

test("an approved charge takes a credit, shown negative, netted on the charge", async ({
  browser,
}) => {
  const id = uniqueId();
  const description = `Rigging deposit ${id}`;
  const producer = await asPerson(browser, "producer@example.com");
  const owner = await asPerson(browser, "owner@example.com");
  const expenseId = await fileExpense(producer, {
    description,
    amount: "120.00",
    paidMyself: false,
  });

  await owner.goto(expenses(`peek=${expenseId}`));
  await transition(owner, "Approve");
  await owner.goto(expenses(`peek=${expenseId}`));
  await owner.getByRole("link", { name: "Record credit", exact: true }).click();
  const sheet = owner.getByRole("dialog", { name: "Record credit" });
  await sheet.locator("#credit-amount").fill("40.00");
  await expect(async () => {
    await sheet.getByRole("button", { name: "Record credit", exact: true }).click();
    await expect(sheet).toBeHidden({ timeout: 5_000 });
  }).toPass();
  await expect(owner.getByRole("link", { name: `Credit of ${description}` })).toBeVisible();

  // The owner recorded the credit, so another approver decides it; the charge shows it pending meanwhile.
  await owner.goto(expenses(`peek=${expenseId}`));
  await expect(owner.getByText("Pending credits", { exact: true })).toBeVisible();
  await expect(owner.getByRole("heading", { name: "Credits", exact: true })).toBeVisible();
  await expectAccessible(owner);
});

// The Commercial group is hidden from a Viewer, so the route itself answers 404 (ADR 0017 item 3). Every system role that
// sees it holds the capabilities, so the refusal panel is for custom roles: apps/atlas/test/payables-refusal.test.ts.
test("a viewer does not reach the payables tabs", async ({ page }) => {
  await signIn(page, "viewer@example.com");
  for (const tab of ["due", "reimbursements", "act-costs"]) {
    const response = await page.goto(payments(`tab=${tab}`));
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("grid")).toHaveCount(0);
  }
});
