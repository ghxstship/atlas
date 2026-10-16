import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import pg from "pg";

/**
 * Gateway end-to-end support: sign-in as the demo people of the seed (supabase/seeds/0010, shared
 * demo password), axe checks, and SQL fixtures that run as postgres against the local stack to
 * build the states a journey needs (an org issuing a token, publishing an opportunity). Fixtures
 * never run against anything but a local stack.
 */
export const DEMO_PASSWORD = ["xos", "demo", "2026"].join("-");

export const DEMO = {
  org: "01920000-0000-7000-8000-000000000001",
  owner: "01920000-0000-7000-8000-000000000101",
  crew: "01920000-0000-7000-8000-000000000201",
  vendorContact: "01920000-0000-7000-8000-000000000302",
  project: "01920000-0000-7000-8000-000000001001",
  crewEngagement: "01920000-0000-7000-8000-000000228401",
  vendorEngagement: "01920000-0000-7000-8000-000000228402",
  crewEngagementKey: "ENG-01J8000000E008000000025101",
} as const;

const databaseUrl =
  process.env["E2E_DATABASE_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:56922/postgres";
if (!/@(127\.0\.0\.1|localhost):/.test(databaseUrl)) {
  throw new Error("Gateway e2e fixtures run only against a local Supabase stack.");
}

/** Runs SQL as postgres; `asPerson` sets the session person for RPCs that need one. */
export async function sql<T extends Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
  asPerson?: string,
): Promise<T[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("begin");
    if (asPerson) {
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: asPerson, role: "authenticated" }),
      ]);
    }
    const result = await client.query(text, params);
    await client.query("commit");
    return result.rows as T[];
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}

export function uniqueId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** axe-core on the current page: zero serious or critical findings (Section 18, gate 8). */
export async function expectAccessible(page: Page): Promise<void> {
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

/** Checks a page in both themes (Section 11.6: System default, Dark and Light complete). */
export async function expectAccessibleInBothThemes(page: Page): Promise<void> {
  // Color transitions would let axe sample a half-switched theme.
  await page.addStyleTag({
    content: "*, *::before, *::after { transition: none !important; animation: none !important; }",
  });
  for (const theme of ["dark", "light"] as const) {
    await page.evaluate((t) => {
      document.documentElement.dataset["theme"] = t;
    }, theme);
    await expectAccessible(page);
  }
}

/** Signs in with the demo password and waits for the page the sign-in sends to. */
export async function signIn(page: Page, email: string, next = "/home"): Promise<void> {
  await page.goto(`/auth/sign-in?next=${encodeURIComponent(next)}`);
  await page.locator("#signin-email").fill(email);
  await page.locator("#signin-password").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await page.waitForURL((url) => url.pathname === next.split("?")[0]);
}
