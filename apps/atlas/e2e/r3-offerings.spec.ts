import { expect, test, type Locator, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { DEMO_ORG, signInAs } from "./a36-support";

/**
 * R3 (RRR-181, owner decision 7): offerings. On Settings > Gateway and marketplace the Owner sets the
 * org's parking offering and locks it, and the demo project's Offerings show it read-only; the
 * project overrides its lodging value; and an org rule for vendors is added with a cap and removed.
 * The values this journey changes are put back with the local service key afterwards, so the demo
 * project keeps the offerings its seed gave it for the Gateway journeys.
 */

const DEMO_ORG_ID = "01920000-0000-7000-8000-000000000001";
const DEMO_PROJECT_ID = "01920000-0000-7000-8000-000000001001";
const DEMO_PROJECT_KEY = "NWS";

function service(): SupabaseClient {
  const url = process.env["E2E_SUPABASE_URL"];
  const key = process.env["E2E_SUPABASE_SERVICE_KEY"];
  if (!url || !key || !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url)) {
    throw new Error("Set E2E_SUPABASE_URL and E2E_SUPABASE_SERVICE_KEY to the local stack.");
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** The settings list item that holds one labelled control. */
function field(scope: Page | Locator, label: string): Locator {
  return scope.getByRole("listitem").filter({ has: scope.getByLabel(label, { exact: true }) });
}

test.describe.configure({ mode: "serial" });

test.afterAll(async () => {
  const db = service().schema("app");
  await db
    .from("setting_values")
    .update({ deleted_at: new Date().toISOString() })
    .eq("org_id", DEMO_ORG_ID)
    .eq("setting_key", "offerings.parking")
    .eq("scope_kind", "Organization")
    .is("deleted_at", null);
  await db
    .from("setting_values")
    .update({ value_text: "provided" })
    .eq("setting_key", "offerings.lodging")
    .eq("scope_kind", "Project")
    .eq("scope_id", DEMO_PROJECT_ID)
    .is("deleted_at", null);
  await db
    .from("offering_rules")
    .update({ deleted_at: new Date().toISOString() })
    .eq("org_id", DEMO_ORG_ID)
    .eq("offering", "Carts")
    .is("deleted_at", null);
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
