import { toDisplayKey } from "@xos/data/gateway-keys";
import { expect, test } from "./engine-test";
import { addCrewOnboardingUpload, publishCrewOpportunity, sendCrewAgreement } from "./fixtures";
import {
  DEMO,
  expectAccessible,
  expectAccessibleInBothThemes,
  reloadSettled,
  signIn,
  sql,
  uniqueId,
} from "./support";

/**
 * Crew journeys on Gateway, external side (Section 20.2, journeys 41 and 55): find an opportunity
 * from Home, apply with the org's question and availability, follow and withdraw it under
 * Applications, sign the agreement the org sent and answer the org in Messages. Every step is
 * checked with axe.
 */
test("a crew member finds an opportunity, applies and withdraws", async ({ page }) => {
  const opportunity = await publishCrewOpportunity();
  await signIn(page, "crew@example.com");

  await page.getByRole("searchbox", { name: "Search opportunities" }).fill(opportunity.title);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/explore\?/);
  await expectAccessible(page);
  await page.getByRole("link", { name: opportunity.title }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: opportunity.title })).toBeVisible();
  await expectAccessibleInBothThemes(page);

  const form = page.getByRole("form", { name: /^Apply for / });
  await form.getByRole("button", { name: "Send application" }).click();
  await expect(form.getByText("Confirm your availability to send the application.")).toBeVisible();

  await form.getByLabel(opportunity.question).fill("Two festival main stages and an arena tour.");
  await form.getByLabel("I am available for these dates").check();
  await form.getByRole("button", { name: "Send application" }).click();
  await expect(page.getByText("Application sent. Follow it under Applications.")).toBeVisible();
  await expectAccessible(page);

  await page.goto("/work/applications?view=list");
  const card = page.getByRole("listitem").filter({ hasText: opportunity.title });
  await expect(card).toBeVisible();
  await expectAccessible(page);
  await card.getByRole("button", { name: "Withdraw" }).click();
  await expect(card.getByText("Withdrawn").first()).toBeVisible();
});

test("a crew member signs the agreement the org sent from Home", async ({ page }) => {
  const agreement = await sendCrewAgreement();
  await signIn(page, "crew@example.com");
  const row = page.getByRole("listitem").filter({ hasText: `Sign ${agreement.title}` });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Sign", exact: true }).click();
  await expect(row.getByText("Signed. The organization countersigns next.")).toBeVisible();
  await reloadSettled(page);
  await expect(page.getByText(`Sign ${agreement.title}`)).toHaveCount(0);
  await expectAccessible(page);
});

test("a crew member uploads an onboarding document", async ({ page }) => {
  const step = await addCrewOnboardingUpload();
  await signIn(page, "crew@example.com", `/work/engagements/${DEMO.crewEngagementKey}/onboarding`);
  const form = page.getByRole("form", { name: step.name });
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
});

test("a crew member answers the org in Messages", async ({ page }) => {
  const reply = `Confirmed for the November weekends ${uniqueId()}.`;
  await signIn(page, "crew@example.com", "/messages");
  await expectAccessible(page);
  await page
    .getByRole("link", { name: /Availability for the Fall Season/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/messages\/THR-/);
  await expect(page.getByText("I am open most weekends in November")).toBeVisible();
  await expectAccessibleInBothThemes(page);

  const composer = page.getByRole("form", { name: "Reply" });
  await composer.getByLabel("Message").fill(reply);
  await composer.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText(reply)).toBeVisible();
  await expect(composer.getByLabel("Message")).toHaveValue("");
});

test("R2: Up Next shows the call time, the venue and the contact", async ({ page }) => {
  // An Active crew engagement for the demo crew person that starts today, so Up Next picks it, with
  // its onboarding verified the way Atlas records it, and a Published shift as the next call.
  const [today] = await sql<{ d: string }>(`select private.project_today($1)::text as d`, [
    DEMO.project,
  ]);
  const [engagement] = await sql<{ id: string }>(
    `insert into app.engagements (project_id, person_id, role_type, role_code, worker_classification, pay_basis,
       arrangement, start_date, end_date)
     values ($1, $2, 'Crew', '5000.51.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', $3::date, $3::date + 2)
     returning id`,
    [DEMO.project, DEMO.crew, today?.d],
    DEMO.owner,
  );
  const id = engagement?.id as string;
  await sql(
    `insert into app.onboarding_verifications (onboarding_item_id, org_id, outcome)
     select i.id, i.org_id, 'Passed' from app.onboarding_items i where i.engagement_id = $1 and i.deleted_at is null`,
    [id],
    DEMO.owner,
  );
  const move = (from: string, to: string) =>
    sql(
      `select private.transition_lifecycle('engagement', 'app.engagements', 'engagement_state', 'app.engagement_state_transitions',
         'engagement_id', $1::uuid, $2, $3, 'Moved by the journey fixture.')`,
      [id, from, to],
      DEMO.owner,
    );
  await move("Onboarding", "Active");
  const [shift] = await sql<{ id: string; starts_ms: number }>(
    `insert into app.shifts (project_id, engagement_id, role_code, starts_at, ends_at, time_zone)
     values ($1, $2, '5000.51.02', now() + interval '30 minutes', now() + interval '8 hours', 'America/New_York')
     returning id, (extract(epoch from starts_at) * 1000)::float8 as starts_ms`,
    [DEMO.project, id],
    DEMO.owner,
  );
  // What the card should say: the shift in its own zone (the default display), the project's venue
  // and the member who set up the engagement.
  const [place] = await sql<{ venue: string | null; contact: string | null }>(
    `select v.name as venue, cp.full_name as contact
       from app.engagements e join app.projects p on p.id = e.project_id
       left join app.venues v on v.id = p.venue_id and v.deleted_at is null
       left join app.people cp on cp.id = e.created_by
      where e.id = $1`,
    [id],
  );
  const callAt = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
    timeZoneName: "short",
  }).format(new Date(shift?.starts_ms as number));
  await sql(
    `select private.transition_lifecycle('shift', 'app.shifts', 'shift_state', 'app.shift_state_transitions', 'shift_id',
       $1::uuid, 'Draft', 'Published', 'Published to the crew.')`,
    [shift?.id],
    DEMO.owner,
  );
  try {
    await signIn(page, "crew@example.com", "/home");
    const card = page.getByRole("region", { name: "Up next" });
    const value = (term: RegExp) =>
      card.getByRole("term").filter({ hasText: term }).locator("xpath=following-sibling::dd[1]");
    expect(place?.venue).toBeTruthy();
    expect(place?.contact).toBeTruthy();
    await expect(value(/^Shift$/)).toHaveText(callAt);
    await expect(value(/^Where$/)).toContainText(place?.venue as string);
    await expect(value(/^Contact$/)).toContainText(place?.contact as string);
    await expect(card.getByRole("link", { name: "Message" })).toHaveAttribute(
      "href",
      `/work/engagements/${toDisplayKey("engagement", id)}/messages`,
    );
    await expectAccessible(page);
  } finally {
    await move("Active", "Canceled");
  }
});
