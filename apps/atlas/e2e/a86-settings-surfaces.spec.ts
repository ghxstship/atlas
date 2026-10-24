import type { Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect as baseExpect, test } from "./engine-test";
import { expectAccessibleInBothThemes } from "./a16-support";
import {
  createOrganization,
  expectAccessible,
  openChoices,
  signUp,
  testEmail,
  uniqueId,
} from "./support";
import { enrollAuthenticator } from "./totp";

/**
 * A86 settings surfaces (RRR-131, finding A65-004): every settings section that rendered only an empty state now
 * shows its surface, axe clean in both themes; departments in use and location defaults save through the save bar
 * and a new venue starts from them; spend limits, custom fields and legal holds are added and removed; and, on a
 * Pro org, an Owner allows personal API tokens, creates one behind A77's step-up, sees it once and revokes it,
 * and creates a service account, an API key and a webhook endpoint. The plan change and the demo workspace are set
 * up with the local service key, as the billing service would.
 */

const expect = baseExpect.configure({ timeout: 20_000 });

function service(): SupabaseClient {
  const url = process.env["E2E_SUPABASE_URL"];
  const key = process.env["E2E_SUPABASE_SERVICE_KEY"];
  if (!url || !key || !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url)) {
    throw new Error("Set E2E_SUPABASE_URL and E2E_SUPABASE_SERVICE_KEY to the local stack.");
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function orgId(slug: string): Promise<string> {
  const { data, error } = await service()
    .schema("app")
    .from("organizations")
    .select("id")
    .eq("slug", slug)
    .single();
  expect(error).toBeNull();
  return (data as { id: string }).id;
}

const ORG_SECTIONS: readonly [string, string][] = [
  ["departments-and-disciplines", "Departments and disciplines in use"],
  ["locations-and-venues", "New venue defaults"],
  ["canon-extensions", "Your organization's extensions"],
  ["custom-fields", "Custom fields"],
  ["automations", "What runs on its own"],
  ["spend-authority", "Spend limits"],
  ["separation-of-duties", "Rules every organization keeps"],
  ["api-keys-and-service-accounts", "Service accounts"],
  ["webhooks", "Webhook endpoints"],
  ["usage", "Metered usage"],
  ["data-and-privacy", "Data requests"],
  ["audit-log", "Latest audit events"],
];

async function newOwner(page: Page, label: string) {
  const id = uniqueId();
  const slug = `${label}-${id}`;
  await signUp(page, { name: "Sasha Surfaces", email: testEmail(label, id) });
  await createOrganization(page, { name: `Surfaces ${id}`, slug });
  return { id, slug };
}

test("every settings section A86 filled shows its surface, axe clean in both themes", async ({
  page,
}) => {
  test.setTimeout(10 * 60_000);
  const { slug } = await newOwner(page, "surfaces");
  for (const [section, heading] of ORG_SECTIONS) {
    const response = await page.goto(`/${slug}/settings/${section}`);
    expect(response?.status(), section).toBe(200);
    await expect(page.getByRole("heading", { level: 2, name: heading }).first()).toBeVisible();
    await expectAccessible(page);
  }
  for (const [section, heading] of [
    ["connected-apps", "Connected apps"],
    ["payout-and-tax", "Payout details"],
  ] as const) {
    const response = await page.goto(`/${slug}/me/${section}`);
    expect(response?.status(), section).toBe(200);
    await expect(page.getByRole("heading", { level: 2, name: heading })).toBeVisible();
    await expectAccessible(page);
  }
  // Developer exists only where the org allows personal tokens (off by default).
  expect((await page.goto(`/${slug}/me/developer`))?.status()).toBe(404);

  await page.goto(`/${slug}/settings/data-and-privacy`);
  await expectAccessibleInBothThemes(page);

  // The workspace settings page (ADR 0006 amendment of 2026-10-21), and 404 for a workspace that is not the org's.
  const { error } = await service()
    .schema("app")
    .from("workspaces")
    .insert({ org_id: await orgId(slug), name: "Miami Office", slug: "miami" });
  expect(error).toBeNull();
  await page.goto(`/${slug}/settings/workspaces`);
  await page.getByRole("link", { name: "Open the Miami Office settings page" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Miami Office" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Members" })).toBeVisible();
  await expectAccessibleInBothThemes(page);
  expect((await page.goto(`/${slug}/settings/workspaces/elsewhere`))?.status()).toBe(404);
});

test("departments in use and venue defaults save through the save bar", async ({ page }) => {
  test.setTimeout(5 * 60_000);
  const { slug } = await newOwner(page, "setup");

  await page.goto(`/${slug}/settings/departments-and-disciplines`);
  const form = page.getByRole("form", { name: "Departments and disciplines in use" });
  await expect(page.getByText("None chosen yet, so every department is offered.")).toBeVisible();
  await expect(form.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  // Every department is a box, so they sit closed behind how many are chosen (gate 27).
  await expect(form.locator("summary").filter({ hasText: "Departments" })).toContainText(
    /0 of \d+ chosen/,
  );
  await openChoices(form, "Departments");
  await form.getByRole("checkbox", { name: "Production · 5000" }).check();
  await expect(form.getByText("1 unsaved change")).toBeVisible();
  await form.getByRole("button", { name: "Discard" }).click();
  await expect(form.getByRole("checkbox", { name: "Production · 5000" })).not.toBeChecked();
  await form.getByRole("checkbox", { name: "Production · 5000" }).check();
  await form.getByRole("checkbox", { name: "Operations · 6000" }).check();
  await expect(form.getByText("1 unsaved change")).toBeVisible();
  await expect(form.locator("summary").filter({ hasText: "Departments" })).toContainText("2 of");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("2 departments and 0 disciplines in use.")).toBeVisible();
  await expectAccessibleInBothThemes(page);

  await page.goto(`/${slug}/settings/locations-and-venues`);
  const defaults = page.getByRole("form", { name: "New venue defaults" });
  await defaults.getByLabel("Time zone").selectOption("Europe/London");
  await defaults.getByRole("button", { name: "Save", exact: true }).click();
  await expect(defaults.getByText("Saved.")).toBeVisible();
  await page.goto(`/${slug}/places/venues?create=1`);
  await expect(page.locator("#venue-time-zone")).toHaveValue("Europe/London");
});

test("spend limits, custom fields and legal holds are added and removed", async ({ page }) => {
  test.setTimeout(5 * 60_000);
  const { slug } = await newOwner(page, "rules");

  await page.goto(`/${slug}/settings/spend-authority`);
  const spend = page.getByRole("form", { name: "Add a limit" });
  await spend.getByLabel("Who").selectOption({ label: "Everyone with the Manager role" });
  await spend.getByLabel("Document type").selectOption({ label: "Purchase order" });
  await spend.getByLabel("Currency").selectOption("USD");
  await spend.getByLabel("Limit", { exact: true }).fill("2500");
  await spend.getByRole("button", { name: "Add limit" }).click();
  await expect(page.getByText("Up to $2,500.00")).toBeVisible();
  await expectAccessible(page);

  await page.goto(`/${slug}/settings/custom-fields`);
  const field = page.getByRole("form", { name: "Add a field" });
  await field.getByLabel("Records").selectOption({ label: "Projects" });
  await field.getByLabel("Label").fill("Dock door");
  await field.getByRole("button", { name: "Add field" }).click();
  const row = page.getByRole("listitem").filter({ hasText: "Dock door" });
  await expect(row.getByText("dock_door")).toBeVisible();
  await row.getByRole("button", { name: "Remove" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove field" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: "Dock door" })).toHaveCount(0);

  await page.goto(`/${slug}/settings/data-and-privacy`);
  const hold = page.getByRole("form", { name: "Place a legal hold" });
  await hold.getByLabel("Matter").fill("Smith v. Surfaces");
  await hold.getByRole("button", { name: "Place hold" }).click();
  const held = page.getByRole("listitem").filter({ hasText: "Smith v. Surfaces" });
  await expect(held.getByText("In force")).toBeVisible();
  await held.getByRole("button", { name: "Release" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Release" }).click();
  await expect(held.getByText("Released", { exact: true })).toBeVisible();
});

test("a Pro org allows personal tokens; one is created behind step-up, shown once and revoked", async ({
  page,
}) => {
  test.setTimeout(6 * 60_000);
  const { slug } = await newOwner(page, "tokens");
  const { error } = await service()
    .schema("app")
    .from("subscriptions")
    .update({ plan_code: "pro" })
    .eq("org_id", await orgId(slug))
    .is("deleted_at", null);
  expect(error).toBeNull();

  await page.goto(`/${slug}/settings/api-keys-and-service-accounts`);
  const settings = page.getByRole("form", { name: "Settings on this page" });
  await settings.getByLabel("Allow personal API tokens").check();
  await settings.getByRole("button", { name: "Save", exact: true }).click();
  await expect(settings.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);

  await page.goto(`/${slug}/me/developer`);
  const tokenForm = page.getByRole("form", { name: "Create a token" });
  await tokenForm.getByLabel("Name").fill("Laptop scripts");
  await openChoices(tokenForm, "Areas it may use");
  await tokenForm.getByRole("checkbox", { name: "work", exact: true }).check();
  await tokenForm.getByRole("button", { name: "Create token" }).click();
  // No second factor yet: the step-up dialog sets one up, and verifying it submits the form again.
  const dialog = page.getByRole("dialog", { name: "Set up a second factor" });
  await expect(dialog).toBeVisible();
  await enrollAuthenticator(dialog);
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Copy this token now")).toBeVisible();
  await expect(page.getByLabel("Personal API token", { exact: true })).toHaveValue(
    /^xos_pat_[0-9a-f]{48}$/,
  );
  await expectAccessible(page);
  const token = page.getByRole("listitem").filter({ hasText: "Laptop scripts" });
  await token.getByRole("button", { name: "Revoke" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Revoke token" }).click();
  await expect(token.getByText("Revoked", { exact: true })).toBeVisible();

  await page.goto(`/${slug}/settings/api-keys-and-service-accounts`);
  const account = page.getByRole("form", { name: "Add a service account" });
  await account.getByLabel("Name").fill("Accounting sync");
  await account.getByLabel("Role").selectOption({ label: "Manager" });
  await account.getByRole("button", { name: "Add service account" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: "Accounting sync" })).toBeVisible();
  const key = page.getByRole("form", { name: "Create an API key" });
  await key.getByLabel("Name").fill("Ledger export");
  await openChoices(key, "Areas it may use");
  await key.getByRole("checkbox", { name: "finance", exact: true }).check();
  await key.getByRole("button", { name: "Create key" }).click();
  await expect(page.getByLabel("API key", { exact: true })).toHaveValue(/^xos_live_[0-9a-f]{48}$/);
  await expectAccessibleInBothThemes(page);

  await page.goto(`/${slug}/settings/webhooks`);
  const hook = page.getByRole("form", { name: "Add an endpoint" });
  await hook.getByLabel("Endpoint URL").fill("https://hooks.example.com/xos");
  await openChoices(hook, "Events");
  await hook.getByRole("checkbox").first().check();
  await hook.getByRole("button", { name: "Add endpoint" }).click();
  await expect(page.getByLabel("Signing secret", { exact: true })).toHaveValue(
    /^whsec_[0-9a-f]{64}$/,
  );
  await expect(page.getByText("https://hooks.example.com/xos")).toBeVisible();
  await expectAccessible(page);
});
