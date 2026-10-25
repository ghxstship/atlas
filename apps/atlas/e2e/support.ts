import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page } from "@playwright/test";
import pg from "pg";
import { settle } from "./engine-test";

/** Unique test identities so runs never collide on the shared local stack. */
export function uniqueId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function testEmail(label: string, id: string): string {
  return `${label}-${id}@atlas-e2e.test`;
}

export const PASSWORD = `E2e-${"passphrase"}-9431`;

/** The zone a new project starts in (the New project form's default, components/projects/projects-page.tsx). */
export const NEW_PROJECT_TIME_ZONE = "America/New_York";

/**
 * Today's calendar date in a time zone, as `YYYY-MM-DD` (A71, RRR-116). Times a journey types into a
 * project's forms are that project's local times, so "today" is the project's date, never the UTC date
 * `toISOString()` gives, which runs a day ahead every evening in New York.
 */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** axe-core on the current page: zero serious or critical findings (Section 18, gate 8). */
export async function expectAccessible(page: Page): Promise<void> {
  // axe measures the resting state; a pointer left on a button after a click would measure its hover
  // colors instead (hover contrast is tracked separately, finding A24-004).
  await page.mouse.move(0, 0);
  // Drawers and dialogs fade in; Firefox runs the fade even under reduced motion, and axe would
  // sample the half-faded colors (finding A24-008). The page goes quiet and paints twice, so a
  // drawer that just mounted has started its fade, and finite animations finish first.
  await settle(page);
  await page.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
  await page
    .waitForFunction(
      () =>
        document
          .getAnimations()
          .every((a) => a.playState !== "running" || a.effect?.getTiming().iterations === Infinity),
      undefined,
      { timeout: 5_000 },
    )
    .catch(() => undefined);
  // Next streams the page's metadata, so on a loaded runner the title can land after the body; axe's
  // document-title rule would then fail a page that has one (run 40123982182). A page with no title
  // still fails once this wait gives up.
  await page
    .waitForFunction(() => document.title.trim() !== "", undefined, { timeout: 10_000 })
    .catch(() => undefined);
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  const blocking = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  expect(
    blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
  ).toEqual([]);
}

/** Signs up through the UI with a password; lands wherever `next` sends the new account. */
export async function signUp(page: Page, input: { name: string; email: string; next?: string }) {
  await page.goto(
    input.next ? `/auth/sign-up?next=${encodeURIComponent(input.next)}` : "/auth/sign-up",
  );
  await expectAccessible(page);
  await page.getByLabel(/^Full name$/).fill(input.name);
  await page.locator("#signup-email").fill(input.email);
  await page.locator("#signup-password").fill(PASSWORD);
  await page.locator("#signup-age").check();
  await page.getByRole("button", { name: "Create account" }).click();
}

/** Creates an org through the UI and waits for its Home. */
export async function createOrganization(page: Page, input: { name: string; slug: string }) {
  await page.waitForURL("**/auth/organization");
  await expectAccessible(page);
  await page.getByLabel("Organization name").fill(input.name);
  await page.getByLabel("Web address").fill(input.slug);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create organization" }).click();
  await page.waitForURL(`**/${input.slug}/home`);
}

/**
 * Ends a new org's 14-day Pro trial the way the hourly lifecycle job does when no card was added
 * (private.expire_trial, migration 1350): the org moves to the Access plan. For journeys about the
 * Access plan's limits. Runs as postgres against the local stack only (E2E_DATABASE_URL).
 */
export async function endTrial(slug: string): Promise<void> {
  const url =
    process.env["E2E_DATABASE_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:55422/postgres";
  if (!/@(127\.0\.0\.1|localhost):/.test(url)) throw new Error("Only a local stack is changed.");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rowCount } = await client.query(
      `select private.expire_trial(s.id) from app.subscriptions s
         join app.organizations o on o.id = s.org_id
        where o.slug = $1 and s.subscription_state = 'trialing' and s.deleted_at is null`,
      [slug],
    );
    expect(rowCount).toBe(1);
  } finally {
    await client.end();
  }
}

/**
 * Opens a closed group of choices in a settings form (a long checkbox list, a notification category; gate 27 keeps
 * them behind their summary), named by the title its summary shows, so its boxes can be checked.
 */
export async function openChoices(scope: Page | Locator, title: string): Promise<void> {
  const summary = scope.locator("summary").filter({ hasText: title });
  await summary.click();
  await expect(summary.locator("xpath=..")).toHaveAttribute("open", "");
}
