import { expect, test, type Locator, type Page } from "@playwright/test";
import pg from "pg";
import { DEMO_ORG, signInAs } from "./a36-support";

/**
 * R3 (RRR-181, owner decision 7): offerings. On Settings > Gateway and marketplace the Owner sets the
 * org's parking offering and locks it, and the demo project's Offerings show it read-only; the
 * project overrides its lodging value; and an org rule for vendors is added with a cap and removed.
 * The values this journey changes are put back afterwards as postgres on the local stack, so the
 * demo project keeps the offerings its seed gave it for the Gateway journeys.
 */

const DEMO_ORG_ID = "01920000-0000-7000-8000-000000000001";
const DEMO_PROJECT_ID = "01920000-0000-7000-8000-000000001001";
const DEMO_PROJECT_KEY = "NWS";

/** One statement as postgres against the local stack only (E2E_DATABASE_URL). */
async function localSql(text: string, args: unknown[] = []): Promise<void> {
  const url =
    process.env["E2E_DATABASE_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:55422/postgres";
  if (!/@(127\.0\.0\.1|localhost):/.test(url)) {
    throw new Error("The offerings journey cleans up only a local Supabase stack.");
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(text, args);
  } finally {
    await client.end();
  }
}

/** The settings list item that holds one labelled control; `has` is matched inside each item. */
function field(scope: Page | Locator, label: string): Locator {
  const page = "page" in scope ? scope.page() : scope;
  return scope.getByRole("listitem").filter({ has: page.getByLabel(label, { exact: true }) });
}

test.describe.configure({ mode: "serial" });

test.afterAll(async () => {
  await localSql(
    `update app.setting_values set deleted_at = now()
      where org_id = $1 and setting_key = 'offerings.parking' and scope_kind = 'Organization' and deleted_at is null`,
    [DEMO_ORG_ID],
  );
  await localSql(
    `update app.setting_values set value_text = 'provided'
      where setting_key = 'offerings.lodging' and scope_kind = 'Project' and scope_id = $1 and deleted_at is null`,
    [DEMO_PROJECT_ID],
  );
  await localSql(
    `update app.offering_rules set deleted_at = now()
      where org_id = $1 and offering = 'Carts' and deleted_at is null`,
    [DEMO_ORG_ID],
  );
});

test("an org value locked on Gateway and marketplace is read-only on the project", async ({
  page,
}) => {
  await signInAs(page, "owner@example.com", DEMO_ORG);
  await page.goto(`/${DEMO_ORG}/settings/gateway-and-marketplace`);
  const parking = field(page, "Parking");
  await expect(
    parking.getByText("Platform default. Saving sets it for the organization."),
  ).toBeVisible();
  await page.getByLabel("Parking", { exact: true }).selectOption({ label: "Provided" });
  await parking.getByRole("button", { name: "Lock value" }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    parking.getByText("Set and locked for the organization; lower levels cannot change it."),
  ).toBeVisible();

  await page.goto(`/${DEMO_ORG}/p/${DEMO_PROJECT_KEY}/settings`);
  const offerings = page.getByTestId("project-offerings");
  await expect(offerings.getByLabel("Parking", { exact: true })).toBeDisabled();
  await expect(
    field(offerings, "Parking").getByText(
      "Set and locked for the organization; lower levels cannot change it.",
    ),
  ).toBeVisible();
});

test("a project overrides an unlocked offering", async ({ page }) => {
  await signInAs(page, "owner@example.com", DEMO_ORG);
  await page.goto(`/${DEMO_ORG}/p/${DEMO_PROJECT_KEY}/settings`);
  const offerings = page.getByTestId("project-offerings");
  await offerings.getByLabel("Lodging", { exact: true }).selectOption({ label: "Reimbursed" });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(offerings.getByText("Saved.")).toBeVisible();
  await page.reload();
  await expect(
    page.getByTestId("project-offerings").getByLabel("Lodging", { exact: true }),
  ).toHaveValue("reimbursed");
  await expect(
    field(page.getByTestId("project-offerings"), "Lodging").getByText("Set for this project."),
  ).toBeVisible();
});

test("an org rule for vendors is added with a cap and removed", async ({ page }) => {
  await signInAs(page, "owner@example.com", DEMO_ORG);
  await page.goto(`/${DEMO_ORG}/settings/gateway-and-marketplace`);
  const panel = page.getByTestId("org-offering-rules");
  const form = panel.getByRole("form", { name: "Add rule" });
  await form.getByLabel("Offering").selectOption({ label: "Carts" });
  await form.getByLabel("Role type").selectOption({ label: "Vendor" });
  await form.getByLabel("Mode").selectOption({ label: "Provided" });
  await form.getByLabel("Cap per engagement").fill("4");
  await form.getByRole("button", { name: "Add rule" }).click();
  await expect(form.getByText("Rule added.")).toBeVisible();
  const row = panel.getByRole("row").filter({ hasText: "Carts" });
  await expect(row).toContainText("Vendor");
  await expect(row).toContainText("4");
  await row.getByRole("button", { name: "Remove: Carts, Vendor, Every vendor class" }).click();
  await expect(panel.getByRole("row").filter({ hasText: "Carts" })).toHaveCount(0);
});
