import { expect, test } from "@playwright/test";
import { DEMO_ORG, reloadUntil, runImportWorker, signInAs } from "./a36-support";
import { personOf, sql } from "./b2-support";
import { uniqueId } from "./support";

/**
 * B10 (RRR-234, G-132, ADR 0149 decision 5): freelancers into a pool from a file. From the Pools page, Import people with the
 * number format 1.234,56. The CSV holds a rate, a repeated email, a bad phone and a name near a member of a pool: Demo Crew
 * Member is in the seeded Trusted Riggers. The issues show, the review is decided as Merged and that row is Skipped, the
 * import commits and the invitations list on the page, with the rate read in the chosen format and no person created. The
 * import worker runs with the service role (runImportWorker). The invitee's side is b10-party-steps.spec.ts in Gateway.
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(300_000);

test("a freelancer list: map, review, merge, commit, and the invitations appear", async ({
  page,
}) => {
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

  // Review offers a merge only with someone already in a pool.
  await sql(
    `insert into app.pool_members (talent_pool_id, person_id)
     select tp.id, p.id from app.talent_pools tp, app.people p
      where tp.name = $1 and p.full_name = 'Demo Crew Member'`,
    [`Freelancers ${id}`],
    await personOf("owner@example.com"),
  );
  const csv = [
    "Email,Name,Phone,Rate",
    `ana-${id}@example.com,Ana ${id},+13055550142,"1.250,50 €/día"`,
    `ana-${id}@example.com,Ana ${id},+13055550142,"1.250,50 €/día"`,
    `ben-${id}@example.com,Ben ${id},12,`,
    `cleo-${id}@example.com,Cleo ${id},,`,
    `dana-${id}@example.com,demo crew member,,`,
  ].join("\n");
  await page.locator("#import-file").setInputFiles({
    name: `freelancers-${id}.csv`,
    mimeType: "text/csv",
    buffer: Buffer.from(csv),
  });
  await page.getByRole("button", { name: "Upload and read" }).click();
  await page.waitForURL(/\?import=/);

  await runImportWorker();
  await reloadUntil(page, page.getByRole("heading", { name: "Map the columns" }));
  await expect(page.getByLabel("Column Email").first()).toHaveValue("email");
  await page.getByRole("button", { name: "Confirm the mapping" }).click();
  await expect(page.getByText("Checking every row")).toBeVisible();

  await runImportWorker();
  await reloadUntil(page, page.getByRole("heading", { name: "Rows with problems" }));

  // The repeat and the bad phone are Invalid; the near name waits for a decision before anything commits.
  await expect(page.getByText("repeats an earlier row").first()).toBeVisible();
  await expect(page.getByText("not a phone number").first()).toBeVisible();
  await expect(page.getByText(/looks like Demo Crew Member/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Commit the import" })).toBeDisabled();

  // Merged means skipped: this person is already in a pool, and nothing is written over them.
  await page.getByRole("button", { name: "Merge into it" }).click();
  await expect(page.getByText("Skipped: already invited or in a pool.")).toBeVisible();
  await page.getByRole("button", { name: "Commit the import" }).click();
  await expect(page.getByText("Writing the rows")).toBeVisible();
  await runImportWorker();
  await reloadUntil(page, page.getByRole("heading", { name: "Undo the whole batch" }));

  // The merged row reads as skipped in the reader's language, never as a code.
  await expect(page.getByText("already invited or in a pool, merged in review")).toBeVisible();
  await expect(page.getByText("pool_merged_in_review")).toHaveCount(0);

  await page.goto(`/${DEMO_ORG}/opportunities/pools`);
  await page.getByRole("link", { name: `Freelancers ${id}` }).click();
  const invitations = page.locator("#pool-invitations");
  await expect(invitations.getByText(`cleo-${id}@example.com`)).toBeVisible();
  await expect(invitations.getByText("Pending").first()).toBeVisible();
  // The rate went through the chosen format: 1.250,50 is one thousand two hundred fifty and a half.
  await expect(invitations.getByText(`ana-${id}@example.com`)).toBeVisible();
  await expect(invitations.getByText(/1,250\.50/)).toBeVisible();
  // The bad phone and the merged row wrote nothing.
  await expect(invitations.getByText(`ben-${id}@example.com`)).toHaveCount(0);
  await expect(invitations.getByText(`dana-${id}@example.com`)).toHaveCount(0);
});
