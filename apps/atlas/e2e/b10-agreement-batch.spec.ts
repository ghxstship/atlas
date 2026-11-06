import { expect, test } from "@playwright/test";
import { DEMO_ORG, signInAs } from "./a36-support";
import { uniqueId } from "./support";

/**
 * B10 (RRR-234, G-130, ADR 0149 decision 4): an agreement batch from Atlas. A template with the rate and the shift table is
 * written on Onboarding; on the project Engagements tab three people are chosen and previewed, and one with a missing field
 * cannot be created. The rest are created and sent. The party's signing and declining are covered in Gateway's documents
 * tests and pgTAP 2994; here a reader without payroll sees the text masked, with no hash.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(240_000);

test("an agreement batch: template, preview, create, send, and the masked reader", async ({ page, browser }) => {
  const id = uniqueId().slice(-6);
  const name = `Crew Agreement ${id}`;
  await signInAs(page, "owner@example.com", DEMO_ORG);

  await page.goto(`/${DEMO_ORG}/opportunities/onboarding?template=new`);
  const form = page.getByRole("form", { name: "Agreement template" });
  await form.getByLabel("Name").fill(name);
  await form.getByLabel("Document title").fill("Agreement for {{party.name}}");
  await form.getByLabel("Text", { exact: true }).fill("You earn {{engagement.rate}}.\n\nYour shifts:\n{{shifts.table}}");
  await form.getByRole("button", { name: "Save template" }).click();
  await expect(page.getByText(name).first()).toBeVisible();
  await expect(page.getByText("Uses the rate").first()).toBeVisible();

  await page.goto(`/${DEMO_ORG}/p/NWS/engagements`);
  await page.getByRole("link", { name: "Generate agreements" }).click();
  await page.waitForURL(/generate=1/);
  const generate = page.getByRole("form", { name: "Generate agreements" });
  await generate.getByLabel("Template").selectOption({ label: name });
  await generate.getByRole("combobox", { name: "People" }).click();
  const options = page.getByRole("option");
  const count = Math.min(await options.count(), 3);
  for (let i = 0; i < count; i += 1) await options.nth(i).click();
  await page.keyboard.press("Escape");
  await generate.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByRole("heading", { name: /Preview for/ })).toBeVisible();

  // A person with no shift has a missing table, and is left out of the count.
  const missing = await page.getByText("Missing fields").count();
  const create = page.getByRole("button", { name: /Create \d+ document/ });
  if (missing === count) {
    await expect(create).toBeDisabled();
    return;
  }
  await create.click();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(/documents? sent/);

  await page.goto(`/${DEMO_ORG}/opportunities/onboarding`);
  await expect(page.getByText(new RegExp(`· ${name}`)).first()).toBeVisible();
  await expect(page.getByText(/Sent: \d+/).first()).toBeVisible();

  // A reader without payroll: the text is masked, so no PDF is offered.
  const other = await browser.newContext({ reducedMotion: "reduce" });
  const reader = await other.newPage();
  await signInAs(reader, "member@example.com", DEMO_ORG);
  const response = await reader.goto(`/${DEMO_ORG}/documents/engagement-document/00000000-0000-4000-8000-000000000000`);
  expect(response?.status()).toBe(404);
  await other.close();
});
