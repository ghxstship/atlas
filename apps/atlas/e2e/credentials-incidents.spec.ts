import { expect, test, type Browser, type Page } from "./engine-test";
import { expectAccessible, uniqueId } from "./support";

/**
 * A14 journeys (RRR-57, Section 20.2) on the demo tenant seed (supabase/seeds/0010, 0107, 0114, 0217):
 * 18 (issue a credential by category, configure the access grid, scan it at a zone: allowed and
 * denied), the Atlas half of 16 (a reported incident appears on the dispatch board; closing a critical
 * incident is refused for its reporter and needs another person's sign-off), the emergency codes with a
 * crisis alert and its all-clear, and the radio plan. Every page is checked with axe in both themes and
 * at phone width. Codes and channel numbers are unique per run so reruns never collide.
 */

const ORG = "demo-productions";
const PROJECT = "NWS";
const DEMO_PASSWORD = `xos-demo-${"2026"}`;

test.use({ reducedMotion: "reduce" });
test.setTimeout(180_000);
expect.configure({ timeout: 20_000 });

async function signIn(page: Page, email: string) {
  await page.goto(`/auth/sign-in?next=${encodeURIComponent(`/${ORG}/home`)}`);
  await page.locator("#signin-email").fill(email);
  await page.locator("#signin-password").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await page.waitForURL(`**/${ORG}/home`);
}

async function asPerson(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext({ reducedMotion: "reduce" })).newPage();
  await signIn(page, email);
  return page;
}

/** axe in dark (the default) and light (Section 18, gate 8: both themes). */
async function expectAccessibleInBothThemes(page: Page) {
  await page.waitForTimeout(300);
  await expectAccessible(page);
  await page.context().addCookies([{ name: "xos-theme", value: "light", url: page.url() }]);
  await page.reload();
  await page.waitForTimeout(300);
  await expectAccessible(page);
  await page.context().addCookies([{ name: "xos-theme", value: "dark", url: page.url() }]);
  await page.reload();
}

test.describe("Credentials and the access grid (journey 18)", () => {
  test("issue by category, grant a zone, and scan allowed and denied", async ({ page }) => {
    const id = uniqueId().slice(-6).toUpperCase();
    const code = `E2E-${id}`;
    await signIn(page, "producer@example.com");

    await page.goto(`/${ORG}/credentials/categories?project=${PROJECT}&create=1`);
    await expectAccessibleInBothThemes(page);
    await page.getByLabel("Code", { exact: true }).first().fill(code);
    await page.getByLabel("Name", { exact: true }).first().fill(`Journey ${id}`);
    await page.getByRole("button", { name: "Create category" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: `Category ${code} created.` }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: code })).toBeVisible();

    await page.goto(`/${ORG}/credentials/access-grid?project=${PROJECT}&view=spreadsheet`);
    await expectAccessibleInBothThemes(page);
    await page.locator("#grid-category").selectOption({ label: `${code} · Journey ${id}` });
    await page
      .locator("#grid-zone")
      .selectOption({ label: "LAWN · Festival Lawn · Bayside Festival Grounds" });
    await page.locator("#grid-level").selectOption({ index: 0 });
    await page.getByRole("button", { name: "Grant access" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Access granted." })).toBeVisible();

    await page.goto(`/${ORG}/credentials/access-grid?project=${PROJECT}&view=matrix`);
    await expect(page.getByRole("grid", { name: `Access grid for ${PROJECT}` })).toBeVisible();
    await expectAccessibleInBothThemes(page);

    await page.goto(`/${ORG}/credentials/issued?project=${PROJECT}&create=1`);
    await expectAccessibleInBothThemes(page);
    await page.locator("#issue-category").selectOption({ label: `${code} · Journey ${id}` });
    await page.locator("#issue-holder").selectOption({ label: "Demo Field Lead" });
    await page.getByRole("button", { name: "Issue credential" }).last().click();
    const issued = page.getByRole("status").filter({ hasText: /Issued as CR-\d{6}\./ });
    await expect(issued).toBeVisible();
    const number = /CR-\d{6}/.exec((await issued.textContent()) ?? "")?.[0] ?? "";
    expect(number).not.toBe("");

    await page.goto(`/${ORG}/credentials/scan-log?project=${PROJECT}`);
    await expectAccessibleInBothThemes(page);
    await page
      .locator("#scan-zone")
      .selectOption({ label: "LAWN · Festival Lawn · Bayside Festival Grounds" });
    await page.locator("#scan-number").fill(number);
    await page.getByRole("button", { name: "Check credential" }).click();
    await expect(page.getByRole("status").filter({ hasText: `${number}` })).toContainText(
      "access granted",
    );
    await page
      .locator("#scan-zone")
      .selectOption({ label: "VIP · VIP Terrace · Bayside Festival Grounds" });
    await page.locator("#scan-number").fill(number);
    await page.getByRole("button", { name: "Check credential" }).click();
    await expect(page.getByRole("status").filter({ hasText: `${number}` })).toContainText(
      "access denied",
    );

    await page.locator("#scan-number").fill("CR-999999");
    await page.getByRole("button", { name: "Check credential" }).click();
    await expect(page.getByText("No credential matches that number.")).toBeVisible();

    await page.goto(`/${ORG}/credentials/issued?project=${PROJECT}`);
    await page.getByRole("link", { name: number }).click();
    const peek = page.getByRole("dialog");
    await expect(peek.getByRole("heading", { name: "Demo Field Lead" })).toBeVisible();
    await expect(peek.getByText("Granted").first()).toBeVisible();
    await expectAccessible(page);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("the project tab and every view render, with the board by status", async ({ page }) => {
    await signIn(page, "producer@example.com");
    for (const path of [
      `/${ORG}/p/${PROJECT}/credentials`,
      `/${ORG}/p/${PROJECT}/credentials?section=categories&view=table`,
      `/${ORG}/p/${PROJECT}/credentials?section=access-grid`,
      `/${ORG}/p/${PROJECT}/credentials?section=scan-log&view=list`,
      `/${ORG}/credentials/issued?project=${PROJECT}&view=board`,
    ]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectAccessible(page);
    }
    await page.goto(`/${ORG}/p/ZZZZ/credentials`);
    await expect(page.getByText("Page not found")).toBeVisible();
  });
});

test.describe("Safety incidents (journey 16, Atlas)", () => {
  test("report, see it on the dispatch board, dispatch, and close only with another person's sign-off", async ({
    page,
    browser,
  }) => {
    const title = `Barrier Collapse ${uniqueId()}`;
    await signIn(page, "owner@example.com");

    await page.goto(`/${ORG}/safety/incidents?project=${PROJECT}&create=1`);
    await expectAccessibleInBothThemes(page);
    await page.locator("#incident-title").fill(title);
    await page.locator("#incident-severity").selectOption({ index: 0 });
    await page
      .locator("#incident-zone")
      .selectOption({ label: "LAWN · Festival Lawn · Bayside Festival Grounds" });
    await page.getByRole("button", { name: "File report" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: /Incident filed as number \d+\./ }),
    ).toBeVisible();

    await page.goto(`/${ORG}/safety/dispatch-board?project=${PROJECT}`);
    await expectAccessibleInBothThemes(page);
    await page
      .getByRole("link", { name: new RegExp(title) })
      .first()
      .click();
    const peek = page.getByRole("dialog");
    await expect(peek.getByRole("heading", { name: title })).toBeVisible();
    await peek.locator("#dispatch-member").selectOption({ label: "Demo Field Lead" });
    await peek.getByRole("button", { name: "Dispatch responder" }).click();
    await expect(peek.getByText("Responder dispatched.")).toBeVisible();
    await peek.locator("#reason-Dispatched").fill("Security team sent to the lawn.");
    await peek.getByRole("button", { name: "Mark dispatched" }).click();
    await expect(peek.getByRole("button", { name: "Mark dispatched" })).toHaveCount(0);
    await peek.locator("#reason-Contained").fill("Barrier rebuilt and area cleared.");
    await peek.getByRole("button", { name: "Mark contained" }).click();
    await expect(peek.getByRole("button", { name: "Close with sign-off" })).toBeVisible();

    await peek.locator("#signoff-note").fill("Inspected by the reporter.");
    await peek.getByRole("button", { name: "Close with sign-off" }).click();
    await expect(
      peek.getByText("The reporter of a critical incident cannot sign off its closure."),
    ).toBeVisible();
    const peekUrl = page.url();

    const producer = await asPerson(browser, "producer@example.com");
    await producer.goto(peekUrl.replace(/^https?:\/\/[^/]+/, ""));
    const signoff = producer.getByRole("dialog");
    await signoff.locator("#signoff-note").fill("Barrier inspected and signed off by production.");
    await signoff.getByRole("button", { name: "Close with sign-off" }).click();
    await expect(signoff.getByRole("button", { name: "Close with sign-off" })).toHaveCount(0);
    await producer.reload();
    await expect(
      producer.getByRole("dialog").getByText("Signed off by", { exact: true }),
    ).toBeVisible();
    await expectAccessible(producer);

    await producer.goto(`/${ORG}/safety/incidents?project=${PROJECT}&view=board`);
    await expectAccessible(producer);
    await producer.goto(`/${ORG}/safety/incidents?project=${PROJECT}&view=map`);
    await expect(producer.getByRole("list", { name: "Located incidents" })).toBeVisible();
    await expectAccessible(producer);
  });

  test("medical notes are masked for a person without the medical permission", async ({ page }) => {
    await signIn(page, "producer@example.com");
    await page.goto(`/${ORG}/safety/incidents?project=${PROJECT}`);
    await page
      .getByRole("link", { name: /Guest Fainted Near the VIP Terrace/ })
      .first()
      .click();
    await expect(
      page.getByRole("dialog").getByText("Treatment notes are restricted."),
    ).toBeVisible();
  });
});

test.describe("Emergency codes and the radio plan", () => {
  test("read a protocol, announce and clear a crisis alert, and add a radio channel", async ({
    page,
  }) => {
    await signIn(page, "producer@example.com");
    await page.goto(`/${ORG}/safety/emergency-codes?project=${PROJECT}`);
    await expectAccessibleInBothThemes(page);
    await page.getByRole("link", { name: "Code Red" }).click();
    await expect(page.getByRole("dialog").getByRole("heading", { name: "Code Red" })).toBeVisible();
    await expectAccessible(page);
    await page.keyboard.press("Escape");

    const message = `Drill ${uniqueId()}: hold positions and await instructions.`;
    await page.locator("#alert-code").selectOption({ value: "CODE_BLUE" });
    await page.locator("#alert-message").fill(message);
    await page.getByRole("button", { name: "Announce alert" }).click();
    const alert = page.getByRole("listitem").filter({ hasText: message });
    await expect(alert).toBeVisible();
    await alert.getByRole("button", { name: "Give the all-clear" }).click();
    await expect(page.getByRole("listitem").filter({ hasText: message })).toHaveCount(0);

    const channel = String(100 + Math.floor(Math.random() * 800));
    await page.goto(`/${ORG}/safety/radio-channels?project=${PROJECT}&create=1`);
    await expectAccessibleInBothThemes(page);
    await page.locator("#channel-number").fill(channel);
    await page.locator("#channel-name").fill(`Drill ${channel}`);
    await page.getByRole("button", { name: "Add channel" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: `Channel ${channel} added.` }),
    ).toBeVisible();
    await page.locator("#channel-number").fill(channel);
    await page.locator("#channel-name").fill("Duplicate");
    await page.getByRole("button", { name: "Add channel" }).click();
    await expect(page.getByText("That value is already used.")).toBeVisible();
  });

  test("pages hold at phone width", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await signIn(page, "producer@example.com");
    for (const path of [
      `/${ORG}/credentials/issued?project=${PROJECT}`,
      `/${ORG}/safety/incidents?project=${PROJECT}`,
      `/${ORG}/safety/radio-channels?project=${PROJECT}`,
    ]) {
      await page.goto(path);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      await expectAccessible(page);
    }
  });
});
