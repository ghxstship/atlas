import AxeBuilder from "@axe-core/playwright";
import { createHmac } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import pg from "pg";

/**
 * Console journey support: SQL fixtures as postgres against the local stack only, operators made fresh for each
 * run, the authenticator app every operator needs (RFC 6238 codes from the setup key the page shows, so no secret
 * is stored anywhere), and axe checks in both themes.
 */
export const DEMO_PASSWORD = ["xos", "demo", "2026"].join("-");

export const DEMO = {
  org: "01920000-0000-7000-8000-000000000001",
  orgSlug: "demo-productions",
  owner: "01920000-0000-7000-8000-000000000101",
  crew: "01920000-0000-7000-8000-000000000201",
  project: "01920000-0000-7000-8000-000000001001",
  requisition: "01920000-0000-7000-8000-000000228001",
} as const;

const databaseUrl =
  process.env["E2E_DATABASE_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:55422/postgres";
if (!/@(127\.0\.0\.1|localhost):/.test(databaseUrl)) {
  throw new Error("Console e2e fixtures run only against a local Supabase stack.");
}

export const ATLAS_URL = process.env["E2E_ATLAS_URL"] ?? "http://127.0.0.1:3006";
export const GATEWAY_URL = process.env["E2E_GATEWAY_URL"] ?? "http://127.0.0.1:3127";

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

/** A fresh XOS account with the demo password (seed 0010's pattern); returns its email. */
export async function newAccount(label: string, fullName: string): Promise<string> {
  const email = `${label}-${uniqueId()}@console-e2e.test`;
  await sql(
    `with u as (
       insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
         raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token,
         email_change_token_new, email_change)
       values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated', $1,
         extensions.crypt($3, extensions.gen_salt('bf')), now(),
         '{"provider": "email", "providers": ["email"]}'::jsonb, jsonb_build_object('full_name', $2::text), now(), now(),
         '', '', '', '')
       returning id, email)
     insert into auth.identities (id, user_id, provider_id, provider, identity_data, created_at, updated_at)
     select u.id, u.id, u.id::text, 'email', jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
       now(), now() from u`,
    [email, fullName, DEMO_PASSWORD],
  );
  await sql(
    `update app.people p set id = p.user_id from auth.users u where u.id = p.user_id and u.email = $1`,
    [email],
  );
  return email;
}

export type Role = "Support" | "Trust and Safety" | "Administrator";

/** A fresh platform operator, named by the platform as the owner names the first Administrator. */
export async function newOperator(role: Role, fullName: string): Promise<string> {
  const email = await newAccount(role.toLowerCase().replace(/ /g, "-"), fullName);
  await sql(
    `select private.grant_platform_operator($1, $2::app.platform_operator_role, 'Console journey.')`,
    [email, role],
  );
  return email;
}

function base32(secret: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of secret.replace(/=+$/, "").toUpperCase()) {
    bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** The code an authenticator app shows for a setup key. */
export function totp(secret: string, windows = 0): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + windows));
  const digest = createHmac("sha1", base32(secret)).update(counter).digest();
  const offset = (digest[digest.length - 1] as number) & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

/** Signs in to the console with the demo password; stops on whatever page sign-in leads to. */
export async function passwordSignIn(page: Page, email: string, next = "/tenants"): Promise<void> {
  await page.goto(`/auth/sign-in?next=${encodeURIComponent(next)}`);
  await page.locator("#signin-email").fill(email);
  await page.locator("#signin-password").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

/**
 * Signs a fresh operator in and sets up their authenticator app, as the second factor page asks every operator
 * without one. Returns the setup key for later codes.
 */
export async function signInOperator(
  page: Page,
  email: string,
  next = "/tenants",
): Promise<string> {
  await passwordSignIn(page, email, next);
  await page.waitForURL("**/auth/second-factor**");
  await expect(page.getByRole("heading", { name: "Set up a second factor" })).toBeVisible();
  await page.getByRole("button", { name: "Set up authenticator app" }).click();
  const key = page.getByTestId("setup-key");
  await expect(key).toBeVisible();
  const secret = ((await key.textContent()) ?? "").trim();
  expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
  await page.getByLabel("Code", { exact: true }).fill(totp(secret));
  await page.getByRole("button", { name: "Verify and turn on" }).click();
  await page.waitForURL((url) => url.pathname === next.split("?")[0]);
  return secret;
}

/** axe-core on the page at rest in Dark and Light: no serious or critical finding (Section 18, gate 8). */
export async function expectAccessibleInBothThemes(page: Page): Promise<void> {
  await page.mouse.move(0, 0);
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
  await page.evaluate(() => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(
      "*, *::before, *::after { transition: none !important; animation: none !important; }",
    );
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  });
  for (const theme of ["dark", "light"] as const) {
    await page.evaluate((t) => {
      document.documentElement.dataset["theme"] = t;
    }, theme);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    const blocking = results.violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    );
    expect(
      blocking.map((v) => `${theme} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
    ).toEqual([]);
  }
}

/** A published, invited Crew listing of the demo org that the demo crew person reports (notice and action). */
export async function reportedListing(): Promise<{ id: string; title: string }> {
  const title = `Festival Riggers ${uniqueId().slice(-4).toUpperCase()}`;
  const [row] = await sql<{ id: string }>(
    `insert into app.opportunities (project_id, requisition_id, role_type, role_code, title, description, visibility,
       rate_type, pay_min_minor, pay_max_minor, currency_code, starts_on, ends_on, deadline_at)
     values ($1, $2, 'Crew', '5000.51.02', $3, 'Riggers for the main stage. A registration fee is due to apply.',
       'Invited', 'Day', 85000, 95000, 'USD', '2027-06-04', '2027-06-06', now() + interval '30 days')
     returning id`,
    [DEMO.project, DEMO.requisition, title],
    DEMO.owner,
  );
  const id = row?.id as string;
  await sql(
    `insert into app.opportunity_invitations (opportunity_id, person_id) values ($1, $2)`,
    [id, DEMO.crew],
    DEMO.owner,
  );
  for (const [from, to] of [
    ["Draft", "Pending Approval"],
    ["Pending Approval", "Published"],
  ] as const) {
    await sql(
      `select private.transition_lifecycle('opportunity', 'app.opportunities', 'opportunity_state', 'app.opportunity_state_transitions',
         'opportunity_id', $1::uuid, $2, $3, 'Console journey.')`,
      [id, from, to],
      DEMO.owner,
    );
  }
  await sql(
    `insert into app.listing_reports (opportunity_id, reason, details) values ($1, 'Fraud', 'It asks for a fee to apply.')`,
    [id],
    DEMO.crew,
  );
  return { id, title };
}
