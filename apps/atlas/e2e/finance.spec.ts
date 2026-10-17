import { readFileSync } from "node:fs";
import { expect, settle, test, type Browser, type Page } from "./engine-test";
import { expectAccessible, uniqueId } from "./support";

/**
 * A15 Finance and Reports journeys (RRR-55, Section 20.2) on the demo tenant seed (supabase/seeds/0010,
 * 0107 and 0115), project NWS:
 *   3  a budget from catalog grades with an unpriced line, totals NULL-aware
 *   6  a change order raised unpriced, refused at pricing, priced, approved by someone else, and the
 *      revised budget moves
 *   7  a period is closed and a posting into it is refused
 *   8  the Universal Posting Line exported through each of the four canon mappings
 *   23 the final cost report against the gate 3 baseline
 *   33 two people edit one budget line; the second sees the conflict dialog and keeps theirs
 *   34 200 spreadsheet rows pasted as one batch, then undone
 *   37 budget totals shown in EUR at the recorded rate, with its date
 * plus the spend authority and separation of duties refusals. Every page is checked with axe in both
 * themes. Names carry a per-run id so reruns never collide.
 */

const ORG = "demo-productions";
const PROJECT = "NWS";
const DEMO_PASSWORD = `xos-demo-${"2026"}`;

test.use({ reducedMotion: "reduce" });
test.setTimeout(240_000);
expect.configure({ timeout: 20_000 });

async function signIn(page: Page, email: string) {
  await page.goto(`/auth/sign-in?next=${encodeURIComponent(`/${ORG}/home`)}`);
  await page.locator("#signin-email").fill(email);
  await page.locator("#signin-password").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await page.waitForURL(`**/${ORG}/home`);
}

async function asPerson(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext({ reducedMotion: "reduce" })).newPage();
  await signIn(page, email);
  return page;
}

/** axe in dark (the default) and light (Section 18, gate 8: both themes). */
async function expectAccessibleInBothThemes(page: Page) {
  await page.waitForTimeout(400);
  await expectAccessible(page);
  await page.context().addCookies([{ name: "xos-theme", value: "light", url: page.url() }]);
  await page.reload();
  await page.waitForTimeout(400);
  await expectAccessible(page);
  await page.context().addCookies([{ name: "xos-theme", value: "dark", url: page.url() }]);
  await page.reload();
}

/** A status message, or a toast in the page's Notifications live region (no status role there). */
const status = (page: Page, text: string | RegExp) =>
  page
    .getByRole("status")
    .or(page.getByRole("region", { name: "Notifications", exact: true }))
    .filter({ hasText: text });

/** Creates a working budget on NWS through the UI and opens it; returns its id. */
async function newBudget(page: Page, name: string): Promise<string> {
  await page.goto(`/${ORG}/finance/budgets?project=${PROJECT}&create=1`);
  const sheet = page.getByRole("dialog", { name: "New budget" });
  await sheet.getByLabel("Budget name").fill(name);
  await sheet.getByRole("button", { name: "New budget" }).click();
  await page.waitForURL(/peek=/);
  const id = new URL(page.url()).searchParams.get("peek") ?? "";
  await page.goto(`/${ORG}/finance/budgets?project=${PROJECT}&budget=${id}`);
  await expect(page.getByRole("heading", { name, exact: false }).first()).toBeVisible();
  // The grid and its sheets are client components; typing before hydration is lost.
  await page.waitForLoadState("networkidle");
  return id;
}

/** Adds a line through the Add line sheet; a blank price stays Unpriced. */
async function addLine(page: Page, description: string, price?: string) {
  // A refresh still landing from the previous change would re-render the sheet mid-typing.
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Add line" }).click();
  const add = page.getByRole("dialog", { name: "Add line" });
  await add.getByLabel("Description").fill(description);
  await add.getByLabel("URID").fill("4000.01.01");
  await expect(page.getByRole("listbox").getByRole("option").first()).toContainText("4000.01.01");
  await add.getByLabel("URID").press("Enter");
  if (price !== undefined) await add.getByLabel("Unit price").fill(price);
  await add.getByRole("button", { name: "Add line" }).click();
  await expect(add).toBeHidden();
}

test.describe("Budgets (journeys 3, 33, 34 and 37)", () => {
  test("a budget from catalog grades keeps an unpriced line out of the totals", async ({
    page,
  }) => {
    const id = uniqueId();
    await signIn(page, "producer@example.com");
    await newBudget(page, `Journey 3 ${id}`);
    await expectAccessibleInBothThemes(page);

    await page.getByRole("button", { name: "Add from catalog" }).click();
    const catalog = page.getByRole("dialog", { name: "Add from catalog" });
    await catalog.getByLabel("Search the catalog").fill("4000.01.01");
    await catalog.getByRole("button", { name: "Search" }).click();
    await catalog.getByLabel("Grade").selectOption({ index: 0 });
    await catalog.getByLabel("Quantity").first().fill("2");
    await catalog.getByRole("button", { name: /^Add 1 element$/ }).click();
    await expect(catalog).toBeHidden();

    await addLine(page, "Fireworks barge, quote pending");

    await expect(page.getByText(/^1 line is unpriced; priced lines total \$/)).toBeVisible();
    await expect(
      page.getByText("The variance is unknown until every line is priced."),
    ).toBeVisible();
    await expectAccessible(page);
  });

  test("totals show in EUR at the recorded rate with its date", async ({ page }) => {
    await signIn(page, "producer@example.com");
    await page.goto(`/${ORG}/finance/budgets?project=${PROJECT}`);
    await page
      .getByRole("navigation", { name: "Show totals in" })
      .getByRole("link", {
        name: "EUR",
      })
      .click();
    await expect(
      page.getByText(/Converted at 0\.918 EUR per USD, the rate recorded on/),
    ).toBeVisible();
    await expectAccessibleInBothThemes(page);
  });

  test("200 pasted rows land as one batch and undo removes them", async ({ page }) => {
    const id = uniqueId();
    await signIn(page, "producer@example.com");
    await newBudget(page, `Journey 34 ${id}`);
    const rows = Array.from(
      { length: 200 },
      (_, i) => `Pasted line ${i + 1}\t4000.01.01\t${(i % 4) + 1}\t${i % 10 === 0 ? "" : "125.00"}`,
    ).join("\n");
    await page.getByRole("button", { name: "Paste rows" }).click();
    const paste = page.getByRole("dialog", { name: "Paste rows" });
    await paste.getByLabel("Rows from your spreadsheet").fill(rows);
    await expect(paste).toContainText("200 lines ready, 20 unpriced, no problems.");
    await paste.getByRole("button", { name: "Add 200 lines" }).click();
    await expect(status(page, "200 lines pasted.")).toBeVisible();
    await expect(
      page.getByText("20 lines are unpriced; priced lines total $57,500.00."),
    ).toBeVisible();
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByText("This budget has no lines yet.", { exact: false })).toBeVisible();
  });

  test("a line saved by someone else opens the conflict dialog", async ({ page, browser }) => {
    const id = uniqueId();
    await signIn(page, "producer@example.com");
    const budget = await newBudget(page, `Journey 33 ${id}`);
    await addLine(page, "Delay towers", "1500.00");

    const other = await asPerson(browser, "owner@example.com");
    await other.goto(`/${ORG}/finance/budgets?project=${PROJECT}&budget=${budget}`);

    const grid = (p: Page) => p.getByRole("grid", { name: "Budget lines" });
    const description = (p: Page) => grid(p).getByRole("gridcell", { name: /Delay towers/ });
    await description(other).dblclick();
    await other.keyboard.press("ControlOrMeta+a");
    await other.keyboard.type("Delay towers, two sets");
    await other.keyboard.press("Enter");
    await expect(grid(other)).toContainText("Delay towers, two sets");
    // The grid shows the edit before the save lands; the conflict needs the save committed first.
    await settle(other);

    await description(page).dblclick();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("Delay towers, one set");
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "This line changed while you edited it" });
    await expect(dialog).toBeVisible();
    await expectAccessible(page);
    await dialog.getByRole("button", { name: "Take theirs" }).click();
    await expect(grid(page)).toContainText("Delay towers, two sets");
  });
});

/** Opens a transition from the record's transition bar and confirms it with its default reason. */
async function transition(page: Page, label: string) {
  await page.getByRole("button", { name: label, exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: label });
  await dialog.getByRole("button", { name: label, exact: true }).click();
  return dialog;
}

/** Picks the first URID option the combobox ranks for the typed code. */
async function pickUrid(page: Page, scope: ReturnType<Page["getByRole"]>, urid: string) {
  await scope.getByLabel("URID").fill(urid);
  await expect(page.getByRole("listbox").getByRole("option").first()).toContainText(urid);
  await scope.getByLabel("URID").press("Enter");
}

test.describe("Change orders (journey 6)", () => {
  test("unpriced is refused at pricing, then priced, approved by someone else, and the budget moves", async ({
    page,
    browser,
  }) => {
    const id = uniqueId();
    await signIn(page, "producer@example.com");
    const budget = await newBudget(page, `Journey 6 ${id}`);
    await addLine(page, "Bar build", "1000.00");

    await page.goto(`/${ORG}/finance/change-orders?project=${PROJECT}&create=1`);
    const sheet = page.getByRole("dialog", { name: "New change order" });
    await sheet.getByLabel("Budget").selectOption({ value: budget });
    await sheet.getByLabel("Title").fill(`Second bar ${id}`);
    await sheet.getByLabel("Why the change is needed").fill("The client added a second bar.");
    await sheet.getByRole("button", { name: "New change order" }).click();
    await page.waitForURL(/peek=/);
    const order = new URL(page.url()).searchParams.get("peek") ?? "";
    await expectAccessibleInBothThemes(page);

    const lineForm = page.getByRole("form", { name: "Add line" });
    await lineForm.getByLabel("Description").fill("Second bar build");
    await pickUrid(page, lineForm, "4000.01.01");
    await lineForm.getByRole("button", { name: "Add line" }).click();
    await expect(page.getByText("Unpriced, 1 line has no price").first()).toBeVisible();

    const refused = await transition(page, "Mark priced");
    await expect(
      refused.getByText("Every line needs a price, or No cost, before the change order is priced."),
    ).toBeVisible();
    await expectAccessible(page);
    await refused.getByRole("button", { name: "Cancel" }).click();

    await page.getByRole("button", { name: "Remove" }).click();
    await expect(page.getByText("No lines yet.", { exact: false })).toBeVisible();
    await lineForm.getByLabel("Description").fill("Second bar build, quoted");
    await pickUrid(page, lineForm, "4000.01.01");
    await lineForm.getByLabel("Unit price in USD").fill("2500.00");
    await lineForm.getByRole("button", { name: "Add line" }).click();
    await expect(page.getByRole("table", { name: "Lines" })).toContainText("$2,500.00");
    await transition(page, "Mark priced");
    await expect(
      page.getByText("You requested this change order, so someone else approves it."),
    ).toBeVisible();

    const owner = await asPerson(browser, "owner@example.com");
    await owner.goto(`/${ORG}/finance/change-orders?project=${PROJECT}&peek=${order}`);
    await transition(owner, "Approve");
    await expect(owner.getByRole("button", { name: "Approve", exact: true })).toBeHidden();

    await owner.goto(`/${ORG}/finance/budgets?project=${PROJECT}&budget=${budget}`);
    await expect(owner.getByText("1 approved change order")).toBeVisible();
    await expect(owner.getByText("$3,500.00").first()).toBeVisible();
  });
});

test.describe("Periods and separation of duties (journey 7)", () => {
  test("a closed period refuses a posting, and a submitter cannot approve their own expense", async ({
    page,
    browser,
  }) => {
    // A month of its own per run, far from the seeded 2026 periods.
    const n = Math.floor(Date.now() / 1000) % 600;
    const year = 2040 + Math.floor(n / 12);
    const month = String((n % 12) + 1).padStart(2, "0");
    const last = new Date(Date.UTC(year, (n % 12) + 1, 0)).getUTCDate();

    const owner = await asPerson(browser, "owner@example.com");
    await owner.goto(`/${ORG}/finance/periods?create=1`);
    const sheet = owner.getByRole("dialog", { name: "Open period" });
    await sheet.getByLabel("Starts on").fill(`${year}-${month}-01`);
    await sheet.getByLabel("Ends on").fill(`${year}-${month}-${last}`);
    await sheet.getByRole("button", { name: "Open period" }).click();
    await owner.waitForURL(/peek=/);
    await transition(owner, "Start period");
    await transition(owner, "Start close");
    await transition(owner, "Close period");
    await expect(owner.getByText("Refuses postings").first()).toBeVisible();
    await expectAccessibleInBothThemes(owner);

    await signIn(page, "producer@example.com");
    await page.goto(`/${ORG}/finance/expenses?project=${PROJECT}&create=1`);
    const create = page.getByRole("dialog", { name: "New expense" });
    await create.locator("#expense-line").click();
    await expect(page.getByRole("listbox").getByRole("option").first()).toBeVisible();
    await create.locator("#expense-line").press("Enter");
    await create.getByLabel("Description").fill(`Generator hire ${year}-${month}`);
    await create.locator("#expense-amount").fill("120.00");
    await create.getByLabel("Incurred on").fill(`${year}-${month}-10`);
    await create.getByRole("button", { name: "New expense" }).click();
    await page.waitForURL(/peek=/);
    const expense = new URL(page.url()).searchParams.get("peek") ?? "";

    // Separation of duties: the submitter is told someone else approves, and is offered no Approve.
    await expect(
      page.getByText("You submitted this expense, so someone else approves it."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
    await expectAccessible(page);

    await owner.goto(`/${ORG}/finance/expenses?project=${PROJECT}&peek=${expense}`);
    const closed = await transition(owner, "Approve");
    await expect(
      closed.getByText("That period is Closed, Audited or Archived and refuses postings."),
    ).toBeVisible();
  });
});

test.describe("Universal Posting Line export (journey 8)", () => {
  test("exports through each of the four canon mappings", async ({ page }) => {
    await signIn(page, "owner@example.com");
    await page.goto(`/${ORG}/finance/universal-posting-line-export`);
    await expectAccessibleInBothThemes(page);
    const expected: Record<string, string> = {
      xero: "AccountCode",
      quickbooks: "Product/Service",
      netsuite: "Entity",
      ramp: "Merchant",
    };
    const form = page.getByRole("form", { name: "Export CSV" });
    for (const [target, column] of Object.entries(expected)) {
      await form.getByLabel("Format").selectOption(target);
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        form.getByRole("button", { name: "Export CSV" }).click(),
      ]);
      expect(download.suggestedFilename()).toContain(target);
      const header = readFileSync(await download.path(), "utf8").split("\r\n")[0] ?? "";
      expect(header.split(",")).toContain(column);
    }
  });
});

test.describe("Reports (journey 23)", () => {
  test("the final cost report compares the gate 3 baseline with posted actuals", async ({
    page,
  }) => {
    await signIn(page, "owner@example.com");
    await page.goto(`/${ORG}/reports/final-cost-report?project=${PROJECT}`);
    await expect(page.getByRole("table", { name: "Final cost by GL account" })).toBeVisible();
    await expect(page.getByText(/Actual is every posted debit less credit/)).toBeVisible();
    await expectAccessibleInBothThemes(page);
    await page.goto(`/${ORG}/reports/budget-versus-actual?project=${PROJECT}`);
    await expect(page.getByRole("table", { name: "Budget versus actual" }).first()).toBeVisible();
    await expectAccessibleInBothThemes(page);
  });
});
