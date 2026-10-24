import pg from "pg";
import type { Page } from "@playwright/test";
import { expect as baseExpect, test } from "./engine-test";
import { createOrganization, expectAccessible, signUp, testEmail, uniqueId } from "./support";

/**
 * A107 (RRR-152, S16-07, ADR 0060): after a trial ends on the Access plan, the projects past its limit of one active
 * project are read-only, with an explanation on Projects, on every page of a read-only project and in the Owner's
 * org banner; an edit is refused with the same explanation; the Owner keeps another project writable in Settings,
 * Billing and Plan; and upgrading restores them all. The trial ends and the upgrade lands through the database
 * functions the hourly job and the Stripe webhook call, as postgres against the local stack only (E2E_DATABASE_URL).
 */

const databaseUrl =
  process.env["E2E_DATABASE_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:55422/postgres";
if (!/@(127\.0\.0\.1|localhost):/.test(databaseUrl)) {
  throw new Error("The A107 journey touches only a local Supabase stack.");
}

async function sql(text: string, params: unknown[] = []): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(text, params);
  } finally {
    await client.end();
  }
}

/** Each step is a server action that recomputes and renders the banners again; on a loaded machine that takes a while. */
const expect = baseExpect.configure({ timeout: 30_000 });

async function createProject(page: Page, slug: string, key: string, name: string) {
  await page.goto(`/${slug}/projects/all`);
  await page.getByRole("button", { name: "New project" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await dialog.getByLabel("Project key").fill(key);
  await dialog.getByLabel("Project name").fill(name);
  await dialog.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(`**/${slug}/p/${key}/overview`);
}

test("after the trial ends on Access, projects past the limit are read-only with an explanation, and upgrading restores them", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const id = uniqueId();
  const slug = `limits-${id}`;
  await signUp(page, { name: "Lena Limits", email: testEmail("limits", id) });
  await createOrganization(page, { name: `Limit Co ${id}`, slug });
  await createProject(page, slug, "LMA", "Spring Tour");
  await createProject(page, slug, "LMB", "Summer Fair");
  await createProject(page, slug, "LMC", "Winter Gala");
  await expect(page.getByTestId("project-read-only-banner")).toHaveCount(0);

  // The hourly job ends this org's trial: it moves to the Access plan in place, and nothing is deleted.
  await sql(
    `select private.expire_trial(s.id) from app.subscriptions s join app.organizations o on o.id = s.org_id
      where o.slug = $1 and s.subscription_state = 'trialing'`,
    [slug],
  );

  await page.goto(`/${slug}/projects/all`);
  await expect(page.getByTestId("limit-banner-active_projects")).toContainText(
    "2 projects are read-only: the Access plan allows 1 active project. Nothing is deleted.",
  );
  await expect(page.getByTestId("over-limit-banner")).toContainText(
    "The organization is over the Access plan's limits, so 2 projects are read-only.",
  );
  await expect(page.getByText("Summer Fair")).toBeVisible();
  await expect(page.getByText("Winter Gala")).toBeVisible();
  await expectAccessible(page);

  // The oldest project stays writable; the newer two say why they are read-only, and refuse an edit.
  await page.goto(`/${slug}/p/LMA/overview`);
  await expect(page.getByText("Spring Tour").first()).toBeVisible();
  await expect(page.getByTestId("project-read-only-banner")).toHaveCount(0);
  await page.goto(`/${slug}/p/LMB/settings`);
  const banner = page.getByTestId("project-read-only-banner");
  await expect(banner).toContainText(
    "This project is read-only: the Access plan allows 1 active project, and the organization has more.",
  );
  await expect(
    banner.getByRole("link", { name: "Choose what stays writable, or upgrade" }),
  ).toBeVisible();
  await expectAccessible(page);
  await page.getByLabel("Project name").fill("Summer Fair 2027");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page.getByText(
      "This project is read-only because the organization is over its plan's active project limit.",
    ),
  ).toBeVisible();

  // The Owner keeps the newest project writable instead of the oldest.
  await banner.getByRole("link", { name: "Choose what stays writable, or upgrade" }).click();
  await page.waitForURL(`**/${slug}/settings/billing-and-plan#plan-limits`);
  const panel = page.getByTestId("plan-limits-panel");
  await expect(panel.getByRole("heading", { name: "What stays writable" })).toBeVisible();
  await expect(panel).toContainText("3 of 1");
  const form = panel.getByTestId("plan-limit-form-active_projects");
  await form.getByLabel("Spring Tour (LMA)").uncheck();
  await form.getByLabel("Winter Gala (LMC)").check();
  await form.getByRole("button", { name: "Keep these writable" }).click();
  await expect(form.getByText("Saved. 2 stay read-only.")).toBeVisible();
  await expectAccessible(page);
  await page.goto(`/${slug}/p/LMC/overview`);
  await expect(page.getByTestId("project-read-only-banner")).toHaveCount(0);
  await page.goto(`/${slug}/p/LMA/overview`);
  await expect(page.getByTestId("project-read-only-banner")).toBeVisible();

  // Upgrading restores every project at once; Stripe's webhook would make the same call.
  await sql(
    `select app.sync_subscription_from_stripe(o.id, $2, $3, 'core', 'Monthly', 'active', now() + interval '30 days', false)
       from app.organizations o where o.slug = $1`,
    [slug, `cus_${["Limits", id].join("")}`, `sub_${["Limits", id].join("")}`],
  );
  await page.goto(`/${slug}/p/LMB/settings`);
  await expect(page.getByTestId("project-read-only-banner")).toHaveCount(0);
  await expect(page.getByTestId("over-limit-banner")).toHaveCount(0);
  await page.getByLabel("Project name").fill("Summer Fair 2027");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
});
