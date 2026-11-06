import { expect, test } from "@playwright/test";
import { DEMO_ORG, reloadUntil, runImportWorker, signInAs } from "./a36-support";
import { uniqueId } from "./support";

/**
 * B10 (RRR-234, G-132, ADR 0149 decision 5): freelancers into a pool from a file. From the Pools page, Import people with the
 * number format 1.234,56; the CSV holds a rate, a duplicate row and a bad phone, whose issues show; the import commits, the
 * invitations list on the page and no person is created. The import worker runs with the service role (runImportWorker).
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(300_000);

test("a freelancer list: map, review, commit, and the invitations appear", async ({ page }) => {
  const id = uniqueId().slice(-6).toLowerCase();
  await signInAs(page, "owner@example.com", DEMO_ORG);

  await page.goto(`/${DEMO_ORG}/opportunities/pools?create=1`);
  await page.getByLabel("Name").fill(`Freelancers ${id}`);
  await page.getByRole("button", { name: "Create pool" }).click();
  await page.getByRole("link", { name: `Freelancers ${id}` }).click();
  await page.waitForURL(/pool=/);

  await page.getByRole("link", { name: "Import people" }).click();
  await page.waitForURL(/target=pool_invitations&pool=/);
  await expect(page.getByLabel("Import into")).toHaveValue("pool_invitations");
  await page.getByLabel("Number format").selectOption("dot-comma");

  await page.getByRole("radio", { name: "Pasted rows" }).click();
  const rows = [
    "Email\tName\tPhone\tRate",
    `ana-${id}@example.com\tAna ${id}\t+13055550142\t1.250,50 €/día`,
    `ana-${id}@example.com\tAna ${id}\t+13055550142\t1.250,50 €/día`,
    `ben-${id}@example.com\tBen ${id}\t12\t`,
    `cleo-${id}@example.com\tCleo ${id}\t\t`,
  ].join("\n");
  await page.getByLabel("Rows", { exact: true }).fill(rows);
  await page
    .getByRole("button", { name: /Upload|Continue|Read/ })
    .first()
    .click();
  await page.waitForURL(/import=/);

  await runImportWorker();
  await reloadUntil(page, page.getByRole("heading", { name: /column/i }).first());
  await page
    .getByRole("button", { name: /Confirm/ })
    .first()
    .click();
  await runImportWorker();
  await reloadUntil(page, page.getByRole("heading", { name: "Row issues" }));

  // The repeat and the bad phone are Invalid; the good rows go on.
  await expect(page.getByText(/repeats|duplicate/i).first()).toBeVisible();
  await expect(page.getByText("not a phone number").first()).toBeVisible();
  await page
    .getByRole("button", { name: /Commit/ })
    .first()
    .click();
  await runImportWorker();

  await page.goto(`/${DEMO_ORG}/opportunities/pools`);
  await page.getByRole("link", { name: `Freelancers ${id}` }).click();
  const invitations = page.locator("#pool-invitations");
  await expect(invitations.getByText(`cleo-${id}@example.com`)).toBeVisible();
  await expect(invitations.getByText(`ben-${id}@example.com`)).toHaveCount(0);
  await expect(invitations.getByText("Pending").first()).toBeVisible();
});
