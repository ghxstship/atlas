import type { Locator } from "@playwright/test";
import pg from "pg";
import { ORG, signIn } from "./a16-support";
import { expect as baseExpect, settle, test, type Page } from "./engine-test";
import { expectAccessible } from "./support";

/**
 * P10 (RRR-224, gap G-217), Section 4.5.6 org settings item 16 and Section 4.6.3: budget lines carry the org's own
 * tags. The demo Owner defines a filterable Choice field Tag on budget lines in Settings, tags two lines from the
 * grid's Line fields drawer, and filters the grid with Add filter: only the Rental line stays, the grid's total is
 * that line's, the budget figures still cover every line, and Clear filters brings every line back. The filtered
 * grid is saved as a view, which reopens with its condition. The budget is a fixture on the demo project, and the
 * field, the budget and the view are removed again afterwards.
 */
test.use({ reducedMotion: "reduce" });
// Saves re-render the org's pages (revalidatePath on the org layout) before the change shows (A71).
const expect = baseExpect.configure({ timeout: 20_000 });

/** The demo project (seed 0107, key NWS). */
const PROJECT = "01920000-0000-7000-8000-000000001001";

/** Runs SQL on the local stack only, as postgres. */
async function localSql<T extends Record<string, unknown>>(
  text: string,
  args: unknown[],
): Promise<T[]> {
  const url =
    process.env["E2E_DATABASE_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:55422/postgres";
  if (!/@(127\.0\.0\.1|localhost):/.test(url))
    throw new Error("Set E2E_DATABASE_URL to the local stack.");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query(text, args)).rows as T[];
  } finally {
    await client.end();
  }
}

/** Clicks a control until what it opens shows: the Add filter control loads after the grid (A71). */
async function openWith(page: Page, trigger: Locator, opened: Locator) {
  await settle(page);
  await expect(async () => {
    await trigger.click();
    await expect(opened).toBeVisible({ timeout: 5_000 });
  }).toPass();
}

test("budget lines are tagged, filtered by tag and kept in a saved view", async ({ page }) => {
  test.setTimeout(8 * 60_000);
  const stamp = Date.now().toString(36).toUpperCase();
  const label = `Tag ${stamp}`;
  const key = `tag_${stamp.toLowerCase()}`;
  const viewName = `Rental lines ${stamp}`;
  const [budget] = await localSql<{ id: string }>(
    `insert into app.budgets (project_id, name, currency_code) values ($1, $2, 'USD') returning id`,
    [PROJECT, `Tagged Budget ${stamp}`],
  );
  const budgetId = budget?.id as string;
  await localSql(
    `insert into app.budget_lines (budget_id, line_number, description, urid, quantity, unit_price_minor, xyz, xyz_basis)
     values ($1, 1, 'Stage deck rental', '0000.01.01', 2, 15000, 'X', 'Declared'),
            ($1, 2, 'Crew overtime', '0000.01.01', 1, 40000, 'X', 'Declared'),
            ($1, 3, 'Catering', '0000.01.01', 1, 12500, 'X', 'Declared')`,
    [budgetId],
  );
  await signIn(page);

  try {
    // The field: a filterable Choice on budget lines.
    await page.goto(`/${ORG}/settings/custom-fields`);
    const form = page.getByRole("form", { name: "Add a field" });
    await form.getByLabel("Records").selectOption({ label: "Budget lines" });
    await form.getByLabel("Label").fill(label);
    await form.getByLabel("Type").selectOption({ label: "Choice" });
    await form.getByLabel("Filterable in views").check();
    await form.getByRole("button", { name: "Add field" }).click();
    const row = page.getByRole("listitem").filter({ hasText: label });
    await expect(row.getByText("Filterable")).toBeVisible();
    for (const choice of ["Rental", "Overtime"]) {
      const add = page.getByRole("form", { name: `Add a choice to ${label}` });
      await add.getByLabel("New choice").fill(choice);
      await add.getByRole("button", { name: "Add choice" }).click();
      await expect(row.getByText(new RegExp(`Choices: .*${choice}`))).toBeVisible();
    }

    // The grid shows the field as a read-only column; Line fields tags two lines.
    const grid = `/${ORG}/finance/budgets?budget=${budgetId}`;
    await page.goto(grid);
    await expect(page.getByRole("columnheader", { name: label })).toBeVisible();
    for (const [line, choice] of [
      ["1 · Stage deck rental", "Rental"],
      ["2 · Crew overtime", "Overtime"],
    ] as const) {
      const drawer = page.getByRole("dialog", { name: "Line fields" });
      await openWith(page, page.getByRole("button", { name: "Line fields" }), drawer);
      await drawer.getByLabel("Line").selectOption({ label: line });
      const fields = drawer.getByRole("region", { name: "Custom fields" });
      await fields.getByRole("button", { name: "Edit fields" }).click();
      await fields.getByLabel(label).selectOption({ label: choice });
      await fields.getByRole("button", { name: "Save fields" }).click();
      await expect(fields.getByText(choice)).toBeVisible();
      await expectAccessible(page);
      await drawer.getByRole("button", { name: "Close" }).first().click();
    }
    await page.reload();
    await expect(page.getByRole("gridcell", { name: "Rental" })).toBeVisible();

    // Add filter keeps only the Rental line; the figures stay whole-budget.
    const editor = page.getByRole("dialog", { name: "Add a filter" });
    await openWith(page, page.getByRole("button", { name: "Add filter" }), editor);
    await editor.getByLabel("Field").selectOption({ label });
    await editor.getByLabel("Condition").selectOption({ label: "is" });
    await editor.getByLabel("Value").selectOption({ label: "Rental" });
    await editor.getByRole("button", { name: "Apply filter" }).click();
    await page.waitForURL(new RegExp(`cf\\.${key}=rental`));
    await expect(
      page.getByText("Showing 1 of 3 lines. Budget figures above cover every line."),
    ).toBeVisible();
    await expect(page.getByText("Stage deck rental")).toBeVisible();
    await expect(page.getByText("Crew overtime")).toHaveCount(0);
    await expect(page.getByText("Catering")).toHaveCount(0);
    // The grid's total row is the shown line (2 x 150.00); the Total figure covers all three lines.
    await expect(page.getByText("$300.00").first()).toBeVisible();
    await expect(page.getByText("$825.00").first()).toBeVisible();
    await expectAccessible(page);

    // The filtered grid is saved as a view.
    await page.getByRole("button", { name: "Save view" }).click();
    const save = page.getByRole("dialog", { name: "Save current view" });
    await save.getByLabel("Name").fill(viewName);
    await save.getByRole("button", { name: "Save view" }).click();
    await expect(save).toHaveCount(0);

    // Clear filters restores every line.
    await page.getByRole("link", { name: "Clear filters" }).click();
    await expect(page.getByText("Catering")).toBeVisible();
    await expect(page.getByText("Crew overtime")).toBeVisible();

    // Reopening the view brings the condition back.
    const saved = page.getByRole("menuitem", { name: viewName });
    await openWith(page, page.getByRole("button", { name: /Saved views/ }), saved);
    await saved.click();
    await page.waitForURL(new RegExp(`cf\\.${key}=rental`));
    await expect(page.getByText("Catering")).toHaveCount(0);
  } finally {
    await localSql(`update app.saved_views set deleted_at = now() where name = $1`, [viewName]);
    await localSql(
      `update app.custom_field_definitions set deleted_at = now()
        where label = $1 and target_table = 'app.budget_lines' and deleted_at is null`,
      [label],
    );
    await localSql(`update app.budget_lines set deleted_at = now() where budget_id = $1`, [
      budgetId,
    ]);
    await localSql(`update app.budgets set deleted_at = now() where id = $1`, [budgetId]);
  }
});
