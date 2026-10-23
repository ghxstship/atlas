import type { Page } from "@playwright/test";
import { expect as baseExpect, test } from "./engine-test";
import { DEMO_VENDOR_ACCOUNT } from "./fixtures";
import { expectAccessible, sql, signIn } from "./support";

/**
 * A86 settings surfaces in Gateway (RRR-131, finding A65-004): the sections that only pointed elsewhere now hold
 * content. The vendor contact, acting for the demo vendor account, adds and removes a service region, saves the
 * company's notification defaults (1434) and sees its Account Owners on Danger Zone; Connected Apps lists the
 * person's own grants; Developer stays out of reach while no org they belong to allows personal tokens.
 */
test.setTimeout(180_000);
const expect = baseExpect.configure({ timeout: 20_000 });
const VENDOR_ACCOUNT = DEMO_VENDOR_ACCOUNT;

/** Signs in as the vendor contact acting for the company account, as the account menu does (the cookie names it). */
async function actAsCompany(page: Page, path: string) {
  await signIn(page, "vendor@example.com", "/home");
  await page.context().addCookies([{ name: "xos-acting", value: VENDOR_ACCOUNT, url: page.url() }]);
  await page.goto(path);
}

test.afterEach(async () => {
  await sql(
    `update app.organization_service_regions set deleted_at = now() where org_id = $1 and deleted_at is null`,
    [VENDOR_ACCOUNT],
  );
  await sql(
    `update app.account_notification_defaults set deleted_at = now() where org_id = $1 and deleted_at is null`,
    [VENDOR_ACCOUNT],
  );
});

test("company regions, notification defaults and danger zone hold content", async ({ page }) => {
  await actAsCompany(page, "/settings/company/service-regions-and-capabilities");
  await expect(page.getByRole("heading", { name: "Service regions", exact: true })).toBeVisible();
  await expect(page.getByText("No service regions yet.")).toBeVisible();
  const region = page.getByRole("form", { name: "Add region" });
  await region.getByLabel("Jurisdiction").selectOption("US-FL");
  await region.getByRole("button", { name: "Add region" }).click();
  const row = page.getByRole("listitem").filter({ hasText: "US-FL" }).first();
  await expect(row).toBeVisible();
  await expectAccessible(page);
  await row.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("No service regions yet.")).toBeVisible();

  await page.goto("/settings/company/notifications");
  const defaults = page
    .getByRole("form")
    .filter({ has: page.getByRole("checkbox", { name: "Email" }) });
  await defaults.getByRole("checkbox", { name: "Email" }).uncheck();
  await defaults.getByRole("button", { name: "Save defaults" }).click();
  await expect(page.getByText("Defaults saved.")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "Email" })).not.toBeChecked();
  await expectAccessible(page);

  await page.goto("/settings/company/danger-zone");
  await expect(page.getByRole("heading", { name: "Account Owners", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Close the company account" })).toBeVisible();
  await expectAccessible(page);
});

test("connected apps list the person's own grants; Developer needs an org that allows tokens", async ({
  page,
}) => {
  await signIn(page, "vendor@example.com", "/settings/connected-apps");
  await expect(page.getByText("You have not connected any apps.")).toBeVisible();
  await expectAccessible(page);
  expect((await page.goto("/settings/developer"))?.status()).toBe(404);
});
