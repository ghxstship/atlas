import { expect as baseExpect, test, type Browser, type Page } from "./engine-test";
import { atlasAs, ORG } from "./atlas";
import {
  ACCOUNTS,
  asPerson,
  codeAndApproveInvoice,
  demoVendorId,
  invoiceByNumber,
  payInvoice,
  PEOPLE,
  PROJECT,
  requiredInsured,
  requirements,
  sentDocument,
  sentPurchaseOrder,
  suffix,
  transition,
  vendorCertificate,
  vendorEngagement,
} from "./role-fixtures";
import { DEMO, expectAccessible, expectAccessibleInBothThemes, signIn, sql } from "./support";

/**
 * The vendor journeys across Atlas and Gateway (Section 20.2):
 *   4   the PO the org sent is acknowledged by the vendor in Gateway, and Atlas shows it
 *   43  W-9 in Gateway, verified in Atlas; certificate of insurance on file; dock check-in; invoice;
 *       lien waiver signed; scorecard in Atlas
 *   56  the invoice followed from Submitted to Paid on the Money tracker
 * Journey 43's certificate step names its additional insureds (migration 1130, finding A38-001):
 * the Producer's check fails while the certificate misses the party the org requires, passes once
 * the party is named in Atlas, and the vendor sees the named party on Compliance.
 * Device halves: the dock check-in is the Compass gate scan, covered here by its server call as the
 * Field lead at the dock; the push itself needs a device (its delivery record is asserted in
 * invoice-notifications.spec.ts).
 */
test.use({ reducedMotion: "reduce" });
test.setTimeout(240_000);
const expect = baseExpect.configure({ timeout: 20_000 });

test("journey 4: the vendor acknowledges the sent PO in Gateway and Atlas shows it", async ({
  page,
  browser,
}) => {
  const engagement = await vendorEngagement();
  await transition("engagement", engagement.id, "Onboarding", "Active", "Vendor onboarded.");
  const po = await sentPurchaseOrder();

  await signIn(page, "vendor@example.com", `/work/engagements/${engagement.key}/purchase-orders`);
  const row = page.getByRole("listitem").filter({ hasText: `PO ${po.number}` });
  await expect(row).toBeVisible();
  await expect(
    row.getByText("Delay tower line array, per show day", { exact: false }),
  ).toBeVisible();
  await expectAccessibleInBothThemes(page);
  await row.getByRole("button", { name: "Acknowledge" }).click();
  await expect(row).toContainText(/Acknowledged [A-Z][a-z]{2} \d{1,2}, \d{4}/);
  await expect(row.getByRole("button", { name: "Acknowledge" })).toHaveCount(0);

  const [ack] = await sql<{ n: string }>(
    `select count(*)::text as n from app.po_acknowledgments where purchase_order_id = $1 and deleted_at is null`,
    [po.id],
  );
  expect(ack?.n).toBe("1");
  // A second acknowledgment is refused by the database, whatever the screen offers.
  await expect(
    asPerson(PEOPLE.vendorContact, `select app.acknowledge_purchase_order($1)`, [po.id]),
  ).rejects.toThrow(/already acknowledged/);

  const atlas = await atlasAs(browser, "owner@example.com");
  await atlas.page.goto(`/${ORG}/procurement/purchase-orders?peek=${po.id}&full=1`);
  const ackLine = atlas.page.getByText("Vendor acknowledged").locator("..");
  await expect(ackLine).toBeVisible();
  await expect(ackLine).not.toContainText("Not yet");
  await expectAccessible(atlas.page);
  await atlas.context.close();
});

test("journeys 43 and 56: vendor onboarding to close, and the invoice followed to Paid", async ({
  page,
  browser,
}) => {
  const coiName = `Certificate of Insurance ${suffix()}`;
  const packet = await requirements("Vendor", [
    { name: `Vendor W-9 ${suffix()}`, kind: "Tax Form" },
    { name: coiName, kind: "Document Upload" },
  ]);
  const insured = await requiredInsured(INSURED);
  try {
    await vendorOnboardingToClose(page, browser, coiName);
  } finally {
    await packet.retire();
    await insured.retire();
  }
});

/** The party the demo org requires every vendor certificate to name. */
const INSURED = "Demo Productions LLC";

async function vendorOnboardingToClose(
  page: Page,
  browser: Browser,
  coiName: string,
): Promise<void> {
  const engagement = await vendorEngagement();
  const certificate = await vendorCertificate();

  // W-9 from the vendor's company, in Gateway: vendors file it on Compliance, acting as the company.
  await signIn(page, "vendor@example.com", "/home");
  await page
    .context()
    .addCookies([{ name: "xos-acting", value: ACCOUNTS.vendor, url: page.url() }]);
  await page.goto(`/work/engagements/${engagement.key}/compliance`);
  const taxForm = page.getByRole("form", { name: "Tax form" });
  await expect(taxForm).toBeVisible();
  await expectAccessibleInBothThemes(page);
  await taxForm.getByLabel("Form").selectOption("W-9");
  await taxForm.getByLabel("Taxpayer identification number").fill("12-345");
  await taxForm.getByRole("button", { name: "Submit tax form" }).click();
  await expect(taxForm.getByText(/a W-9 needs nine digits|tax identifier/).first()).toBeVisible();
  await taxForm.getByLabel("Taxpayer identification number").fill("123456789");
  await taxForm.getByRole("button", { name: "Submit tax form" }).click();
  await expect(page.getByText("Tax form submitted.")).toBeVisible();

  // The certificate of insurance on file shows as current on the same tab.
  const coi = page.getByRole("listitem").filter({ hasText: certificate.policy });
  await expect(coi).toBeVisible();
  await expect(coi.getByText("Current")).toBeVisible();
  await expectAccessible(page);

  // Atlas: Active is refused until the W-9 step is verified; the Producer verifies and activates.
  const atlas = await atlasAs(browser, "producer@example.com");
  await atlas.page.goto(`/${ORG}/opportunities/engagements?id=${engagement.id}`);
  const moveTo = atlas.page.getByRole("form", { name: "Move to" });
  await moveTo.getByLabel("Next state").selectOption("Active");
  await moveTo.getByLabel("Reason").fill("Ready for the show.");
  await moveTo.getByRole("button", { name: "Move" }).click();
  await expect(atlas.page.getByText("Every blocking onboarding item must pass")).toBeVisible();
  const w9Item = atlas.page.getByRole("listitem").filter({ hasText: "Vendor W-9" });
  await w9Item.getByRole("button", { name: "Record verification" }).click();
  await expect(w9Item.getByText("Passes", { exact: true })).toBeVisible();

  // Journey 43's additional insureds step: the certificate does not name the required party yet.
  const insureds = atlas.page.getByRole("region", { name: "Additional insureds" });
  await expect(insureds.getByText(INSURED)).toBeVisible();
  await expect(insureds.getByText("Missing", { exact: true })).toBeVisible();
  await insureds.getByRole("button", { name: `Check additional insureds for ${coiName}` }).click();
  await expect(
    insureds.getByText(`No current certificate names: ${INSURED} (Additional Insured)`),
  ).toBeVisible();
  const coiItem = atlas.page.getByRole("listitem").filter({ hasText: coiName });
  await expect(coiItem.getByText("Failed", { exact: true }).first()).toBeVisible();
  await expectAccessible(atlas.page);

  // The Producer names the party on the certificate in Atlas, then the check passes.
  await atlas.page.goto(`/${ORG}/vendors/insurance-certificates?peek=${certificate.id}&full=1`);
  const named = atlas.page.getByRole("region", { name: "Additional insureds" });
  await named.getByLabel("Party named").fill(INSURED);
  await named.getByRole("button", { name: "Add insured" }).click();
  await expect(named.getByRole("listitem").filter({ hasText: INSURED })).toBeVisible();
  await expect(
    named.getByText("Names every additional insured the organization requires."),
  ).toBeVisible();
  await expectAccessible(atlas.page);
  await atlas.page.goto(`/${ORG}/opportunities/engagements?id=${engagement.id}`);
  await atlas.page
    .getByRole("region", { name: "Additional insureds" })
    .getByRole("button", { name: `Check additional insureds for ${coiName}` })
    .click();
  await expect(coiItem.getByText("Passes", { exact: true })).toBeVisible();
  await moveTo.getByLabel("Next state").selectOption("Active");
  await moveTo.getByLabel("Reason").fill("W-9 and insureds verified.");
  await moveTo.getByRole("button", { name: "Move" }).click();
  await expect(atlas.page.getByText("Active").first()).toBeVisible();
  await expectAccessible(atlas.page);

  // The vendor sees the party its certificate names on Compliance.
  await page.goto(`/work/engagements/${engagement.key}/compliance`);
  await expect(
    page
      .getByRole("listitem")
      .filter({ hasText: certificate.policy })
      .getByText(`${INSURED}, Additional Insured`),
  ).toBeVisible();

  // Dock: the Producer books the vendor's slot in Atlas Logistics > Dock with the Vendor select (R1);
  // it shows on the vendor's Deliveries tab and the dock checks the truck in (Compass).
  // An hour after the dock's last slot, in the project's time zone: slots at one dock never overlap.
  const [free] = await sql<{ starts: string; ends: string }>(
    `select to_char(w.at at time zone p.time_zone, 'YYYY-MM-DD"T"HH24:00') as starts,
            to_char((w.at + interval '2 hours') at time zone p.time_zone, 'YYYY-MM-DD"T"HH24:00') as ends
       from app.projects p,
            (select date_trunc('hour', greatest(coalesce(max(ends_at), now()), now())) + interval '2 hours' as at
               from app.dock_slots where zone_id = '01920000-0000-7000-8000-000000010923' and deleted_at is null) w
      where p.id = $1`,
    [DEMO.project],
  );
  const booking = await atlasAs(browser, "producer@example.com");
  await booking.page.goto(`/${ORG}/logistics/dock-schedule?project=${DEMO.project}&create=1`);
  const drawer = booking.page.getByRole("dialog", { name: "Book dock slot" });
  await drawer.getByLabel("Dock").selectOption({ label: "DOCK-1 Loading Dock" });
  await drawer.getByLabel("Vendor").selectOption(engagement.id);
  await drawer.getByLabel("Starts").fill(free?.starts ?? "");
  await drawer.getByLabel("Ends").fill(free?.ends ?? "");
  await drawer.getByRole("button", { name: "Book dock slot" }).click();
  await expect
    .poll(
      async () =>
        (
          await sql<{ id: string }>(
            `select id from app.dock_slots where engagement_id = $1 and deleted_at is null`,
            [engagement.id],
          )
        ).length,
    )
    .toBe(1);
  const [slot] = await sql<{ id: string }>(
    `select id from app.dock_slots where engagement_id = $1 and deleted_at is null`,
    [engagement.id],
  );
  await booking.context.close();
  if (!slot) throw new Error("The dock slot was not booked.");
  await page.goto(`/work/engagements/${engagement.key}/deliveries`);
  await expect(page.getByRole("heading", { name: "Dock slots" })).toBeVisible();
  await expectAccessible(page);
  await expect(
    asPerson(PEOPLE.vendorContact, `select app.check_in_dock_slot($1)`, [slot.id]),
  ).rejects.toThrow(/dock_slot_not_open/);
  await asPerson(PEOPLE.field, `select app.check_in_dock_slot($1)`, [slot.id]);
  const [checked] = await sql<{ at: string | null }>(
    `select checked_in_at::text as at from app.dock_slots where id = $1`,
    [slot.id],
  );
  expect(checked?.at).not.toBeNull();

  // Invoice in Gateway; the Money tracker follows it from Submitted to Paid (journey 56).
  const number = `DSS-${suffix()}`;
  await page.goto(`/work/engagements/${engagement.key}/invoices`);
  const invoiceForm = page.getByRole("form", { name: "Invoice" });
  await invoiceForm.getByLabel("Invoice number").fill(number);
  await invoiceForm.getByLabel("Item or service").fill("Delay towers, two show days");
  await invoiceForm.getByLabel("Quantity").fill("2");
  await invoiceForm.getByLabel("Unit price").fill("3800.00");
  await invoiceForm.getByRole("button", { name: "Submit invoice" }).click();
  await expect(
    page.getByText("Invoice submitted. Follow it on the payment tracker."),
  ).toBeVisible();
  const tracker = page.getByRole("region", { name: `Payment tracker for invoice ${number}` });
  await expect(tracker).toBeVisible();
  await expect(tracker.locator('[aria-current="step"]')).toContainText("Submitted");
  await expect(tracker).toContainText("$7,600.00");
  await expectAccessibleInBothThemes(page);

  const invoice = await invoiceByNumber(number);
  await codeAndApproveInvoice(invoice.id);
  await page.reload();
  await expect(tracker.locator('[aria-current="step"]')).toContainText("Approved");
  await payInvoice(invoice.id);
  await page.reload();
  await expect(tracker.locator("li").filter({ hasText: "Paid" })).toBeVisible();
  await expect(tracker).toContainText("Balance $0.00");
  // Money, Invoices lists it across organizations with its balance down to zero.
  await page.goto("/money/invoices");
  const moneyRow = page.getByRole("row", { name: new RegExp(`^${number} `) });
  await expect(moneyRow.getByRole("gridcell").nth(6)).toHaveText("$0.00");
  await expectAccessible(page);

  // Close: the vendor signs the lien waiver; the Producer scores the vendor in Atlas.
  const waiver = `Final Lien Waiver ${suffix()}`;
  await sentDocument(engagement.id, "Lien Waiver", waiver);
  await page.goto(`/work/engagements/${engagement.key}/documents`);
  const waiverRow = page.getByRole("listitem").filter({ hasText: waiver });
  await waiverRow.getByRole("button", { name: "Sign", exact: true }).click();
  await expect(waiverRow.getByText("Signed. The organization countersigns next.")).toBeVisible();

  const scored = async () =>
    Number(
      (
        await sql<{ n: string }>(
          `select count(*)::text as n from app.vendor_scorecards s join app.vendors v on v.id = s.vendor_id
            join app.counterparties c on c.id = v.counterparty_id
           where c.organization_id = $1 and s.period_end = '2027-06-06' and s.deleted_at is null`,
          [ACCOUNTS.vendor],
        )
      )[0]?.n,
    );
  const before = await scored();
  await atlas.page.goto(`/${ORG}/vendors/scorecards?create=1`);
  const scoreForm = atlas.page.locator("form").filter({ has: atlas.page.getByLabel("Period end") });
  await scoreForm.getByLabel("Vendor").selectOption({ label: "Demo Staging Supply" });
  await scoreForm.getByLabel("Period end").fill("2027-06-06");
  await scoreForm.getByLabel("Quality").selectOption({ label: "5 of 5" });
  await scoreForm.getByLabel("On-time delivery").selectOption({ label: "4 of 5" });
  await scoreForm.getByLabel("Safety").selectOption({ label: "5 of 5" });
  await scoreForm.getByRole("button", { name: "Score a vendor" }).click();
  await expect.poll(scored).toBe(before + 1);
  await atlas.page.goto(`/${ORG}/vendors/scorecards?view=table`);
  await expect(
    atlas.page.getByRole("row").filter({ hasText: "Demo Staging Supply" }).first(),
  ).toBeVisible();
  await expectAccessible(atlas.page);
  await atlas.context.close();

  await transition("engagement", engagement.id, "Active", "Closing", "Show complete.");
  await transition("engagement", engagement.id, "Closing", "Complete", "Paid, waived and scored.");
  const [closed] = await sql<{ state: string }>(
    `select engagement_state::text as state from app.engagements where id = $1`,
    [engagement.id],
  );
  expect(closed?.state).toBe("Complete");
}

/** A Proposed submittal the org asks of the demo vendor on the demo project, created by the Owner. */
async function proposedSubmittal(title: string): Promise<{ id: string }> {
  const vendor = await demoVendorId();
  const [row] = await sql<{ id: string }>(
    `insert into app.submittals (project_id, vendor_id, submittal_kind, title, spec_reference, due_on)
     values ($1, $2, 'Shop Drawing', $3, 'S-201', '2027-05-20') returning id`,
    [PROJECT, vendor, title],
    PEOPLE.owner,
  );
  return { id: row?.id as string };
}

test("R2: the vendor submits, reads the return reason and resubmits a submittal", async ({
  page,
}) => {
  const engagement = await vendorEngagement();
  await transition("engagement", engagement.id, "Onboarding", "Active", "Vendor onboarded.");
  const title = `Delay tower rigging plan ${suffix()}`;
  const submittal = await proposedSubmittal(title);

  await signIn(page, "vendor@example.com", `/work/engagements/${engagement.key}/submittals`);
  const row = page.getByRole("listitem").filter({ hasText: title });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Revision 0");
  await expectAccessibleInBothThemes(page);
  const form = row.getByRole("form", { name: title });
  await form.getByLabel("Note").fill("Rigging plan attached, rev A.");
  await form.getByRole("button", { name: "Submit" }).click();
  await expect(row.getByText("Sent for review.")).toBeVisible();

  // The producer returns it in Atlas: the Owner created it, so sod_approval_requester lets them.
  await asPerson(
    PEOPLE.producer,
    `select app.transition_submittal($1, 'Submitted', 'Returned', $2)`,
    [submittal.id, "Show the bridle points."],
  );
  await page.reload();
  await expect(row.getByText("Returned: Show the bridle points.")).toBeVisible();
  await row.getByRole("form", { name: title }).getByLabel("Note").fill("Bridle points on sheet 2.");
  await row.getByRole("button", { name: "Resubmit" }).click();
  await expect(row.getByText("Sent for review.")).toBeVisible();
  await page.reload();
  await expect(row).toContainText("Revision 1");
  await expect(row.getByText("Submitted. The organization is reviewing it.")).toBeVisible();
  const [stored] = await sql<{ revision: number; state: string }>(
    `select revision, submittal_state::text as state from app.submittals where id = $1`,
    [submittal.id],
  );
  expect(stored).toEqual({ revision: 1, state: "Submitted" });
});

test("R2: the vendor Owner's Credentials tab shows the badges of everyone the account supplies", async ({
  page,
}) => {
  const engagement = await vendorEngagement();
  await transition("engagement", engagement.id, "Onboarding", "Active", "Vendor onboarded.");
  // A second person the account supplies on the project, on an engagement of their own: the tab
  // reads the badges of every engagement the account holds, not only the one it is opened from.
  const [supplied] = await sql<{ id: string }>(
    `insert into app.engagements (project_id, person_id, counterparty_id, role_type, role_code, worker_classification,
       pay_basis, arrangement, start_date, end_date)
     select $1, $2, e.counterparty_id, 'Vendor', '9000.50.02', 'VENDOR_SUPPLIED', 'Day Rate', 'Per Engagement',
       '2027-06-04', '2027-06-06'
     from app.engagements e where e.id = $3
     returning id`,
    [PROJECT, PEOPLE.crew, DEMO.vendorEngagement],
    PEOPLE.owner,
  );
  const suppliedId = supplied?.id as string;
  await transition("engagement", suppliedId, "Onboarding", "Active", "Supplied crew onboarded.");
  const code = `VEN${suffix()}`;
  const category = async (name: string) => {
    const [row] = await sql<{ id: string }>(
      `insert into app.credential_categories (project_id, code, name) values ($1, $2, $3) returning id`,
      [PROJECT, `${code}${name.slice(0, 1)}`, `${name} ${code}`],
      PEOPLE.owner,
    );
    return row?.id as string;
  };
  const [crewBadge, walkUp] = [await category("Vendor Crew"), await category("Walk-up")];
  await sql(
    `insert into app.credentials (credential_category_id, holder_person_id, engagement_id) values ($1, $2, $3)`,
    [crewBadge, PEOPLE.crew, suppliedId],
    PEOPLE.owner,
  );
  // The same person's badge issued under no engagement of the account stays off the account's tab,
  // although the Owner may read it (api_external.credentials opens the person's badges to them).
  await sql(
    `insert into app.credentials (credential_category_id, holder_person_id) values ($1, $2)`,
    [walkUp, PEOPLE.crew],
    PEOPLE.owner,
  );
  try {
    await signIn(page, "vendor@example.com", `/work/engagements/${engagement.key}/credentials`);
    await expect(
      page.getByRole("listitem").filter({ hasText: `Vendor Crew ${code}` }),
    ).toBeVisible();
    await expect(page.getByRole("listitem").filter({ hasText: `Walk-up ${code}` })).toHaveCount(0);
    await expectAccessible(page);
  } finally {
    await transition("engagement", suppliedId, "Active", "Canceled", "Journey finished.");
  }
});

test("R2: the vendor uploads an open document from Compliance and it moves to review", async ({
  page,
}) => {
  const name = `Rigging certificate ${suffix()}`;
  const packet = await requirements("Vendor", [{ name, kind: "Document Upload" }]);
  try {
    const engagement = await vendorEngagement();
    await signIn(page, "vendor@example.com", `/work/engagements/${engagement.key}/compliance`);
    const form = page.getByRole("form", { name });
    await expect(form).toBeVisible();
    await expectAccessibleInBothThemes(page);
    await form.getByLabel("File or photo").setInputFiles({
      name: "certificate.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from(
        "%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n",
      ),
    });
    await form.getByRole("button", { name: "Upload" }).click();
    await expect(page.getByText("Uploaded. The organization verifies it next.")).toBeVisible();
    await page.reload();
    await expect(page.getByRole("form", { name })).toHaveCount(0);
  } finally {
    await packet.retire();
  }
});
