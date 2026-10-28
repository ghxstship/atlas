import pg from "pg";
import { ORG, signIn } from "./a16-support";
import { expect, settle, test } from "./engine-test";
import { expectAccessible } from "./support";

/**
 * A136 (RRR-199), Section 4.5.6 item 27: the demo Owner keeps a question template and the opportunity defaults in
 * Settings, Gateway and Marketplace, then creates a posting. The create form starts from the defaults and the
 * template, and the saved draft holds the template's questions as its own. The defaults and the template are removed
 * again afterwards, so other journeys start from blank forms.
 */
test.use({ reducedMotion: "reduce" });

const SETTINGS = `/${ORG}/settings/gateway-and-marketplace`;

/** Runs SQL on the local stack only, as postgres, to remove what the journey made. */
async function localSql(text: string, args: unknown[]): Promise<void> {
  const url =
    process.env["E2E_DATABASE_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:55422/postgres";
  if (!/@(127\.0\.0\.1|localhost):/.test(url))
    throw new Error("Set E2E_DATABASE_URL to the local stack.");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(text, args);
  } finally {
    await client.end();
  }
}

test("a question template and the opportunity defaults start a new posting", async ({ page }) => {
  test.setTimeout(5 * 60_000);
  const stamp = Date.now().toString(36).toUpperCase();
  const templateName = `Crew Call Basics ${stamp}`;
  await signIn(page);

  try {
    await page.goto(SETTINGS);
    const panel = page.getByTestId("opportunity-start");
    await expect(panel.getByRole("heading", { name: "How new opportunities start" })).toBeVisible();
    await expect(panel.getByRole("link", { name: "Manage pools" })).toBeVisible();
    await expect(panel.getByRole("link", { name: "Manage onboarding requirements" })).toBeVisible();
    await expectAccessible(page);
    await settle(page);

    const create = page.getByRole("form", { name: "New question template" });
    await create.getByLabel("Name", { exact: true }).fill(templateName);
    await create.getByRole("button", { name: "Create template" }).click();
    await expect(create.getByRole("status")).toContainText("Template created");

    const template = page.getByRole("listitem", { name: templateName });
    await template
      .getByLabel("Question", { exact: true })
      .fill("Do you hold a current rigging certification?");
    await template.getByLabel("Required").check();
    await template.getByRole("button", { name: "Add question" }).click();
    await expect(template.getByText("Do you hold a current rigging certification?")).toBeVisible();
    await template.getByLabel("Question", { exact: true }).fill("Which shifts can you work?");
    await template.getByRole("button", { name: "Add question" }).click();
    await expect(template.getByText("Which shifts can you work?")).toBeVisible();

    const defaults = page.getByRole("form", { name: "Defaults for new postings" });
    await defaults.getByLabel("Visibility").selectOption("Pool");
    await defaults.getByLabel("Pay basis").selectOption("Day");
    await defaults.getByLabel("Currency").fill("USD");
    await defaults.getByLabel("Application window in days").fill("14");
    await defaults.getByLabel("Question template").selectOption({ label: templateName });
    await defaults.getByRole("button", { name: "Save defaults" }).click();
    await expect(defaults.getByRole("status")).toContainText("Defaults saved");

    // The create form starts from the defaults and the template; each stays editable.
    await page.goto(`/${ORG}/opportunities/postings?create=1`);
    await expect(page.getByLabel("Visibility")).toHaveValue("Pool");
    await expect(page.getByLabel("Rate type")).toHaveValue("Day");
    await expect(page.getByLabel("Currency")).toHaveValue("USD");
    await expect(page.getByLabel("Application deadline")).not.toHaveValue("");
    const chosen = page.getByLabel("Question template");
    const templateId = await chosen
      .locator("option", { hasText: templateName })
      .getAttribute("value");
    expect(templateId).toBeTruthy();
    await expect(chosen).toHaveValue(templateId ?? "");
    await expectAccessible(page);
    await settle(page);

    const title = `Festival Riggers ${stamp}`;
    await page.getByLabel("Title", { exact: true }).fill(title);
    await page.getByLabel("Lowest pay").fill("900.00");
    await page.getByLabel("Highest pay").fill("950.00");
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Draft saved" })).toBeVisible();

    await page.goto(`/${ORG}/opportunities/postings`);
    await page.getByRole("link", { name: title }).click();
    await page.waitForURL(/postings\?.*id=/);
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expect(page.getByText("Pool", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Do you hold a current rigging certification?")).toBeVisible();
    await expect(page.getByText("Which shifts can you work?")).toBeVisible();
  } finally {
    await localSql(
      `delete from app.opportunity_defaults
        where org_id = (select id from app.organizations where slug = $1)`,
      [ORG],
    );
    await localSql(
      `update app.application_question_templates set deleted_at = now()
        where name = $1 and deleted_at is null`,
      [templateName],
    );
  }
});
