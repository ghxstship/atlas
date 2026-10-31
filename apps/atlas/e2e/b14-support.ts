import { expect, settle, type Page } from "./engine-test";
import { createOrganization, signUp, testEmail, uniqueId } from "./support";

/** Shared steps of the B14 journeys (RRR-238): a new owner, event types, document types and gates on the local stack. */

export async function newOwnerOrg(page: Page, prefix: string, name: string): Promise<string> {
  const id = uniqueId();
  const slug = `${prefix}-${id}`;
  await signUp(page, { name, email: testEmail("owner", id) });
  await createOrganization(page, { name: `${name} ${id}`, slug });
  return slug;
}

/** Adds a project custom field in Settings, Custom fields. */
export async function addProjectField(
  page: Page,
  slug: string,
  label: string,
  type: string,
): Promise<void> {
  await page.goto(`/${slug}/settings/custom-fields`);
  const form = page.getByRole("form", { name: "Add a field" });
  await form.getByLabel("Records").selectOption({ label: "Projects" });
  await form.getByLabel("Label").fill(label);
  await form.getByLabel("Type").selectOption({ label: type });
  await form.getByRole("button", { name: "Add field" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: label }).first()).toBeVisible();
}

/** Adds an event type and a document type in Settings, Templates. */
export async function addEventType(page: Page, slug: string, name: string): Promise<void> {
  await page.goto(`/${slug}/settings/templates`);
  const form = page.getByRole("form", { name: "Add an event type" });
  await form.getByLabel("Name").fill(name);
  await form.getByLabel("Description").fill("Outdoor multi-stage weekends.");
  await form
    .getByLabel("Intake guidance")
    .fill("Have the site plan and the licensed capacity ready.");
  await form.getByRole("button", { name: "Add event type" }).click();
  await expect(page.getByRole("list", { name: "Event types" }).getByText(name)).toBeVisible();
}

export async function addDocumentType(page: Page, slug: string, name: string): Promise<void> {
  await page.goto(`/${slug}/settings/templates`);
  const form = page.getByRole("form", { name: "Add a document type" });
  await form.getByLabel("Name").fill(name);
  await form.getByRole("button", { name: "Add document type" }).click();
  await expect(page.getByRole("list", { name: "Document types" }).getByText(name)).toBeVisible();
}

/** Opens an event type's editor disclosure in Settings, Templates. */
export async function openEventType(page: Page, slug: string, name: string) {
  await page.goto(`/${slug}/settings/templates`);
  await settle(page);
  const row = page
    .getByRole("list", { name: "Event types" })
    .getByRole("listitem")
    .filter({ hasText: name })
    .first();
  await row.getByText(`Edit ${name}`).click();
  return row;
}

/** Signs off every blocking criterion of a gate, as journey 2 does. */
export async function clearGate(page: Page, gate: number): Promise<void> {
  const section = page.locator(`section[aria-labelledby="gate-${gate}"]`);
  const ids = (
    await section
      .locator("li")
      .filter({ hasText: "Blocking" })
      .locator(".font-mono")
      .allTextContents()
  )
    .map((s) => s.trim())
    .filter((s) => s.startsWith(`G${gate}.`));
  for (const criterion of ids) {
    await page
      .locator("li")
      .filter({ has: page.locator(".font-mono", { hasText: criterion }) })
      .last()
      .getByRole("button", { name: /^Attest evidence for / })
      .click();
    const dialog = page.getByRole("dialog", { name: /^Attest evidence for / });
    await dialog
      .getByLabel("Document link or record key")
      .fill(`https://docs.example.com/${criterion.toLowerCase().replace(/[._]/g, "-")}.pdf`);
    await dialog.getByLabel("What it shows").fill("Signed off by the accountable party.");
    await dialog.getByRole("button", { name: "Attest" }).click();
    await expect(dialog).toBeHidden();
  }
}
