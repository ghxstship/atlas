import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { expect, test, type Browser, type Page } from "./engine-test";
import { ORG, signIn } from "./a16-support";
import { createOrganization, expectAccessible, PASSWORD, testEmail, uniqueId } from "./support";

/**
 * A82 compliance journeys (RRR-127, findings A65-014 and A65-016): the cookie banner and Global
 * Privacy Control (Section 14.3), "16 or older" at sign-up (Sections 14.3 and 14.9), and share links
 * with the Section 8.6 rules and watermark, the Subprocessor List change notice subscription and
 * re-acceptance after a material change (Section 14.4), and the OSHA and WH-347 forms (Section 14.5). The config sends Global Privacy Control so the banner stays out of other journeys;
 * these tests open their own contexts without it.
 */

/** Server actions on a development server can take seconds on first compile. */
const slow = expect.configure({ timeout: 30_000 });

/** A browser context that sends no Global Privacy Control signal. */
async function plainContext(browser: Browser) {
  return browser.newContext({ extraHTTPHeaders: {} });
}

function consentCookie(cookies: { name: string; value: string }[]): string | undefined {
  return cookies.find((c) => c.name === "xos-consent")?.value;
}

test.describe("cookie consent", () => {
  test("the banner asks once, offers equal choices and records the refusal", async ({
    browser,
  }) => {
    const context = await plainContext(browser);
    const page = await context.newPage();
    await page.goto("/auth/sign-in");
    const banner = page.getByRole("region", { name: "Cookies" });
    await expect(banner).toBeVisible();
    await expect(banner.getByRole("button", { name: "Accept all" })).toBeVisible();
    await expect(banner.getByRole("button", { name: "Reject all" })).toBeVisible();
    await expectAccessible(page);
    await banner.getByRole("button", { name: "Reject all" }).click();
    await expect(banner).toHaveCount(0);
    expect(consentCookie(await context.cookies())).toMatch(/^1\.[0-9a-f]{32}\.00\.0$/);
    await page.reload();
    await expect(page.getByRole("region", { name: "Cookies" })).toHaveCount(0);

    // Cookie settings: change the choice; Preferences on.
    await page.goto("/legal/cookie-settings");
    await expect(page.getByRole("heading", { level: 1, name: "Cookie settings" })).toBeVisible();
    await expect(page.getByText("Your choice: Preferences off, Performance off.")).toBeVisible();
    await expect(
      page.getByRole("cell", { name: "Opens the organization you used last." }),
    ).toBeVisible();
    await expectAccessible(page);
    await page.getByLabel(/^Preferences:/).check();
    await page.getByRole("button", { name: "Save choices" }).click();
    await expect(page.getByText("Your choice: Preferences on, Performance off.")).toBeVisible();
    expect(consentCookie(await context.cookies())).toMatch(/\.10\.0$/);
    await context.close();
  });

  test("a browser sending Global Privacy Control never sees the banner and is told why", async ({
    browser,
  }) => {
    const context = await browser.newContext({ extraHTTPHeaders: { "Sec-GPC": "1" } });
    const page = await context.newPage();
    await page.goto("/auth/sign-in");
    await expect(page.getByRole("region", { name: "Cookies" })).toHaveCount(0);
    // The proxy recorded the signal and remembers it for this browser.
    expect(consentCookie(await context.cookies())).toMatch(/\.00\.1$/);
    await page.goto("/legal/cookie-settings");
    await expect(page.getByText(/Your browser sends Global Privacy Control/)).toBeVisible();
    await expect(page.getByLabel(/^Preferences:/)).toBeDisabled();
    await context.close();
  });
});

test.describe("16 or older", () => {
  test("sign-up asks and records the age before the account exists", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const id = uniqueId();
    await page.goto("/auth/sign-up");
    await page.getByLabel(/^Full name$/).fill("Ada Age");
    await page.locator("#signup-email").fill(testEmail("age", id));
    await page.locator("#signup-password").fill(PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(
      page.getByText("Confirm that you are 16 or older. XOS accounts are for people 16 and over."),
    ).toBeVisible();
    await expectAccessible(page);
    // Typed input is kept; ticking the box creates the account.
    await expect(page.locator("#signup-email")).toHaveValue(testEmail("age", id));
    await page.locator("#signup-password").fill(PASSWORD);
    await page.locator("#signup-age").check();
    await page.getByRole("button", { name: "Create account" }).click();
    // The sign-up recorded the age, so creating the org asks only for the terms.
    await page.waitForURL("**/auth/organization");
    await expect(page.locator("#org-age")).toHaveCount(0);
    await createOrganization(page, { name: `Age ${id}`, slug: `age-${id}` });
    await context.close();
  });
});

// Share links ---------------------------------------------------------------------------------------

/** A 2 by 2 PNG, enough for the renderer to embed. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDK+mmyAAAAABJRU5ErkJggg==",
  "base64",
);

/** Stands in for the upload-scan worker's local pass-through (ADR 0034) on attachment scans. */
async function passAttachmentScans() {
  const url = process.env["E2E_SUPABASE_URL"];
  const key = process.env["E2E_SUPABASE_SERVICE_KEY"];
  if (!url || !key)
    throw new Error("Set E2E_SUPABASE_URL and E2E_SUPABASE_SERVICE_KEY to the local stack.");
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url)) throw new Error("Local stack only.");
  const app = createClient(url, key, { auth: { persistSession: false } }).schema("app");
  const { data, error } = await app.rpc("claim_jobs", {
    p_worker: "atlas-e2e-a82",
    p_job_kind: "attachment.scan",
    p_limit: 50,
  });
  if (error) throw new Error(`claim_jobs: ${error.message}`);
  for (const job of (data as { id: string; subject_id: string }[] | null) ?? []) {
    const scanned = await app.rpc("record_attachment_scan", {
      p_attachment_version_id: job.subject_id,
      p_clean: true,
    });
    if (scanned.error) throw new Error(`record_attachment_scan: ${scanned.error.message}`);
    await app.rpc("finish_job", { p_job_id: job.id, p_succeeded: true, p_error: null });
  }
}

/** Opens the first demo document's full record page, where files attach. */
async function openDocument(page: Page) {
  await page.goto(`/${ORG}/knowledge/documents?view=list`);
  await page.getByRole("row").nth(1).getByRole("button", { name: "Open" }).click();
  await page.waitForURL(/peek=/);
  const url = new URL(page.url());
  url.searchParams.set("full", "1");
  await page.goto(url.toString());
  await page.locator("html[data-shell-ready]").waitFor();
}

async function upload(page: Page, name: string, mimeType: string, buffer: Buffer) {
  const files = page.locator("section", {
    has: page.getByRole("heading", { name: "Attachments" }),
  });
  await files.locator('input[type="file"]').setInputFiles({ name, mimeType, buffer });
  await files.getByRole("button", { name: "Upload" }).click();
  await slow(files.getByText(name).first()).toBeVisible();
  await passAttachmentScans();
  await page.reload();
  await page.locator("html[data-shell-ready]").waitFor();
  return page.locator("li", { hasText: name }).first();
}

test.describe("share links", () => {
  test("an Internal link opens without an account; a Confidential image downloads watermarked", async ({
    page,
    browser,
  }) => {
    // Uploads, scans and two renders on a development server: more than the default minute.
    test.setTimeout(480_000);
    const id = uniqueId();
    await signIn(page);
    await openDocument(page);

    // Internal: a link with an expiry, opened in a browser with no session.
    const plan = await upload(
      page,
      `plan-${id}.pdf`,
      "application/pdf",
      Buffer.from("%PDF-1.4\n%a82\n"),
    );
    await plan.getByRole("button", { name: "Share" }).click();
    const panel = page.getByRole("region", { name: `Share plan-${id}.pdf` });
    await slow(panel).toBeVisible();
    await expectAccessible(page);
    await panel.getByRole("button", { name: "Create link" }).click();
    const linkField = panel.getByRole("textbox", { name: "Link" });
    await slow(linkField).toHaveValue(/\/share\/xshr_[0-9a-f]{64}$/);
    const internalUrl = new URL(await linkField.inputValue());

    const visitor = await (await plainContext(browser)).newPage();
    await visitor.goto(internalUrl.pathname);
    await slow(visitor.getByRole("heading", { level: 1, name: "Shared file" })).toBeVisible();
    await expectAccessible(visitor);
    const download = visitor.waitForEvent("download", { timeout: 120_000 });
    await visitor.getByRole("button", { name: "Open file" }).click({ timeout: 120_000 });
    expect((await download).suggestedFilename()).toBe(`plan-${id}.pdf`);

    // Revoked links stop opening.
    await panel.getByRole("button", { name: "Revoke" }).click();
    await slow(panel.getByText("Revoked")).toBeVisible();
    await visitor.goto(internalUrl.pathname);
    await visitor.getByRole("button", { name: "Open file" }).click({ timeout: 120_000 });
    await slow(visitor.getByText("This link does not work.", { exact: false })).toBeVisible();

    // Confidential: classify the image, then a link for one recipient with an access code.
    const stage = await upload(page, `stage-${id}.png`, "image/png", PNG);
    await stage.getByRole("button", { name: "Share" }).click();
    const imagePanel = page.getByRole("region", { name: `Share stage-${id}.png` });
    await imagePanel.getByLabel("Classification").selectOption("Confidential");
    await imagePanel.getByRole("button", { name: "Save classification" }).click();
    await slow(imagePanel.getByText("Classification saved.")).toBeVisible();
    await slow(
      imagePanel.getByText("Confidential files always ask for an access code."),
    ).toBeVisible();
    await imagePanel.getByRole("button", { name: "Create link" }).click();
    await slow(
      imagePanel.getByText("Enter the recipient's email. The watermark carries it."),
    ).toBeVisible();
    await imagePanel.getByLabel("Recipient's email").fill(`ana-${id}@venue.test`);
    await imagePanel.getByRole("button", { name: "Create link" }).click();
    const codeField = imagePanel.getByRole("textbox", { name: "Access code" });
    await slow(codeField).toHaveValue(/^[0-9]{6}$/);
    const code = await codeField.inputValue();
    expect(code).toMatch(/^[0-9]{6}$/);
    const confidentialUrl = new URL(
      await imagePanel.getByRole("textbox", { name: "Link" }).inputValue(),
    );

    await visitor.goto(confidentialUrl.pathname);
    await visitor.getByRole("button", { name: "Open file" }).click({ timeout: 120_000 });
    await slow(visitor.getByText("Enter the access code that came with the link.")).toBeVisible();
    await visitor.getByLabel("Access code").fill(code === "000000" ? "111111" : "000000");
    await visitor.getByRole("button", { name: "Open file" }).click({ timeout: 120_000 });
    await slow(visitor.getByText("That code is not right.", { exact: false })).toBeVisible();
    await visitor.getByLabel("Access code").fill(code);
    const marked = visitor.waitForEvent("download", { timeout: 120_000 });
    await visitor.getByRole("button", { name: "Open file" }).click({ timeout: 120_000 });
    const file = await marked;
    expect(file.suggestedFilename()).toBe(`stage-${id}-watermarked.pdf`);
    const pdf = readFileSync((await file.path()) as string).toString("latin1");
    expect(pdf.startsWith("%PDF-1.7")).toBe(true);
    expect(pdf).toContain(`<pdf:Keywords>Downloaded by ana-${id}@venue.test on`);

    // Restricted files are never shared.
    await imagePanel.getByLabel("Classification").selectOption("Restricted");
    await imagePanel.getByRole("button", { name: "Save classification" }).click();
    await slow(imagePanel.getByText("Restricted files are never shared by link.")).toBeVisible();
  });
});

/** Reads the local stack directly: the outbox keeps a token only until the email is sent. */
async function localSql<T extends pg.QueryResultRow>(sql: string, args: unknown[]): Promise<T[]> {
  const url = process.env["E2E_DATABASE_URL"];
  if (!url || !/@(127\.0\.0\.1|localhost):/.test(url)) {
    throw new Error("Set E2E_DATABASE_URL to the local stack.");
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(sql, args)).rows;
  } finally {
    await client.end();
  }
}

test.describe("subprocessor change notices", () => {
  test("subscribing needs the emailed confirmation, and a notice's link unsubscribes", async ({
    page,
  }) => {
    const email = testEmail("notices", uniqueId());
    await page.goto("/legal/subprocessors");
    const notices = page.getByRole("region", { name: "Change notices" });
    await expect(notices).toBeVisible();
    await expectAccessible(page);
    await notices.getByLabel("Email").fill(email);
    await notices.getByRole("button", { name: "Subscribe" }).click();
    await slow(page.getByText("Check your email and confirm within 7 days")).toBeVisible();
    expect(new URL(page.url()).search).toBe("?notice=subscribed");

    const [queued] = await localSql<{ token: string }>(
      `select args ->> 'confirm_token' as token from private.platform_emails
        where template = 'subprocessor_confirm' and to_email = $1`,
      [email],
    );
    expect(queued?.token).toMatch(/^xspn_[0-9a-f]{64}$/);

    // Opening the link changes nothing; the button does.
    await page.goto(`/legal/subprocessors?confirm=${queued?.token}`);
    await expect(page.getByRole("heading", { name: "Confirm your subscription" })).toBeVisible();
    const [pending] = await localSql<{ state: string }>(
      "select subscription_state as state from private.subprocessor_subscriptions where email = $1",
      [email],
    );
    expect(pending?.state).toBe("Pending");
    await page.getByRole("button", { name: "Confirm subscription" }).click();
    await slow(page.getByText("You are subscribed.")).toBeVisible();
    expect(page.url()).not.toContain("xspn_");

    // A used link says so.
    await page.goto(`/legal/subprocessors?confirm=${queued?.token}`);
    await page.getByRole("button", { name: "Confirm subscription" }).click();
    await slow(page.getByText("This link has expired or was already used.")).toBeVisible();

    // The unsubscribe link a notice carries (issued here as app.queue_subprocessor_notice would).
    const unsubscribe = `xspu_${randomBytes(32).toString("hex")}`;
    await localSql(
      `insert into private.subprocessor_unsubscribe_tokens (token_hash, subscription_id)
       select extensions.digest($1, 'sha256'), id from private.subprocessor_subscriptions where email = $2`,
      [unsubscribe, email],
    );
    await page.goto(`/legal/subprocessors?unsubscribe=${unsubscribe}`);
    await page.getByRole("button", { name: "Unsubscribe" }).click();
    await slow(page.getByText("You are unsubscribed.")).toBeVisible();
    const [ended] = await localSql<{ state: string }>(
      "select subscription_state as state from private.subprocessor_subscriptions where email = $1",
      [email],
    );
    expect(ended?.state).toBe("Unsubscribed");
  });

  test("an Owner receives them by default and can turn them off", async ({ page }) => {
    await signIn(page);
    await page.goto(`/${ORG}/me/notifications`);
    const panel = page.getByRole("region", { name: "Subprocessor List changes" });
    const box = panel.getByLabel("Email me about Subprocessor List changes");
    await expect(box).toBeChecked();
    await box.uncheck();
    await panel.getByRole("button", { name: "Save" }).click();
    await page.reload();
    await slow(box).not.toBeChecked();
    await box.check();
    await panel.getByRole("button", { name: "Save" }).click();
    await page.reload();
    await slow(box).toBeChecked();
  });
});

test.describe("re-acceptance", () => {
  test("an Owner is prompted on every page until the org accepts an announced change", async ({
    page,
  }) => {
    // The platform team announces a change 30 days ahead (migration 1383). The notice applies to
    // every org until it is withdrawn, so this test withdraws it at the end whatever happens.
    const version = `9.${Date.now() % 100000}.0`;
    const [announced] = await localSql<{ id: string }>(
      `select app.announce_legal_change('terms-of-service', $1, 'Org',
         'Clearer limits of liability and a new venue for disputes.', current_date + 30) as id`,
      [version],
    );
    expect(announced?.id).toBeTruthy();
    try {
      await signIn(page);
      const banner = page.getByTestId("reacceptance-banner");
      await expect(banner).toContainText("Terms of Service: a new version takes effect on");
      await expect(banner).toContainText("Accept it for Demo Productions before then.");
      await expectAccessible(page);
      await page.goto(`/${ORG}/projects`);
      await expect(banner).toBeVisible();

      await banner.getByRole("link", { name: "Review and accept in Settings, Legal" }).click();
      await page.waitForURL(`**/${ORG}/settings/legal`);
      const panel = page.getByRole("region", { name: "Changes to accept" });
      await expect(panel.getByText(`Terms of Service ${version}`, { exact: true })).toBeVisible();
      await expect(
        panel.getByText("Clearer limits of liability and a new venue for disputes."),
      ).toBeVisible();
      await expectAccessible(page);
      await panel.getByRole("button", { name: `Accept Terms of Service ${version}` }).click();
      await slow(page.getByRole("region", { name: "Changes to accept" })).toHaveCount(0);
      await expect(page.getByTestId("reacceptance-banner")).toHaveCount(0);
      const [recorded] = await localSql<{ n: number }>(
        `select count(*)::int as n from app.legal_acceptances a
          join app.organizations o on o.id = a.org_id
         where o.slug = $1 and a.document_slug = 'terms-of-service' and a.document_version = $2`,
        [ORG, version],
      );
      expect(recorded?.n).toBe(1);
    } finally {
      await localSql("select app.withdraw_legal_change('terms-of-service', $1)", [version]);
    }
  });
});

test.describe("compliance forms", () => {
  test("an Owner keeps the OSHA log of an establishment and records a case from an incident", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const id = uniqueId();
    const name = `Northwind Shop ${id}`;
    const year = new Date().getUTCFullYear();
    await signIn(page);
    await page.goto(`/${ORG}/settings/locations-and-venues`);
    const panel = page.getByRole("region", { name: "OSHA recordkeeping" });
    await panel.getByText("Add an establishment").click();
    await panel.getByLabel("Establishment name").fill(name);
    await panel.getByLabel("City").first().fill("Miami");
    await panel.getByLabel("State", { exact: true }).fill("FL");
    await panel.getByRole("button", { name: "Add establishment" }).click();
    await slow(panel.getByText(`${name} added.`)).toBeVisible();
    await page.reload();
    const card = page.locator("li", { hasText: name }).first();
    await expect(card.getByText(`Form 300A summary, ${year}`)).toBeVisible();
    await expectAccessible(page);

    const summary = page.waitForEvent("download", { timeout: 120_000 });
    await card
      .locator("form", { hasText: `Form 300A summary, ${year}` })
      .getByRole("button", { name: "PDF" })
      .click();
    const pdf = await summary;
    expect(pdf.suggestedFilename()).toMatch(new RegExp(`^osha-300a-${year}-northwind-shop-`));
    const bytes = readFileSync((await pdf.path()) as string).toString("latin1");
    expect(bytes.startsWith("%PDF-1.7")).toBe(true);
    expect(bytes).toContain("<pdf:Keywords>Downloaded by owner@example.com on");

    // A recordable case from an incident, then its Form 301 and the log.
    const [incident] = await localSql<{ id: string }>(
      `select i.id from app.incidents i join app.organizations o on o.id = i.org_id
        where o.slug = $1 and i.deleted_at is null order by i.created_at limit 1`,
      [ORG],
    );
    await page.goto(`/${ORG}/safety/incidents?peek=${incident?.id}`);
    const cases = page.getByRole("region", { name: "OSHA recordable cases" });
    await slow(cases).toBeVisible();
    await cases.getByText("Record an OSHA case").click();
    await cases.getByLabel("Establishment").selectOption({ label: name });
    await cases.getByLabel("Employee's full name").fill(`Temporary Rigger ${id}`);
    await cases.getByLabel("Job title").fill("Rigger");
    await cases.getByLabel("Date of injury or onset of illness").fill(`${year}-01-05`);
    await cases.getByLabel("Where the event occurred").fill("Loading dock north end");
    await cases
      .getByLabel(/^Injury or illness, parts of body/)
      .fill("Sprained left ankle on the ramp");
    await cases.getByLabel("Most serious outcome").selectOption("Days away from work");
    await cases.getByLabel("Days away from work").fill("3");
    await cases.getByLabel("Injury or illness type").selectOption("Injury");
    await cases.getByRole("button", { name: "Record case" }).click();
    await slow(cases.getByText("Case recorded.")).toBeVisible();
    await page.reload();
    await slow(
      page.getByText(new RegExp(`Temporary Rigger ${id}, Days away from work`)),
    ).toBeVisible();
    const report = page.waitForEvent("download", { timeout: 120_000 });
    await page.getByRole("link", { name: "Form 301" }).first().click();
    expect((await report).suggestedFilename()).toMatch(
      new RegExp(`^osha-301-${year}-\\d{3}\\.pdf$`),
    );

    await page.goto(`/${ORG}/settings/locations-and-venues`);
    const log = page.waitForEvent("download", { timeout: 120_000 });
    await page
      .locator("li", { hasText: name })
      .first()
      .locator("form", { hasText: `Form 300 log, ${year}` })
      .getByRole("button", { name: "CSV" })
      .click();
    const csv = readFileSync((await (await log).path()) as string, "utf8");
    expect(csv.startsWith("(A) Case no.,(B) Employee's name")).toBe(true);
    expect(csv).toContain(`Temporary Rigger ${id},Rigger,${year}-01-05`);
  });

  test("the WH-347 keeps a project's details and asks for step-up before issuing", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await signIn(page);
    await page.goto(`/${ORG}/settings/payroll-and-time-off`);
    const panel = page.getByRole("region", { name: "Certified payroll (WH-347)" });
    await slow(panel).toBeVisible();
    await panel.getByText("Enter or change a project's WH-347 details").click();
    await panel.getByLabel("Project", { exact: true }).selectOption({ index: 0 });
    await panel.getByLabel("Project or contract number").fill("GS-07P-27-0001");
    await panel.getByLabel("Wage determination numbers").fill("FL20270001 Mod 2");
    await panel.getByLabel("Legal business name").fill("Demo Productions LLC");
    await panel.getByLabel("Business address").fill("100 Harbor Way, Miami, FL 33132");
    await panel.getByLabel("Project location").fill("Miami-Dade County, FL");
    await panel.getByRole("button", { name: "Save details" }).click();
    await slow(panel.getByText("Details saved.")).toBeVisible();
    await page.reload();
    await expect(
      page.getByText("Contract GS-07P-27-0001, wage determination FL20270001 Mod 2"),
    ).toBeVisible();
    await expectAccessible(page);
    // Pay rates are Restricted: without a two-step sign-in the database refuses, and says what to do.
    await page.getByRole("button", { name: "Issue as CSV" }).first().click();
    await slow(
      page.getByText("Sign in again with your second step, then issue the certified payroll."),
    ).toBeVisible();
  });
});
