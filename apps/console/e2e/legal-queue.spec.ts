import { expect, test, type Page } from "@playwright/test";
import {
  DEMO,
  DEMO_PASSWORD,
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

/** The value of a datetime-local input for an instant: New York time, the zone every clock on the queue counts in. */
function localValue(ms: number): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  return `${parts["year"]}-${parts["month"]}-${parts["day"]}T${parts["hour"]}:${parts["minute"]}`;
}

async function addItem(
  page: Page,
  input: { rule: string; title: string; receivedMs: number; contact?: string },
): Promise<void> {
  const form = page.getByTestId("legal-queue-add");
  await form.getByLabel("What is it", { exact: true }).selectOption({ label: input.rule });
  await form.getByLabel("Short description", { exact: true }).fill(input.title);
  await form.getByLabel("When it arrived", { exact: true }).fill(localValue(input.receivedMs));
  if (input.contact) await form.getByLabel("Who to answer", { exact: true }).fill(input.contact);
  await form.getByRole("button", { name: "Add to the queue" }).click();
  await expect(form.getByText("Added to the queue.", { exact: true })).toBeVisible();
}

test("the one Administrator works a security report from arrival to close, and the sweep alerts them", async ({
  page,
}) => {
  const email = await newOperator("Administrator", "Olga Clock");
  await signInOperator(page, email, "/legal-queue");
  await expect(page.getByRole("heading", { level: 1, name: "Legal Queue" })).toBeVisible();
  await expect(page.getByTestId("outside-reviewer")).toContainText("None is appointed");
  await expect(
    page.getByText("No backup contact yet. One full inbox could hide a missed clock.", {
      exact: true,
    }),
  ).toBeVisible();

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
  await expect(page.getByText("researcher@example.test", { exact: true })).toBeVisible();
  await expect(page.getByTestId("legal-log")).toContainText("Alert queued for email");

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
  await expect(
    move.getByText("Every state change carries a reason.", { exact: true }),
  ).toBeVisible();
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
  // The console ledger, which every operator role reads, says only that it happened.
  const open = await sql<{ count: number }>(
    `select count(*)::int as count from app.platform_operator_actions
      where subject_id = $1 and (reason is not null or details <> '{}'::jsonb)`,
    [item?.id],
  );
  expect(open[0]?.count).toBe(0);
  await expectAccessibleInBothThemes(page);
});

test("times are typed in the queue's own zone, so a date across daylight saving keeps its hour, and the form resets whole", async ({
  page,
}) => {
  const email = await newOperator("Administrator", "Olga Offset");
  await signInOperator(page, email, "/legal-queue");
  const form = page.getByTestId("legal-queue-add");
  await expect(
    form.getByText("In America/New_York time, the zone every clock here counts in.", {
      exact: false,
    }),
  ).toBeVisible();
  const firstSource = await form.getByTestId("rule-source").innerText();

  const title = `Subpoena ${uniqueId()}`;
  await form
    .getByLabel("What is it", { exact: true })
    .selectOption({ label: "Government data request" });
  await form.getByLabel("Short description", { exact: true }).fill(title);
  // Received in standard time, due in daylight time, and the second part of the pair is the document's own date.
  await form.getByLabel("When it arrived", { exact: true }).fill("2026-02-02T23:30");
  await form.getByLabel("Date the document sets", { exact: true }).fill("2027-03-20T17:00");
  await form.getByRole("button", { name: "Add to the queue" }).click();
  await expect(form.getByText("Added to the queue.", { exact: true })).toBeVisible();

  const [item] = await sql<{ received: boolean; due: boolean }>(
    `select received_at = '2026-02-02 23:30-05'::timestamptz as received,
            due_at = '2027-03-20 17:00-04'::timestamptz as due
       from app.legal_queue_items where title = $1`,
    [title],
  );
  expect(item).toEqual({ received: true, due: true });

  // The reset takes the rule back with it, so the source and the document's date match what the select shows.
  await expect(form.getByTestId("rule-source")).toHaveText(firstSource);
  await expect(form.getByLabel("Date the document sets", { exact: true })).toHaveCount(0);
});

test("a Support operator reads that queue actions happened, and nothing about them", async ({
  page,
}) => {
  const admin = await newOperator("Administrator", "Olga Quiet");
  const support = await newOperator("Support", "Omar Quiet");
  await signInOperator(page, admin, "/legal-queue");
  const form = page.getByTestId("legal-queue-add");
  const title = `Subpoena ${uniqueId()}`;
  const reason = `Complied with the order ${uniqueId()}`;
  await form
    .getByLabel("What is it", { exact: true })
    .selectOption({ label: "Government data request" });
  await form.getByLabel("Short description", { exact: true }).fill(title);
  await form
    .getByLabel("When it arrived", { exact: true })
    .fill(localValue(Date.now() - 3_600_000));
  await form
    .getByLabel("Date the document sets", { exact: true })
    .fill(localValue(Date.now() + 7 * 86_400_000));
  await form.getByRole("button", { name: "Add to the queue" }).click();
  await expect(form.getByText("Added to the queue.", { exact: true })).toBeVisible();
  await page
    .getByTestId("legal-queue")
    .getByRole("row")
    .filter({ hasText: title })
    .getByRole("link")
    .click();
  const move = page.getByTestId("legal-move");
  await move.getByLabel("New state", { exact: true }).selectOption("Completed");
  await move.getByLabel("What happened", { exact: true }).fill(reason);
  await move.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("legal-log")).toContainText(reason);

  await page.context().clearCookies();
  await signInOperator(page, support, "/activity");
  const activity = page.getByTestId("activity");
  await expect(
    activity.getByText("Moved a legal queue item", { exact: true }).first(),
  ).toBeVisible();
  await expect(activity).not.toContainText(reason);
  await expect(activity).not.toContainText("government_request");
  const response = await page.goto("/legal-queue");
  expect(response?.status()).toBe(404);
});

test("an appeal that arrives by email gets a computed clock, and closes only with a re-review and how the person was told", async ({
  page,
}) => {
  const email = await newOperator("Administrator", "Olga Mailbox");
  await signInOperator(page, email, "/legal-queue");
  const title = `Suspension appeal ${uniqueId()}`;
  await addItem(page, {
    rule: "Appeal of a restriction, by email",
    title,
    receivedMs: Date.now() - 3_600_000,
    contact: "appellant@example.test",
  });
  const [item] = await sql<{ thirty: boolean }>(
    `select due_at = private.legal_clock_end(received_at, 30, 'Days') as thirty from app.legal_queue_items where title = $1`,
    [title],
  );
  expect(item?.thirty).toBe(true);
  await page
    .getByTestId("legal-queue")
    .getByRole("row")
    .filter({ hasText: title })
    .getByRole("link")
    .click();

  const move = page.getByTestId("legal-move");
  await move.getByLabel("New state", { exact: true }).selectOption("Completed");
  await move.getByLabel("What happened", { exact: true }).fill("Upheld: the suspension stands.");
  await move.getByRole("button", { name: "Save" }).click();
  await expect(
    move.getByText(
      "Record what you looked at again and how you weighed the grounds, in up to 4,000 characters.",
      { exact: true },
    ),
  ).toBeVisible();
  await move.getByLabel("What you looked at again", { exact: true }).fill("Read the logs again.");
  await move.getByRole("button", { name: "Save" }).click();
  await expect(
    move.getByText(
      "Say how and when you told the person the result and the reasons, in up to 1,000 characters.",
      { exact: true },
    ),
  ).toBeVisible();
  // What was typed stays through both refusals.
  await expect(move.getByLabel("What happened", { exact: true })).toHaveValue(
    "Upheld: the suspension stands.",
  );
  await move
    .getByLabel("How you told the person the result", { exact: true })
    .fill("Emailed the result and reasons, and said the same person reviewed it.");
  await move.getByLabel("I made the original decision", { exact: true }).check();
  await move.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("legal-move")).toHaveCount(0);
  await expect(page.getByTestId("legal-log")).toContainText("Read the logs again.");
  await expect(
    page.getByText("The person who made the first decision", { exact: true }),
  ).toBeVisible();
  await expectAccessibleInBothThemes(page);
});

test("the backup contact and outside reviewer forms work, and an outside reviewer's decision is recorded, not made, by the operator", async ({
  page,
}) => {
  const listing = await reportedListing();
  const email = await newOperator("Administrator", "Olga Outside");
  await signInOperator(page, email, "/legal-queue");

  const contact = page.getByTestId("legal-contact-add");
  const backup = `backup-${uniqueId().toLowerCase()}@example.test`;
  await contact.getByLabel("Name", { exact: true }).fill("Bea Backup");
  await contact.getByLabel("Email", { exact: true }).fill(backup);
  await contact.getByRole("button", { name: "Add backup contact" }).click();
  const list = page.getByTestId("legal-contacts-list");
  await expect(list.getByText(backup)).toBeVisible();
  await list
    .getByRole("form", { name: "Remove Bea Backup" })
    .getByRole("button", { name: "Remove" })
    .click();
  await expect(page.getByText(backup)).toHaveCount(0);

  const appoint = page.getByTestId("outside-reviewer-appoint");
  await appoint.getByLabel("Name", { exact: true }).fill("Noor Adeyemi");
  await appoint.getByLabel("Firm or body", { exact: true }).fill("Adeyemi Review");
  await appoint.getByLabel("Email", { exact: true }).fill("noor@adeyemi.test");
  await appoint.getByLabel("Why", { exact: true }).fill("Independent appeals.");
  await appoint.getByRole("button", { name: "Appoint" }).click();
  await expect(page.getByTestId("outside-reviewer")).toContainText(
    "Noor Adeyemi of Adeyemi Review",
  );

  await page.goto(`/moderation/${listing.id}`);
  const decide = page.getByTestId("decide-listing");
  await decide.getByLabel("Decision", { exact: true }).selectOption("Removed");
  await decide.getByLabel("Ground", { exact: true }).selectOption("Terms Violation");
  await decide.getByLabel("Law or rule relied on", { exact: true }).fill("Acceptable Use Policy");
  await decide.getByLabel("Facts and circumstances", { exact: true }).fill("It asks for a fee.");
  await decide
    .getByLabel("Statement of reasons", { exact: true })
    .fill("We removed it. You may appeal.");
  await decide.getByRole("button", { name: "Record the decision" }).click();
  await expect(decide.getByText("Decision recorded and sent.", { exact: true })).toBeVisible();
  const [decision] = await sql<{ id: string }>(
    `select id from app.moderation_actions where opportunity_id = $1 order by decided_at desc limit 1`,
    [listing.id],
  );
  await sql(
    `select app.file_moderation_appeal($1, 'The fee is a statutory card check.')`,
    [decision?.id],
    DEMO.owner,
  );

  await page.reload();
  await expect(
    page.getByText(
      "This appeal goes to Noor Adeyemi, the outside reviewer. Record their decision once they have made it.",
      { exact: true },
    ),
  ).toBeVisible();
  const form = page.getByTestId("decide-appeal");
  await form
    .getByLabel("Reasons sent to the appellant", { exact: true })
    .fill("The fee breaks the rule.");
  await form
    .getByLabel("What you looked at again", { exact: true })
    .fill("Noor read the file and wrote the decision.");
  await form.getByRole("button", { name: "Record Noor Adeyemi's decision" }).click();
  await expect(
    page.getByText("Noor Adeyemi, the outside reviewer, re-reviewed it.", { exact: true }),
  ).toBeVisible();

  await page.goto("/legal-queue");
  const reviewer = page.getByRole("form", { name: "End the appointment" });
  await reviewer.getByLabel("Why it ends", { exact: true }).fill("The agreement ended.");
  await reviewer.getByRole("button", { name: "End the appointment" }).click();
  await expect(page.getByTestId("outside-reviewer")).toContainText("None is appointed");
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
    .fill(localValue(Date.now() - 3_600_000));
  await form.getByRole("button", { name: "Add to the queue" }).click();
  await expect(form.getByText("Added to the queue.", { exact: true })).toBeVisible();
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
    .fill(localValue(Date.now() - 3_600_000));
  await form.getByRole("button", { name: "Add to the queue" }).click();
  await expect(form.getByText("Added to the queue.", { exact: true })).toBeVisible();

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
    move.getByText(
      "The statute does not allow this before its earliest day. Wait for it, or record the court action.",
      { exact: true },
    ),
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
  await expect(decide.getByText("Decision recorded and sent.", { exact: true })).toBeVisible();

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
    page.getByText(
      "This item follows the record that created it, so its state changes when that record does.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByTestId("legal-move")).toHaveCount(0);
  await page.getByRole("link", { name: "Open the listing" }).click();

  await expect(
    page.getByText(
      "You made the decision this appeal is about. Look at it afresh: the record and the notice to the person will both say the same person re-reviewed it.",
      { exact: true },
    ),
  ).toBeVisible();
  const form = page.getByTestId("decide-appeal");
  await form
    .getByLabel("Reasons sent to the appellant", { exact: true })
    .fill("A card check breaks no rule.");
  await form.getByLabel("What you looked at again", { exact: true }).fill("  ");
  await form.getByRole("button", { name: "Decide the appeal" }).click();
  await expect(
    form.getByText(
      "Record what you looked at again and how you weighed the grounds, in up to 4,000 characters.",
      { exact: true },
    ),
  ).toBeVisible();
  await form
    .getByLabel("What you looked at again", { exact: true })
    .fill("Read the statute the appeal cites.");
  await form.getByLabel("Outcome", { exact: true }).selectOption("Reversed");
  await form.getByRole("button", { name: "Decide the appeal" }).click();
  await expect(
    page.getByText("The person who made the first decision re-reviewed it.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Re-review: Read the statute the appeal cites.", { exact: true }),
  ).toBeVisible();

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

test("a return of omitted data names the org by slug and holds its deletion until the item closes", async ({
  page,
}) => {
  const email = await newOperator("Administrator", "Olga Hold");
  await signInOperator(page, email, "/legal-queue");
  const title = `Payroll records ${uniqueId()}`;
  const form = page.getByTestId("legal-queue-add");
  await form
    .getByLabel("What is it", { exact: true })
    .selectOption({ label: "Return of data the export omits" });
  await form.getByLabel("Short description", { exact: true }).fill(title);
  await form
    .getByLabel("When it arrived", { exact: true })
    .fill(localValue(Date.now() - 3_600_000));
  // A slug no org has is refused, and what was typed stays.
  await form.getByLabel("Organization slug", { exact: true }).fill("no-such-org");
  await form.getByRole("button", { name: "Add to the queue" }).click();
  await expect(
    form.getByText(
      "Name the organization by its slug, as the Tenants page shows it. If its data is already deleted, add the request as another written promise and tell the person nothing is left to return.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(form.getByLabel("Short description", { exact: true })).toHaveValue(title);
  await form.getByLabel("Organization slug", { exact: true }).fill(DEMO.orgSlug);
  await form.getByRole("button", { name: "Add to the queue" }).click();
  await expect(form.getByText("Added to the queue.", { exact: true })).toBeVisible();

  const holds = () =>
    sql<{ active: boolean }>(
      `select h.released_at is null as active from app.legal_queue_items i
         join app.legal_holds h on h.id = i.legal_hold_id where i.title = $1`,
      [title],
    );
  expect(await holds()).toEqual([{ active: true }]);

  await page
    .getByTestId("legal-queue")
    .getByRole("row")
    .filter({ hasText: title })
    .getByRole("link")
    .first()
    .click();
  await expect(page.getByTestId("legal-log")).toContainText(
    "Legal hold placed on the organization",
  );
  const move = page.getByTestId("legal-move");
  await move.getByLabel("New state", { exact: true }).selectOption("Withdrawn");
  await move.getByLabel("What happened", { exact: true }).fill("The Owner withdrew the request.");
  await move.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("legal-log")).toContainText("Legal hold released");
  expect(await holds()).toEqual([{ active: false }]);
});

test("the outside heartbeat answers through the real API: booleans to a signed-in user, nothing to anon", async ({
  request,
}) => {
  const base = process.env["E2E_SUPABASE_URL"] ?? "";
  const apikey = process.env["E2E_SUPABASE_ANON_KEY"] ?? "";
  const email = await newAccount("heartbeat", "Hana Beat");
  const token = await request.post(`${base}/auth/v1/token?grant_type=password`, {
    headers: { apikey },
    data: { email, password: DEMO_PASSWORD },
  });
  expect(token.ok()).toBe(true);
  const { access_token: accessToken } = (await token.json()) as { access_token: string };
  const call = (authorization: string) =>
    request.post(`${base}/rest/v1/rpc/legal_queue_heartbeat`, {
      headers: { apikey, authorization, "content-profile": "api_public" },
      data: {},
    });
  const beat = await call(`Bearer ${accessToken}`);
  expect(beat.status()).toBe(200);
  const answer = (await beat.json()) as Record<string, unknown>;
  expect(Object.keys(answer).sort()).toEqual([
    "alert_path_ok",
    "email_ok",
    "feeds_ok",
    "recipient_ok",
    "sweep_ok",
  ]);
  expect(Object.values(answer).every((v) => typeof v === "boolean")).toBe(true);
  expect((await call(`Bearer ${apikey}`)).ok()).toBe(false);
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
