import { expect, test, type Page } from "@playwright/test";
import {
  DEMO,
  expectAccessibleInBothThemes,
  newAccount,
  newOperator,
  reportedListing,
  signInOperator,
  sql,
  uniqueId,
} from "./support";

/**
 * The legal queue and the one-person appeal rule (ADR 0167, RRR-248). One Administrator, the whole platform team, adds a
 * matter that arrived by email, sees the clock its rule computed, acts on it and reads the log; the hourly sweep alerts
 * them; a moderation appeal of their own decision reaches the queue and is decided by a documented re-review, and the
 * person is told who did it. A role without legal.queue never sees the page.
 */

/** The value of a datetime-local input for an instant, in the browser's zone, which the form sends with its offset. */
async function localValue(page: Page, ms: number): Promise<string> {
  return page.evaluate((at) => {
    const d = new Date(at);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }, ms);
}

async function addItem(
  page: Page,
  input: { rule: string; title: string; receivedMs: number; contact?: string },
): Promise<void> {
  const form = page.getByTestId("legal-queue-add");
  await form.getByLabel("What is it", { exact: true }).selectOption({ label: input.rule });
  await form.getByLabel("Short description", { exact: true }).fill(input.title);
  await form
    .getByLabel("When it arrived", { exact: true })
    .fill(await localValue(page, input.receivedMs));
  if (input.contact) await form.getByLabel("Who to answer", { exact: true }).fill(input.contact);
  await form.getByRole("button", { name: "Add to the queue" }).click();
  await expect(form.getByText("Added to the queue.")).toBeVisible();
}

test("the one Administrator works a security report from arrival to close, and the sweep alerts them", async ({
  page,
}) => {
  const email = await newOperator("Administrator", "Olga Clock");
  await signInOperator(page, email, "/legal-queue");
  await expect(page.getByRole("heading", { level: 1, name: "Legal Queue" })).toBeVisible();
  await expect(page.getByTestId("outside-reviewer")).toContainText("None is appointed");
  await expect(page.getByText("No backup contact yet.")).toBeVisible();

  // It arrived 20 days ago, so both of its clocks have already passed.
  const title = `XSS in search ${uniqueId()}`;
  const received = Date.now() - 20 * 86_400_000;
  await addItem(page, {
    rule: "Security report",
    title,
    receivedMs: received,
    contact: "researcher@example.test",
  });
  const queue = page.getByTestId("legal-queue");
  const row = queue.getByRole("row").filter({ hasText: title });
  await expect(row.getByText("Overdue", { exact: true })).toBeVisible();
  await expect(page.getByTestId("legal-queue-banner")).toBeVisible();
  await expectAccessibleInBothThemes(page);

  const [item] = await sql<{ id: string; reference: string; first_due: boolean; due: boolean }>(
    `select id, reference,
       first_response_due_at = private.legal_clock_end(received_at, 3, 'Business Days') as first_due,
       due_at = private.legal_clock_end(received_at, 10, 'Business Days') as due
       from app.legal_queue_items where title = $1`,
    [title],
  );
  expect(item).toMatchObject({ first_due: true, due: true });

  // The hourly sweep emails the operator, once for each clock, with the reference and never the description.
  await sql(`select private.sweep_legal_queue()`);
  const emails = await sql<{ args: string }>(
    `select args::text as args from private.platform_emails
      where template = 'legal_clock_alert' and to_email = $1`,
    [email.toLowerCase()],
  );
  expect(emails).toHaveLength(1);
  expect(emails[0]?.args).toContain(item?.reference);
  expect(emails[0]?.args).not.toContain("XSS in search");
  const [{ again } = { again: 0 }] = await sql<{ again: number }>(
    `select private.sweep_legal_queue() as again`,
  );
  expect(again).toBe(0);

  await row.getByRole("link", { name: item?.reference ?? "" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(title);
  await expect(page.getByText("researcher@example.test")).toBeVisible();
  await expect(page.getByTestId("legal-log")).toContainText("Alert sent");

  const first = page.getByTestId("legal-first");
  await first.getByLabel("What you sent", { exact: true }).fill("Acknowledged by email.");
  await first.getByRole("button", { name: "Record it" }).click();
  await expect(first).toHaveCount(0);
  await expect(page.getByTestId("legal-log")).toContainText("Acknowledged by email.");

  const note = page.getByTestId("legal-note");
  await note.getByLabel("What was done", { exact: true }).fill("Reproduced on staging.");
  await note.getByRole("button", { name: "Add to the log" }).click();
  await expect(page.getByTestId("legal-log")).toContainText("Reproduced on staging.");

  const move = page.getByTestId("legal-move");
  await move.getByLabel("New state", { exact: true }).selectOption("Completed");
  // A refusal keeps what was typed: the reason here is only spaces, which the database refuses.
  await move.getByLabel("What happened", { exact: true }).fill("   ");
  await move.getByRole("button", { name: "Save" }).click();
  await expect(move.getByText("Every state change carries a reason.")).toBeVisible();
  await move.getByLabel("What happened", { exact: true }).fill("Plan sent and fix released.");
  await move.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("legal-log")).toContainText("Plan sent and fix released.");
  await expect(page.getByTestId("legal-move")).toHaveCount(0);
  await expect(page.getByText("Closed", { exact: true })).toBeVisible();

  const ledger = await sql<{ action: string }>(
    `select distinct action from app.platform_operator_actions where subject_id = $1`,
    [item?.id],
  );
  expect(ledger.map((l) => l.action).sort()).toEqual([
    "legal_queue.added",
    "legal_queue.first_response",
    "legal_queue.moved",
    "legal_queue.noted",
    "legal_queue.viewed",
  ]);
  await expectAccessibleInBothThemes(page);
});

test("a DMCA counter-notice cannot be closed before its earliest day, unless a court action keeps the material down", async ({
  page,
}) => {
  const email = await newOperator("Administrator", "Olga Takedown");
  const uploader = await newAccount("uploader", "Rene Uploader");
  await signInOperator(page, email, "/legal-queue");

  const noticeTitle = `Portfolio photo ${uniqueId()}`;
  const form = page.getByTestId("legal-queue-add");
  await form.getByLabel("What is it", { exact: true }).selectOption({ label: "DMCA notice" });
  await form.getByLabel("Account it is about", { exact: true }).fill(uploader);
  await form.getByLabel("Short description", { exact: true }).fill(noticeTitle);
  await form
    .getByLabel("When it arrived", { exact: true })
    .fill(await localValue(page, Date.now() - 3_600_000));
  await form.getByRole("button", { name: "Add to the queue" }).click();
  await expect(form.getByText("Added to the queue.")).toBeVisible();
  const [notice] = await sql<{ reference: string }>(
    `select reference from app.legal_queue_items where title = $1`,
    [noticeTitle],
  );

  const counterTitle = `Says it is licensed ${uniqueId()}`;
  await form
    .getByLabel("What is it", { exact: true })
    .selectOption({ label: "DMCA counter-notice" });
  await form
    .getByLabel("Reference of the DMCA notice it answers", { exact: true })
    .fill(notice?.reference ?? "");
  await form.getByLabel("Short description", { exact: true }).fill(counterTitle);
  await form
    .getByLabel("When it arrived", { exact: true })
    .fill(await localValue(page, Date.now() - 3_600_000));
  await form.getByRole("button", { name: "Add to the queue" }).click();
  await expect(form.getByText("Added to the queue.")).toBeVisible();

  await page
    .getByTestId("legal-queue")
    .getByRole("row")
    .filter({ hasText: counterTitle })
    .getByRole("link")
    .click();
  await expect(page.getByText("Do not restore before", { exact: false })).toBeVisible();
  const move = page.getByTestId("legal-move");
  await move.getByLabel("New state", { exact: true }).selectOption("Completed");
  await move.getByLabel("What happened", { exact: true }).fill("Restored.");
  await move.getByRole("button", { name: "Save" }).click();
  await expect(
    move.getByText("The statute does not allow this before its earliest day.", { exact: false }),
  ).toBeVisible();
  await expect(move.getByLabel("What happened", { exact: true })).toHaveValue("Restored.");

  await move
    .getByLabel("The notifier filed a court action, so the material stays down", { exact: true })
    .check();
  await move.getByLabel("What happened", { exact: true }).fill("Notifier filed suit.");
  await move.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("legal-move")).toHaveCount(0);
  await expect(page.getByText("Court action filed", { exact: true })).toBeVisible();
});

test("one operator decides an appeal of their own decision by a documented re-review, and the person is told", async ({
  page,
}) => {
  const listing = await reportedListing();
  const email = await newOperator("Administrator", "Olga Appeal");
  await signInOperator(page, email, `/moderation/${listing.id}`);

  const decide = page.getByTestId("decide-listing");
  await decide.getByLabel("Decision", { exact: true }).selectOption("Removed");
  await decide.getByLabel("Ground", { exact: true }).selectOption("Terms Violation");
  await decide.getByLabel("Law or rule relied on", { exact: true }).fill("Acceptable Use Policy");
  await decide.getByLabel("Facts and circumstances", { exact: true }).fill("It asks for a fee.");
  await decide
    .getByLabel("Statement of reasons", { exact: true })
    .fill("We removed it. You may appeal.");
  await decide.getByRole("button", { name: "Record the decision" }).click();
  await expect(decide.getByText("Decision recorded and sent.")).toBeVisible();

  const [decision] = await sql<{ id: string }>(
    `select id from app.moderation_actions where opportunity_id = $1 order by decided_at desc limit 1`,
    [listing.id],
  );
  const [appeal] = await sql<{ id: string }>(
    `select app.file_moderation_appeal($1, 'The fee is a statutory card check.') as id`,
    [decision?.id],
    DEMO.owner,
  );
  expect(appeal?.id).toBeTruthy();

  // The appeal reaches the queue with its clock, and the banner stays quiet because it is not overdue.
  await page.goto("/legal-queue");
  const row = page.getByTestId("legal-queue").getByRole("row").filter({ hasText: listing.title });
  await expect(row.getByText("Moderation appeal", { exact: true })).toBeVisible();
  await row.getByRole("link").click();
  await expect(
    page.getByText("This item follows the record that created it", { exact: false }),
  ).toBeVisible();
  await expect(page.getByTestId("legal-move")).toHaveCount(0);
  await page.getByRole("link", { name: "Open the listing" }).click();

  await expect(
    page.getByText("You made the decision this appeal is about.", { exact: false }),
  ).toBeVisible();
  const form = page.getByTestId("decide-appeal");
  await form
    .getByLabel("Reasons sent to the appellant", { exact: true })
    .fill("A card check breaks no rule.");
  await form.getByLabel("What you looked at again", { exact: true }).fill("  ");
  await form.getByRole("button", { name: "Decide the appeal" }).click();
  await expect(form.getByText("Record what you looked at again", { exact: false })).toBeVisible();
  await form
    .getByLabel("What you looked at again", { exact: true })
    .fill("Read the statute the appeal cites.");
  await form.getByLabel("Outcome", { exact: true }).selectOption("Reversed");
  await form.getByRole("button", { name: "Decide the appeal" }).click();
  await expect(
    page.getByText("The person who made the first decision re-reviewed it."),
  ).toBeVisible();
  await expect(page.getByText("Re-review: Read the statute the appeal cites.")).toBeVisible();

  const [told] = await sql<{ reviewer: string; state: string }>(
    `select n.message_args ->> 'reviewer' as reviewer, i.item_state::text as state
       from app.notifications n
       cross join (select item_state from app.legal_queue_items where source_id = $2) i
      where n.kind = 'moderation_appeal.decided' and n.subject_id = $1 and n.recipient_person_id = $3`,
    [listing.id, appeal?.id, DEMO.owner],
  );
  expect(told).toEqual({ reviewer: "same", state: "Completed" });
  await expectAccessibleInBothThemes(page);
});

test("a role without legal.queue neither sees nor reaches it", async ({ page }) => {
  const email = await newOperator("Trust and Safety", "Theo Queue");
  await signInOperator(page, email);
  await expect(
    page.getByRole("navigation", { name: "Console" }).getByRole("link", { name: "Legal Queue" }),
  ).toHaveCount(0);
  const response = await page.goto("/legal-queue");
  expect(response?.status()).toBe(404);
});
