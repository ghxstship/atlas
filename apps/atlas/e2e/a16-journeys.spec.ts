import { expect, test, type Page } from "@playwright/test";
import { act, expectAccessibleInBothThemes, ORG, signIn } from "./a16-support";
import { uniqueId } from "./support";

/**
 * A16 journeys on the demo tenant (Section 20.2, RRR-55), Atlas side:
 *   4  source by RFQ: invite vendors, issue, record sealed responses, close to unseal, award and
 *      create the purchase order from the winning quote
 *   30 the creator cannot approve their own purchase order; another approver within spend
 *      authority approves it
 *   5  receive goods against the order and see an excess receipt refused
 *   and the separation of duties on prequalifications and canon extensions, the SOP publish and
 *   acknowledge cycle with a refused stale save (33), and invariant 24 on the verbiage library.
 * The Producer drives procurement; the Admin approves. Names carry a unique suffix.
 */

test.use({ reducedMotion: "reduce" });

async function peekOf(page: Page) {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Approves the step an order's approval waits on, as the signed-in approver, from Approvals. */
async function decideStep(page: Page, poNumber: string, step: string) {
  await page.goto(`/${ORG}/approvals`);
  const heading = page.getByRole("heading", { name: `Purchase order ${poNumber}`, exact: true });
  const item = page.getByRole("listitem").filter({ has: heading });
  await expect(item.getByText(step).first()).toBeVisible();
  await page.waitForLoadState("networkidle");
  await item.getByRole("button", { name: "Approve step" }).click();
  // The decided approval leaves the waiting list (A24-001: its confirmation leaves with it).
  await expect(item.getByRole("button", { name: "Approve step" })).toHaveCount(0);
}

test("journeys 4, 30 and 5: RFQ to purchase order, approval by another person, receipt", async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const id = uniqueId();
  const title = `Delay tower audio ${id}`;
  await signIn(page, "producer@example.com");

  // Journey 4: draft, invite, issue.
  await page.goto(`/${ORG}/procurement/rfqs?create=1`);
  const create = await peekOf(page);
  await create.getByLabel("Project").selectOption({ label: "NWS Northwind Summer Series" });
  await create.getByLabel("What is being sourced").fill(title);
  await create.getByRole("button", { name: "New RFQ" }).click();
  const peek = page.getByRole("dialog", { name: new RegExp(title) });
  await expect(peek).toBeVisible();
  await peek.getByRole("link", { name: "Open full page" }).click();
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();

  const invitations = page.locator("section", {
    has: page.getByRole("heading", { name: "Invited vendors" }),
  });
  for (const vendor of ["Demo Staging Supply", "Bayline Audio Rentals"]) {
    await invitations.getByLabel("Vendor").selectOption({ label: vendor });
    await invitations.getByRole("button", { name: "Invite vendor" }).click();
    await expect(invitations.getByRole("listitem").filter({ hasText: vendor })).toBeVisible();
  }
  await act(page, page.locator("header"), "Issue to vendors", "Specification is final.");
  await expect(page.getByText("Issued", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Responses are sealed")).toBeVisible();
  await expectAccessibleInBothThemes(page);

  // Sealed responses recorded on the vendors' behalf.
  const responses = [
    { vendor: "Demo Staging Supply", price: "4200.00" },
    { vendor: "Bayline Audio Rentals", price: "4800.00" },
  ];
  for (const r of responses) {
    const form = page.locator("section", {
      has: page.getByRole("heading", { name: "Record a response" }),
    });
    await form.getByLabel("Responding vendor").selectOption({ label: r.vendor });
    await form.getByLabel("Line 1").fill("Delay tower system, per show day");
    await form.getByLabel("Quantity").first().fill("4");
    await form.getByLabel("Unit price").first().fill(r.price);
    await form.getByRole("button", { name: "Record a response" }).click();
    await page.waitForLoadState("networkidle");
    await expect(form.getByRole("alert")).toHaveCount(0);
    await expect(form.getByLabel("Line 1")).toHaveValue("");
  }

  // Close at the deadline: responses unseal for comparison; award.
  await act(page, page.locator("header"), "Close and unseal", "Deadline reached.");
  const comparison = page.getByRole("grid", { name: "Quote comparison" });
  await expect(comparison).toBeVisible();
  await expect(comparison.getByText("Bayline Audio Rentals")).toBeVisible();
  await act(page, page.locator("header"), "Award", "Lowest fully priced quote.");
  await act(page, page.locator("main"), "Create order from Demo Staging Supply");
  // The confirmation closes once the order exists; listing orders before that would miss it.
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // The new order is the draft for Demo Staging Supply at the awarded total (4 at $4,200.00); the
  // demo seed holds another draft for the same vendor.
  await page.goto(`/${ORG}/procurement/purchase-orders?view=list`);
  const draftRow = page
    .getByRole("row")
    .filter({ hasText: "Demo Staging Supply" })
    .filter({ hasText: "Draft" })
    .filter({ hasText: "$16,800.00" })
    .first();
  const poNumber = /PO(\d+)/.exec(await draftRow.innerText())?.[1] ?? "";
  expect(poNumber).not.toBe("");
  await draftRow.getByRole("button", { name: "Open" }).click();
  await (await peekOf(page)).getByRole("link", { name: "Open full page" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Lines" })).toBeVisible();
  await expect(page.getByText("Delay tower system, per show day").first()).toBeVisible();
  const orderUrl = page.url();

  // Journey 30: the creator's approval is refused with the rule.
  await act(page, page.locator("header"), "Approve", "Mine to approve.");
  await expect(
    page.getByText(
      "Separation of duties: the person who created the purchase order cannot approve it.",
    ),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  // The demo tenant's approval policy (A33, seed 1030) routes every order through Finance review
  // (an Admin) and Owner sign-off before anyone may approve it under spend authority.
  await page.goto(`/${ORG}/approvals`);
  const submit = page.getByRole("form", { name: "Submit a document for approval" });
  const document = `Purchase order: NWS PO ${poNumber} (NWS)`;
  await submit.getByLabel("Document").selectOption({ label: document });
  await submit.getByRole("button", { name: "Submit for approval" }).click();
  await expect(page.getByRole("option", { name: document })).toHaveCount(0);

  const admin = await (await browser.newContext()).newPage();
  await signIn(admin, "admin@example.com");
  await decideStep(admin, poNumber, "Finance review");
  const owner = await (await browser.newContext()).newPage();
  await signIn(owner, "owner@example.com");
  await decideStep(owner, poNumber, "Owner sign-off");

  await admin.goto(orderUrl);
  await act(admin, admin.locator("header"), "Approve", "Within budget and spend authority.");
  await expect(admin.getByText("Approved", { exact: true }).first()).toBeVisible();

  // Send, then journey 5: receive, and refuse an excess receipt.
  await page.goto(orderUrl);
  await act(page, page.locator("header"), "Send to vendor", "Emailed with the rider.");
  await expect(page.getByText("Sent", { exact: true }).first()).toBeVisible();
  await page.getByRole("link", { name: "Receive goods" }).click();
  const receive = await peekOf(page);
  await expect(receive.getByText("4 of 4 still to receive")).toBeVisible();
  await receive.getByRole("button", { name: "Record receipt" }).click();
  await expect(page.getByRole("dialog", { name: /Receipt of/ })).toBeVisible();

  await page.goto(
    `${orderUrl.split("?")[0]?.replace("purchase-orders", "receipts")}?create=1&order=${new URL(orderUrl).searchParams.get("peek")}`,
  );
  const again = await peekOf(page);
  await expect(again.getByText("0 of 4 still to receive")).toBeVisible();
  await again.getByLabel(/Delay tower system/).fill("1");
  await again.getByRole("button", { name: "Record receipt" }).click();
  await expect(
    again.getByText("This would receive more than was ordered.", { exact: false }),
  ).toBeVisible();
  await expectAccessibleInBothThemes(page);
});

test("prequalification and canon extensions are decided by someone other than the requester", async ({
  page,
  browser,
}) => {
  const id = uniqueId();
  await signIn(page, "producer@example.com");
  await page.goto(`/${ORG}/vendors/prequalification?create=1`);
  const form = await peekOf(page);
  await form.getByLabel("Vendor").selectOption({ label: "Bayline Audio Rentals" });
  await form.getByLabel("Scope").fill(`Ground stacked subwoofers ${id}`);
  await form.getByRole("button", { name: "Request prequalification" }).click();
  const peek = page.getByRole("dialog", { name: /Prequalification/ });
  await expect(peek.getByText(`Ground stacked subwoofers ${id}`)).toBeVisible();
  await act(page, peek, "Approve");
  await expect(
    page.getByText("Separation of duties: the person who requested this cannot decide it."),
  ).toBeVisible();
  const url = page.url();

  const admin = await (await browser.newContext()).newPage();
  await signIn(admin, "admin@example.com");
  await admin.goto(url);
  await act(admin, admin.getByRole("dialog"), "Approve");
  await expect(
    admin.getByRole("dialog").getByText("Approved", { exact: true }).first(),
  ).toBeVisible();

  // Canon: the Admin proposes; the Admin cannot approve their own proposal; the Owner does.
  const code = `5000.${String(50 + (Number.parseInt(id.slice(-2), 36) % 40)).padStart(2, "0")}`;
  await admin.goto(`/${ORG}/canon/org-extensions?create=1`);
  const propose = await peekOf(admin);
  await propose.getByLabel("Parent").selectOption({ value: "5000" });
  await propose.getByLabel("Code").fill(code);
  await propose.getByLabel("Label").fill(`Pyro Effects ${id}`);
  await propose
    .getByLabel("Why the org needs it")
    .fill("Pyrotechnics need their own permits and crew.");
  await propose.getByRole("button", { name: "Propose extension" }).click();
  const proposal = admin.getByRole("dialog", { name: new RegExp(`Pyro Effects ${id}`) });
  const refusedOrMade = await Promise.race([
    proposal.waitFor().then(() => "made"),
    admin
      .getByText("That code is already canon")
      .waitFor()
      .then(() => "exists"),
    admin
      .getByText("That value is already in use")
      .waitFor()
      .then(() => "taken"),
  ]);
  test.skip(refusedOrMade !== "made", "the generated canon code was already taken");
  await expect(
    proposal.getByText("You proposed this, so someone else has to approve or reject it."),
  ).toBeVisible();
  await expect(proposal.getByRole("button", { name: "Approve" })).toHaveCount(0);
  const proposalUrl = admin.url();
  const owner = await (await browser.newContext()).newPage();
  await signIn(owner, "owner@example.com");
  await owner.goto(proposalUrl);
  await act(owner, owner.getByRole("dialog"), "Approve", "Core service for 2027.");
  await expect(
    owner.getByRole("dialog").getByText("Approved", { exact: true }).first(),
  ).toBeVisible();
});

test("journey 33 and invariant 24: SOP publish and acknowledge, a refused stale save, no em dash", async ({
  page,
  browser,
}) => {
  const id = uniqueId();
  const code = `SOP-${String(Number.parseInt(id.slice(-4), 36) % 90000).padStart(5, "1")}`;
  await signIn(page, "producer@example.com");
  await page.goto(`/${ORG}/knowledge/sops?create=1`);
  const form = await peekOf(page);
  await form.getByLabel("Code").fill(code);
  await form.getByLabel("Title").fill(`Crowd barrier check ${id}`);
  await form.getByLabel("Procedure").fill("Walk the barrier line.\n\nConfirm every pin is seated.");
  await form.getByRole("button", { name: "New SOP" }).click();
  const peek = page.getByRole("dialog", { name: new RegExp(`Crowd barrier check ${id}`) });
  await expect(peek).toBeVisible();
  await act(page, peek, "Publish");
  await act(
    page,
    page.getByRole("dialog", { name: new RegExp(`Crowd barrier check ${id}`) }),
    "Acknowledge",
  );
  await expect(
    page.getByRole("dialog").getByText("Acknowledged", { exact: true }).first(),
  ).toBeVisible();
  await page.getByRole("dialog").getByRole("link", { name: "Open full page" }).click();
  await page.waitForURL(/full=1/);
  await expect(page.getByRole("heading", { level: 2, name: "Edit" })).toBeVisible();
  const fullUrl = page.url();

  // Two editors: the second save over a newer version is refused, not merged silently.
  const other = await (await browser.newContext()).newPage();
  await signIn(other, "admin@example.com");
  await other.goto(fullUrl);
  await other.getByLabel("Title").fill(`Crowd barrier inspection ${id}`);
  await other.getByRole("button", { name: "Save SOP" }).click();
  await expect(other.getByText("Saved.")).toBeVisible();
  await page.getByLabel("Title").fill(`Barrier check ${id}`);
  await page.getByRole("button", { name: "Save SOP" }).click();
  await expect(
    page.getByText("Someone saved a newer version while you were editing.", { exact: false }),
  ).toBeVisible();

  // Invariant 24: the verbiage form explains the em dash before the database refuses it.
  await page.goto(`/${ORG}/knowledge/verbiage-library?create=1`);
  const term = await peekOf(page);
  await term.getByLabel("Term").fill(`Changeover ${id}`);
  await term.getByLabel("Casing rule").fill("Title Case");
  await term
    .getByLabel("Definition")
    .fill(`The reset between acts ${String.fromCharCode(0x2014)} timed.`);
  await term.getByRole("button", { name: "Add term" }).click();
  await expect(
    term.getByText("Remove the em dash. Use a comma, colon or parentheses instead."),
  ).toBeVisible();
  await term.getByLabel("Definition").fill("The reset between acts, timed to the minute.");
  await term.getByRole("button", { name: "Add term" }).click();
  await expect(page.getByRole("dialog", { name: new RegExp(`Changeover ${id}`) })).toBeVisible();
});
