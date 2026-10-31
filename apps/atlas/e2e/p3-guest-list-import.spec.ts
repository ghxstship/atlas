import { expect, test, type Browser, type Page } from "@playwright/test";
import { expectAccessibleInBothThemes } from "./a16-support";
import { DEMO_ORG, reloadUntil, runImportWorker, signInAs } from "./a36-support";
import { describe, hardCodedText } from "./pseudo-checks";
import { uniqueId } from "./support";

/**
 * P3 (RRR-217, gap G-72, Section 4.6.2): import a guest list into a project. The Field lead, who holds the
 * capability but not the import page, sees no Import guests link. From the project's guest list, Import guests opens
 * the wizard on that project; a .csv with one exact duplicate (updated, never added twice) and one near duplicate
 * (merge review, kept separate) is committed by one person. A second person approves the new guests in bulk; the
 * first person's approve is refused, since neither the uploader nor the committer decides them.
 */

test.use({ reducedMotion: "reduce" });
test.setTimeout(240_000);

async function asPerson(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext({ reducedMotion: "reduce" })).newPage();
  await signInAs(page, email, DEMO_ORG);
  return page;
}

test("guest list import: an exact and a near duplicate, commit, and approval by someone else", async ({
  browser,
}) => {
  const id = uniqueId();
  const existing = `Jordan Vale ${id}`;
  const fresh = `Morgan Lee ${id}`;

  // A guest already on the list, requested by the Owner.
  const owner = await asPerson(browser, "owner@example.com");
  await owner.goto(`/${DEMO_ORG}/p/NWS/advancing?section=guests`);
  await owner.getByRole("button", { name: "Add guest" }).click();
  const add = owner.getByRole("dialog", { name: "Add a guest" });
  await add.getByLabel("Guest name").fill(existing);
  await add.getByRole("button", { name: "Add guest" }).click();
  await expect(owner.getByRole("link", { name: existing })).toBeVisible();

  // The Field lead holds advancing.rider.write on the project, but the field role never sees the import page
  // (C14): the guest list offers Add guest and no Import guests link.
  const field = await asPerson(browser, "field@example.com");
  await field.goto(`/${DEMO_ORG}/p/NWS/advancing?section=guests`);
  await expect(field.getByRole("link", { name: existing })).toBeVisible();
  await expect(field.getByRole("button", { name: "Add guest" })).toBeVisible();
  await expect(field.getByRole("link", { name: "Import guests" })).toHaveCount(0);
  await field.context().close();

  // The Producer imports the list from the guest list page.
  const producer = await asPerson(browser, "producer@example.com");
  await producer.goto(`/${DEMO_ORG}/p/NWS/advancing?section=guests`);
  await producer.getByRole("link", { name: "Import guests" }).click();
  await producer.waitForURL(/\/import\?target=guest_list_entries&project=/);
  await expect(producer.getByLabel("Import into")).toHaveValue("guest_list_entries");
  await expect(producer.getByLabel("Project")).not.toHaveValue("");
  const csv = [
    "Guest,Plus 1,Access",
    `${existing.toUpperCase()},2,Side door`,
    `${existing.replace("Vale", "Vael")},0,`,
    `${fresh},1,`,
  ].join("\n");
  await producer
    .locator("#import-file")
    .setInputFiles({ name: `guests-${id}.csv`, mimeType: "text/csv", buffer: Buffer.from(csv) });
  await producer.getByRole("button", { name: "Upload and read" }).click();
  await producer.waitForURL(/\?import=/);
  const importUrl = producer.url();

  await runImportWorker();
  await reloadUntil(producer, producer.getByRole("heading", { name: "Map the columns" }));
  await expect(producer.getByLabel("Column Guest")).toHaveValue("guest_name");
  await expect(producer.getByLabel("Column Plus 1")).toHaveValue("plus_ones");
  await expect(producer.getByLabel("Column Access")).toHaveValue("note");
  await expectAccessibleInBothThemes(producer);
  await producer.getByRole("button", { name: "Confirm the mapping" }).click();

  // The exact duplicate is an update; the near duplicate waits for a decision.
  await runImportWorker();
  await reloadUntil(producer, producer.getByRole("heading", { name: "Dry run" }));
  await expect(producer.getByText(`Row 3 looks like ${existing}`)).toBeVisible();
  await expect(producer.getByRole("button", { name: "Commit the import" })).toBeDisabled();
  await expectAccessibleInBothThemes(producer);
  await producer.context().addCookies([{ name: "xos-locale", value: "en-XA", url: importUrl }]);
  await producer.reload();
  expect(describe(await hardCodedText(producer))).toEqual([]);
  await producer.context().clearCookies({ name: "xos-locale" });
  await producer.reload();
  await producer.getByRole("button", { name: "Keep separate" }).click();
  await expect(producer.getByText("Kept as a new record.")).toBeVisible();
  const dry = producer.getByRole("region", { name: "Dry run" });
  await expect(dry.getByText("New records").locator("..")).toContainText("2");
  await expect(dry.getByText("Updates").locator("..")).toContainText("1");
  await producer.getByRole("button", { name: "Commit the import" }).click();
  await runImportWorker();
  await reloadUntil(producer, producer.getByRole("heading", { name: "Undo the whole batch" }));
  await expect(producer.getByText("3 rows were written")).toBeVisible();

  // The committer cannot approve a guest they imported.
  await producer.goto(`/${DEMO_ORG}/p/NWS/advancing?section=guests`);
  await producer.getByRole("button", { name: `Approve ${fresh}` }).click();
  await expect(
    producer.getByText("You requested this guest, so someone else must approve or decline them."),
  ).toBeVisible();
  await producer.context().close();

  // The Owner approves the two imported guests in one bulk change.
  await owner.goto(`/${DEMO_ORG}/p/NWS/advancing?section=guests&view=table`);
  const grid = owner.getByRole("grid");
  const row = (name: string) =>
    grid
      .getByRole("row")
      .filter({ has: owner.locator('td[data-column="guest"]').filter({ hasText: name }) });
  await expect(row(existing)).toHaveCount(1);
  await row(fresh).getByRole("checkbox").click();
  await row(existing.replace("Vale", "Vael"))
    .getByRole("checkbox")
    .click({ modifiers: ["ControlOrMeta"] });
  await owner
    .getByRole("toolbar", { name: "Bulk actions" })
    .getByRole("button", { name: "Change State" })
    .click();
  const bulk = owner.getByRole("dialog", { name: /Change State on 2 rows/ });
  await bulk.getByLabel("New State").selectOption({ label: "Approved" });
  await bulk.getByRole("button", { name: "Preview" }).click();
  await bulk.getByRole("button", { name: "Apply to 2 rows" }).click();
  await expect(owner.getByText("Changed 2 rows.").first()).toBeVisible();
  await expect(row(fresh).locator('td[data-column="state"]')).toHaveText("Approved");
  await owner.context().close();
});
