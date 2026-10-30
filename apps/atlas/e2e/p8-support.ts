import type { Page } from "./engine-test";
import { expect } from "./engine-test";
import { createOrganization, signUp, testEmail, uniqueId } from "./support";

/**
 * Shared steps of P8's journeys (RRR-222): a new Owner in a new org with one project on the local stack, Tasks with
 * or without a due time, and a record's due time as its edit form shows it. Each run makes its own org, so runs never
 * collide on the shared stack.
 */

export async function newOwnerOrg(page: Page, prefix: string, name: string): Promise<string> {
  const id = uniqueId();
  const slug = `${prefix}-${id}`;
  await signUp(page, { name, email: testEmail(prefix, id) });
  await createOrganization(page, { name: `P8 ${id}`, slug });
  return slug;
}

export async function createProject(page: Page, slug: string, key: string, name: string) {
  await page.goto(`/${slug}/projects/all`);
  await page.getByRole("button", { name: "New project" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await dialog.getByLabel("Project key").fill(key);
  await dialog.getByLabel("Project name").fill(name);
  await dialog.getByRole("button", { name: "More fields" }).click();
  await dialog.getByLabel("Jurisdiction").selectOption("US-FL-MIAMI-DADE");
  await dialog.getByLabel("Tier of experience").selectOption({ index: 5 });
  await dialog.getByLabel("First production day").fill("2027-03-12");
  await dialog.getByLabel("Last production day").fill("2027-03-15");
  await dialog.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(`**/${slug}/p/${key}/overview`);
}

/** A Task in the org's only project; without `due` it has no dates. Returns its key. */
export async function createTask(
  page: Page,
  slug: string,
  title: string,
  due?: string,
): Promise<string> {
  await page.goto(`/${slug}/work/all-records?create=1`);
  const sheet = page.getByRole("dialog", { name: "New record" });
  await expect(sheet).toBeVisible();
  await sheet.getByLabel("Kind").selectOption("Task");
  await sheet.getByLabel("Subtype").selectOption("Execute");
  await sheet.getByLabel("Title").fill(title);
  if (due) await sheet.getByLabel("Due").fill(due);
  await sheet.getByRole("button", { name: "Create record" }).click();
  await page.waitForURL(/peek=/);
  return new URL(page.url()).searchParams.get("peek") ?? "";
}

/** Makes `successor` depend on `predecessor`, Finish to Start, from the successor's page. */
export async function addDependency(
  page: Page,
  slug: string,
  successor: string,
  predecessor: string,
  predecessorTitle: string,
) {
  await page.goto(`/${slug}/r/${successor}`);
  await page
    .getByLabel("Add a predecessor")
    .selectOption({ label: `${predecessor} ${predecessorTitle}` });
  await page.getByRole("button", { name: "Add dependency" }).click();
  await expect(page.getByRole("region", { name: "Dependencies" })).toContainText(
    `${predecessor} ${predecessorTitle}`,
  );
}

/** The record's due time as its edit form shows it, on the project's calendar. */
export async function dueOf(page: Page, slug: string, key: string): Promise<string> {
  await page.goto(`/${slug}/r/${key}`);
  await page
    .getByRole("form", { name: "Edit record" })
    .getByRole("button", { name: "More fields" })
    .click();
  return page.getByLabel("Due", { exact: true }).inputValue();
}
