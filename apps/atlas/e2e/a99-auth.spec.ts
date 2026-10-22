import { createHash, randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect as baseExpect, test, type Browser, type Page } from "@playwright/test";
import pg from "pg";
import {
  createOrganization,
  expectAccessible,
  PASSWORD,
  signUp,
  testEmail,
  uniqueId,
} from "./support";
import { enrollAuthenticator, totp } from "./totp";

/**
 * A99 journeys (RRR-144, ADR 0055): recovery codes at sign-in and in step-up, a spent code refused; signed-in sessions
 * listed and signed out; step-up on a role change and on API key creation; OAuth 2.1 consent with PKCE, token
 * exchange, refresh, API access within the granted groups, step-up for a Restricted group, and revocation. Each
 * journey signs up a fresh Owner in a fresh org, so runs never collide and the demo tenant keeps no second factor.
 *
 * Two steps reach the local stack directly, as other journeys do (pseudo-checks.ts, a36-support.ts): the billing
 * service's plan change (service role, E2E_SUPABASE_URL and E2E_SUPABASE_SERVICE_KEY) for the API key panel, and
 * ageing a session's second factor past the 15-minute step-up window (E2E_DATABASE_URL), which a journey cannot wait
 * out. Both refuse anything but a local address.
 */

// Each journey runs many first-time server actions against next dev; on a loaded machine they compile slowly.
test.use({ reducedMotion: "reduce", actionTimeout: 60_000 });
test.setTimeout(480_000);
const expect = baseExpect.configure({ timeout: 60_000 });

const LOCAL = /^(http|postgresql):\/\/([^@/]*@)?(127\.0\.0\.1|localhost):\d+/;

async function newOwner(page: Page, label: string) {
  const id = uniqueId();
  const slug = `${label}-${id}`;
  const email = testEmail(label, id);
  await signUp(page, { name: "Rhea Recovery", email });
  await createOrganization(page, { name: `Follow Up ${id}`, slug });
  return { slug, email, id };
}

async function signInWithPassword(page: Page, email: string, next: string) {
  await page.goto(`/auth/sign-in?next=${encodeURIComponent(next)}`);
  await page.locator("#signin-email").fill(email);
  await page.locator("#signin-password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in with password" }).click();
}

/** The access token in the page's session cookie (`xos-auth`, possibly chunked, base64 JSON). */
async function sessionCookie(page: Page) {
  const cookies = await page.context().cookies();
  const parts = cookies
    .filter((c) => c.name === "xos-auth" || /^xos-auth\.\d+$/.test(c.name))
    .sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
  const raw = parts.map((c) => c.value).join("");
  const json = JSON.parse(
    Buffer.from(raw.replace(/^base64-/, ""), "base64url").toString("utf8"),
  ) as {
    access_token: string;
    expires_at: number;
  };
  return { parts, json };
}

/**
 * Moves the session's second factor 20 minutes into the past and makes the next request refresh the token, so the
 * session stays aal2 but its second factor is no longer recent: what 15 minutes of work would do.
 */
async function ageSecondFactor(page: Page) {
  const url =
    process.env["E2E_DATABASE_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:55422/postgres";
  if (!LOCAL.test(url)) throw new Error("Ageing a second factor runs against a local stack only.");
  const { parts, json } = await sessionCookie(page);
  const claims = JSON.parse(
    Buffer.from(json.access_token.split(".")[1] ?? "", "base64url").toString(),
  ) as {
    session_id: string;
  };
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(
      "update auth.mfa_amr_claims set updated_at = now() - interval '20 minutes' where session_id = $1",
      [claims.session_id],
    );
  } finally {
    await client.end();
  }
  // Same digits, same length: the chunks keep their boundaries.
  const due = String(Math.floor(Date.now() / 1000) - 120).padStart(
    String(json.expires_at).length,
    "0",
  );
  const raw = parts.map((c) => c.value).join("");
  const decoded = Buffer.from(raw.replace(/^base64-/, ""), "base64url").toString("utf8");
  const updated = `base64-${Buffer.from(
    decoded.replace(`"expires_at":${json.expires_at}`, `"expires_at":${due}`),
  ).toString("base64url")}`;
  let offset = 0;
  await page.context().addCookies(
    parts.map((c) => {
      const value = updated.slice(offset, offset + c.value.length);
      offset += c.value.length;
      return { ...c, value };
    }),
  );
  const status = await page.request.get("/auth/session");
  expect(status.status()).toBe(200);
}

/** The billing service's plan change, so the org may hold API keys (Pro and above). */
async function upgradeToPro(slug: string) {
  const url = process.env["E2E_SUPABASE_URL"];
  const key = process.env["E2E_SUPABASE_SERVICE_KEY"];
  if (!url || !key)
    throw new Error("Set E2E_SUPABASE_URL and E2E_SUPABASE_SERVICE_KEY to the local stack.");
  if (!LOCAL.test(url)) throw new Error("The plan change runs against a local stack only.");
  const app = createClient(url, key, { auth: { persistSession: false } }).schema("app");
  const { data: org } = await app.from("organizations").select("id").eq("slug", slug).single();
  const { error } = await app
    .from("subscriptions")
    .update({ plan_code: "pro" })
    .eq("org_id", org?.id ?? "");
  if (error) throw new Error(`plan change: ${error.message}`);
}

async function inviteMember(page: Page, browser: Browser, slug: string, id: string) {
  const email = testEmail("member", id);
  await page.goto(`/${slug}/settings/members`);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByRole("button", { name: "Create invite" }).click();
  const link = page.getByRole("textbox", { name: "Invitation link", exact: true });
  await expect(link).toHaveValue(/\/auth\/invite\//);
  const invite = new URL(await link.inputValue());
  const member = await (await browser.newContext()).newPage();
  await member.goto(invite.pathname);
  await member.getByLabel(/^Full name$/).fill("Milo Member");
  await member.locator("#signup-email").fill(email);
  await member.locator("#signup-password").fill(PASSWORD);
  await member.locator("#signup-age").check();
  await member.getByRole("button", { name: "Create account" }).click();
  await expect(member.getByRole("heading", { name: /^Join / })).toBeVisible({ timeout: 60_000 });
  await member.getByRole("button", { name: "Accept invitation" }).click();
  await member.waitForURL(`**/${slug}/home`);
  await member.context().close();
}

test("recovery codes: made once, used at sign-in and in step-up, a spent code refused", async ({
  page,
}) => {
  const { slug, email } = await newOwner(page, "recovery");
  await page.goto(`/${slug}/me/security`);
  const recovery = page.getByRole("region", { name: "Recovery codes" });
  await expect(
    recovery.getByText("Set up an authenticator app or a security key first.", { exact: false }),
  ).toBeVisible();

  // A second factor first; enrolling it is a recent second factor, so making codes asks nothing more.
  const factors = page.getByRole("region", { name: "Two-step verification" });
  await factors.getByRole("button", { name: "Set up authenticator app" }).click();
  await enrollAuthenticator(factors, "Work phone");
  await expect(recovery.getByRole("button", { name: "Make recovery codes" })).toBeVisible();
  await recovery.getByRole("button", { name: "Make recovery codes" }).click();
  const list = recovery.getByRole("list", { name: "Your recovery codes" });
  await expect(list.getByRole("listitem")).toHaveCount(10);
  const codes = await list.getByRole("listitem").allTextContents();
  for (const code of codes) expect(code).toMatch(/^[0-9a-hjkmnp-tv-z]{5}-[0-9a-hjkmnp-tv-z]{5}$/);
  await expectAccessible(page);
  await recovery.getByRole("button", { name: "I saved them" }).click();
  await expect(recovery.getByText("10 of 10 codes left", { exact: false })).toBeVisible();

  // Sign in again: the challenge takes a recovery code instead of the app.
  await page.context().clearCookies();
  await signInWithPassword(page, email, `/${slug}/home`);
  await page.waitForURL("**/auth/mfa?**");
  await page.getByRole("button", { name: "Use a recovery code instead" }).click();
  await expectAccessible(page);
  await page.getByLabel("Recovery code", { exact: true }).fill((codes[0] as string).toUpperCase());
  await page.getByRole("button", { name: "Use code" }).click();
  await page.waitForURL(`**/${slug}/home`);

  // The same code never works twice.
  await page.context().clearCookies();
  await signInWithPassword(page, email, `/${slug}/home`);
  await page.waitForURL("**/auth/mfa?**");
  await page.getByRole("button", { name: "Use a recovery code instead" }).click();
  await page.getByLabel("Recovery code", { exact: true }).fill(codes[0] as string);
  await page.getByRole("button", { name: "Use code" }).click();
  await expect(
    page.getByText("That recovery code didn't match, or it was already used."),
  ).toBeVisible();
  await page.getByLabel("Recovery code", { exact: true }).fill(codes[1] as string);
  await page.getByRole("button", { name: "Use code" }).click();
  await page.waitForURL(`**/${slug}/home`);

  // Step-up: once the second factor is older than 15 minutes, making new codes asks again, and a code answers it.
  await ageSecondFactor(page);
  await page.goto(`/${slug}/me/security`);
  await expect(recovery.getByText("8 of 10 codes left", { exact: false })).toBeVisible();
  await recovery.getByRole("button", { name: "Make new codes" }).click();
  await page
    .getByRole("dialog", { name: "Make new recovery codes?" })
    .getByRole("button", { name: "Make new codes" })
    .click();
  const stepUp = page.getByRole("dialog", { name: "Confirm it's you" });
  await expect(stepUp).toBeVisible();
  await stepUp.getByRole("button", { name: "Use a recovery code instead" }).click();
  await expectAccessible(page);
  await stepUp.getByLabel("Recovery code", { exact: true }).fill(codes[1] as string);
  await stepUp.getByRole("button", { name: "Use code" }).click();
  await expect(
    stepUp.getByText("That recovery code didn't match, or it was already used."),
  ).toBeVisible();
  await stepUp.getByLabel("Recovery code", { exact: true }).fill(codes[2] as string);
  await stepUp.getByRole("button", { name: "Use code" }).click();
  await expect(stepUp).toBeHidden();
  const fresh = recovery.getByRole("list", { name: "Your recovery codes" });
  await expect(fresh.getByRole("listitem")).toHaveCount(10);
  expect(await fresh.getByRole("listitem").allTextContents()).not.toContain(codes[3]);
});

test("sessions and devices: list where you're signed in and sign out the others", async ({
  page,
  browser,
}) => {
  const { slug, email } = await newOwner(page, "sessions");
  const other = await (await browser.newContext()).newPage();
  await signInWithPassword(other, email, `/${slug}/home`);
  await other.waitForURL(`**/${slug}/home`);

  await page.goto(`/${slug}/me/security`);
  const sessions = page.getByRole("region", { name: "Sessions and devices" });
  const list = sessions.getByRole("list", { name: "Sessions and devices" });
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await expect(list.getByRole("listitem").first().getByText("This device")).toBeVisible();
  await expect(list.getByRole("listitem").first()).toContainText(/Chrome|Firefox|Safari|A browser/);
  await expect(list.getByRole("listitem").first()).toContainText("Atlas");
  await expectAccessible(page);

  // Sign out the other browser's session: it is signed out at once.
  await list
    .getByRole("listitem")
    .nth(1)
    .getByRole("button", { name: /^Sign out / })
    .click();
  const confirm = page.getByRole("dialog", { name: /^Sign out of / });
  await expectAccessible(page);
  await confirm.getByRole("button", { name: "Sign out" }).click();
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await other.goto(`/${slug}/home`);
  await other.waitForURL("**/auth/sign-in?**");

  // Sign in there again, then sign out every other session.
  await signInWithPassword(other, email, `/${slug}/home`);
  await other.waitForURL(`**/${slug}/home`);
  await page.reload();
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await sessions.getByRole("button", { name: "Sign out all other sessions" }).click();
  await page
    .getByRole("dialog", { name: "Sign out of every other session?" })
    .getByRole("button", { name: "Sign out all other sessions" })
    .click();
  await expect(sessions.getByText("You're signed in only here.")).toBeVisible();
  await other.goto(`/${slug}/home`);
  await other.waitForURL("**/auth/sign-in?**");
  await other.context().close();
});

test("step-up on API key creation and on a role change", async ({ page, browser }) => {
  const { slug, id } = await newOwner(page, "stepup");
  await upgradeToPro(slug);
  await inviteMember(page, browser, slug, id);

  // API key: the Owner has no second factor, so the dialog sets one up, then the key is created and shown once.
  await page.goto(`/${slug}/settings/api-keys-and-service-accounts`);
  const keys = page.getByRole("region", { name: "API keys" });
  await keys.getByLabel("Name", { exact: true }).fill("Payroll sync");
  await keys.getByLabel("Crew", { exact: true }).check();
  await keys.getByRole("button", { name: "Create API key" }).click();
  const setUp = page.getByRole("dialog", { name: "Set up a second factor" });
  await expect(setUp).toBeVisible();
  await expectAccessible(page);
  const secret = await enrollAuthenticator(setUp);
  await expect(setUp).toBeHidden();
  await expect(keys.getByLabel("API key", { exact: true })).toHaveValue(/^xos_live_[0-9a-f]{48}$/);
  await keys.getByRole("button", { name: "I saved it" }).click();
  await expect(keys.getByRole("list", { name: "API keys" })).toContainText("Payroll sync");

  // Role change, 15 minutes later in effect: the dialog asks for the app's code, then the change goes through.
  await ageSecondFactor(page);
  await page.goto(`/${slug}/settings/members`);
  const role = page.getByLabel("Role for Milo Member", { exact: true });
  const before = await role.inputValue();
  const manager = await role.locator("option", { hasText: "Manager" }).getAttribute("value");
  await role.selectOption(manager ?? "");
  const confirm = page.getByRole("dialog", { name: "Confirm it's you" });
  await expect(confirm).toBeVisible();
  await expectAccessible(page);
  await confirm.getByLabel("Code", { exact: true }).fill(totp(secret, 1));
  // Verifying resumes the change: the role action posts again, and its answer is awaited before the reload.
  const resumed = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" && (r.request().postData() ?? "").includes("membershipId"),
  );
  await confirm.getByRole("button", { name: "Verify" }).click();
  await expect(confirm).toBeHidden();
  expect((await resumed).status()).toBe(200);
  expect(manager).not.toBe(before);
  await page.reload();
  await expect(page.getByLabel("Role for Milo Member", { exact: true })).toHaveValue(manager ?? "");
});

test("OAuth 2.1: consent with PKCE, tokens within the granted groups, step-up for Restricted data, revocation", async ({
  page,
}) => {
  const { slug } = await newOwner(page, "oauth");
  await page.goto(`/${slug}/settings/integrations`);
  const apps = page.getByRole("region", { name: "OAuth apps" });
  const redirect = "http://127.0.0.1:4/callback";
  await apps.getByLabel("App name", { exact: true }).fill("Ledger Sync");
  await apps.getByLabel("Redirect URI", { exact: true }).fill(redirect);
  await apps.getByRole("button", { name: "Register app" }).click();
  const clientId =
    (
      await apps.getByRole("list", { name: "OAuth apps" }).locator("code").first().textContent()
    )?.trim() ?? "";
  expect(clientId).toMatch(/^[0-9a-f-]{36}$/);
  await expectAccessible(page);

  // The app's redirect URI answers nothing here; the journey reads the code from the request.
  await page.route(`${redirect}**`, (route) => route.fulfill({ status: 200, body: "callback" }));
  const pkce = () => {
    const verifier = randomBytes(32).toString("base64url");
    return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
  };
  const authorize = (scope: string, challenge: string, method = "S256") =>
    `/oauth/authorize?${new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirect,
      response_type: "code",
      scope,
      state: "st-1",
      code_challenge: challenge,
      code_challenge_method: method,
    }).toString()}`;

  // Plain PKCE is refused before anything starts.
  const plain = await page.request.get(authorize("projects", "x".repeat(43), "plain"), {
    maxRedirects: 0,
  });
  expect(plain.status()).toBe(400);

  const first = pkce();
  await page.goto(authorize("projects work", first.challenge));
  await page.waitForURL("**/oauth/consent?**");
  await expect(page.getByRole("heading", { name: "Allow Ledger Sync to use XOS?" })).toBeVisible();
  await expect(page.getByText("Projects", { exact: true })).toBeVisible();
  await expect(page.getByText("Work records", { exact: true })).toBeVisible();
  await expectAccessible(page);
  const [callback] = await Promise.all([
    page.waitForRequest((r) => r.url().startsWith(redirect)),
    page.getByRole("button", { name: "Allow" }).click(),
  ]);
  const returned = new URL(callback.url());
  expect(returned.searchParams.get("state")).toBe("st-1");
  const code = returned.searchParams.get("code") ?? "";

  const token = async (form: Record<string, string>) =>
    page.request.post("/oauth/token", { form, failOnStatusCode: false });
  const exchanged = await token({
    grant_type: "authorization_code",
    code,
    code_verifier: first.verifier,
    client_id: clientId,
    redirect_uri: redirect,
  });
  expect(exchanged.status()).toBe(200);
  const tokens = (await exchanged.json()) as { access_token: string; refresh_token: string };
  const replay = await token({
    grant_type: "authorization_code",
    code,
    code_verifier: first.verifier,
    client_id: clientId,
    redirect_uri: redirect,
  });
  expect(replay.status()).toBe(400);

  // The API takes the token for the granted groups, and only for them.
  const api = (path: string, bearer: string) =>
    page.request.get(`/api/v1${path}`, {
      headers: { authorization: `Bearer ${bearer}` },
      failOnStatusCode: false,
    });
  expect((await api("/projects", tokens.access_token)).status()).toBe(200);
  const outside = await api("/invoices", tokens.access_token);
  expect(outside.status()).toBe(401);
  expect(await outside.text()).toContain("finance");

  // Refresh rotates the token.
  const refreshed = await token({
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    client_id: clientId,
  });
  expect(refreshed.status()).toBe(200);
  const rotated = (await refreshed.json()) as { refresh_token: string };
  expect(rotated.refresh_token).not.toBe(tokens.refresh_token);

  // Restricted data asks for step-up on consent.
  const second = pkce();
  await page.goto(authorize("data work", second.challenge));
  await page.waitForURL("**/oauth/consent?**");
  await expect(page.getByText("Restricted", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Allow" }).click();
  const setUp = page.getByRole("dialog", { name: "Set up a second factor" });
  await expect(setUp).toBeVisible();
  await Promise.all([
    page.waitForRequest((r) => r.url().startsWith(redirect)),
    enrollAuthenticator(setUp),
  ]);

  // Revoking in Connected apps ends the app's access at once.
  await page.goto(`/${slug}/me/connected-apps`);
  const connected = page.getByRole("region", { name: "Connected apps" });
  await expect(connected.getByRole("list", { name: "Connected apps" })).toContainText(
    "Ledger Sync",
  );
  await expectAccessible(page);
  await connected.getByRole("button", { name: "Revoke Ledger Sync" }).click();
  await page
    .getByRole("dialog", { name: "Revoke Ledger Sync?" })
    .getByRole("button", { name: "Revoke" })
    .click();
  await expect(connected.getByText("You haven't connected any apps.")).toBeVisible();
  const after = await token({
    grant_type: "refresh_token",
    refresh_token: rotated.refresh_token,
    client_id: clientId,
  });
  expect(after.status()).toBe(400);
});
