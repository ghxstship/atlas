import { expect, type Page } from "./engine-test";
import { createOrganization, signUp, testEmail, uniqueId } from "./support";

/** Shared steps of the B4 journeys (RRR-228): a new owner, a project and records on the local stack. */

export async function newOwnerOrg(page: Page, prefix: string, name: string): Promise<string> {
  const id = uniqueId();
  const slug = `${prefix}-${id}`;
  await signUp(page, { name, email: testEmail("owner", id) });
  await createOrganization(page, { name: `${name} ${id}`, slug });
  return slug;
}

export async function createProject(
  page: Page,
  slug: string,
  input: { key: string; name: string; from: string; to: string },
): Promise<void> {
  await page.goto(`/${slug}/projects/all`);
  await page.getByRole("button", { name: "New project" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await dialog.getByLabel("Project key").fill(input.key);
  await dialog.getByLabel("Project name").fill(input.name);
  await dialog.getByRole("button", { name: "More fields" }).click();
  await dialog.getByLabel("Jurisdiction").selectOption("US-FL-MIAMI-DADE");
  await dialog.getByLabel("Tier of experience").selectOption({ index: 5 });
  await dialog.getByLabel("First production day").fill(input.from);
  await dialog.getByLabel("Last production day").fill(input.to);
  await dialog.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(`**/${slug}/p/${input.key}/overview`);
}

/** Creates a Task due at a local time and returns its key. */
export async function createTask(
  page: Page,
  slug: string,
  title: string,
  due: string,
): Promise<string> {
  await page.goto(`/${slug}/work/all-records?create=1`);
  const sheet = page.getByRole("dialog", { name: "New record" });
  await expect(sheet).toBeVisible();
  await sheet.getByLabel("Kind").selectOption("Task");
  await sheet.getByLabel("Subtype").selectOption("Execute");
  await sheet.getByLabel("Title").fill(title);
  await sheet.getByLabel("Due").fill(due);
  await sheet.getByRole("button", { name: "Create record" }).click();
  await page.waitForURL(/peek=/);
  return new URL(page.url()).searchParams.get("peek") ?? "";
}

/** Adds one day type on a date through Schedule, Days. */
export async function addDay(page: Page, slug: string, date: string, type: string): Promise<void> {
  await page.goto(`/${slug}/schedule/days`);
  await page.getByRole("button", { name: "Add day" }).first().click();
  const drawer = page.getByRole("dialog", { name: "Add a day" });
  await expect(drawer).toBeVisible();
  await drawer.getByLabel("Date").fill(date);
  await drawer.getByLabel("Day type").first().selectOption(type);
  await drawer.getByRole("button", { name: "Save day" }).click();
  await expect(drawer).toBeHidden();
}
