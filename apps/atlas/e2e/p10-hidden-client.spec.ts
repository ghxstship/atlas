import pg from "pg";
import { ORG, signIn } from "./a16-support";
import { expect, settle, test } from "./engine-test";
import { expectAccessible } from "./support";

/**
 * P10 (RRR-224, gap G-128), Section 4.4.3 and Section 4.5.6 item 27: the demo Owner sets new postings to start with
 * the client and event hidden until booking, then creates one. The New posting form starts with the box ticked, a
 * title naming the project is refused on the title field, and the saved draft carries the Client hidden until booked
 * tag in the list and on its record. The defaults and the draft are removed again afterwards.
 */
test.use({ reducedMotion: "reduce" });

const SETTINGS = `/${ORG}/settings/gateway-and-marketplace`;
const LABEL = "Hide client and event until booked";

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

test("a posting starts with the client hidden and cannot name the project", async ({ page }) => {
  test.setTimeout(5 * 60_000);
  const stamp = Date.now().toString(36).toUpperCase();
  const title = `Confidential Riggers ${stamp}`;
  await signIn(page);

  try {
    await page.goto(SETTINGS);
    const defaults = page.getByRole("form", { name: "Defaults for new postings" });
    await defaults.getByLabel(LABEL).check();
    await defaults.getByRole("button", { name: "Save defaults" }).click();
    await expect(defaults.getByRole("status")).toContainText("Defaults saved");

    await page.goto(`/${ORG}/opportunities/postings?create=1`);
    const box = page.getByLabel(LABEL);
    await expect(box).toBeChecked();
    await expect(
      page.getByText("Crew see your organization, the city, the dates and the pay."),
    ).toBeVisible();
    await expectAccessible(page);
    await settle(page);

    // The project chosen is the first one; its name in the title is refused while the client is hidden.
    const project = page.getByLabel("Project");
    const option = await project.locator("option:checked").textContent();
    const projectName = (option ?? "").split(" · ").slice(1).join(" · ").trim();
    expect(projectName.length).toBeGreaterThan(3);
    await page.getByLabel("Title", { exact: true }).fill(`Riggers for ${projectName}`);
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(
      page.getByText(
        "While the client and event are hidden, remove the project, client and venue names from the title and description.",
      ),
    ).toHaveCount(2);
    await expect(page.getByLabel(LABEL)).toBeChecked();

    await page.getByLabel("Title", { exact: true }).fill(title);
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Draft saved" })).toBeVisible();

    await page.goto(`/${ORG}/opportunities/postings`);
    const row = page.getByRole("listitem").filter({ hasText: title });
    await expect(row.getByText("Client hidden until booked")).toBeVisible();
    await row.getByRole("link", { name: title }).click();
    await page.waitForURL(/postings\?.*id=/);
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expect(page.getByText("Client hidden until booked").first()).toBeVisible();
    const edit = page.getByRole("form", { name: "Edit draft" });
    await expect(edit.getByLabel(LABEL)).toBeChecked();
    await expectAccessible(page);
  } finally {
    await localSql(
      `delete from app.opportunity_defaults
        where org_id = (select id from app.organizations where slug = $1)`,
      [ORG],
    );
    await localSql(
      `update app.opportunities set deleted_at = now() where title = $1 and deleted_at is null`,
      [title],
    );
  }
});
