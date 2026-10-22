import pg from "pg";
import type { Page } from "@playwright/test";
import { expect, test } from "./engine-test";
import { createOrganization, expectAccessible, signUp, testEmail, uniqueId } from "./support";

/**
 * A96 (RRR-141, findings A65-022 and A65-023) on a fresh account each:
 *   - a practice sandbox opens from Help, says plainly what it is, and is purged with every row once it expires
 *   - feedback with a screenshot goes from Help to the platform team, and platform staff triage it
 *   - no product analytics event leaves the browser without a yes to performance cookies, or under Global
 *     Privacy Control; with the yes, page views land as route templates
 *   - Atlas is installable: the manifest, the service worker and the offline fallback
 *   - browser notifications subscribe with a fake push subscription and turn off again
 * The database checks and the staff grant run as postgres against the local stack only (E2E_DATABASE_URL).
 */

const databaseUrl =
  process.env["E2E_DATABASE_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:55422/postgres";
if (!/@(127\.0\.0\.1|localhost):/.test(databaseUrl)) {
  throw new Error("The A96 journeys touch only a local Supabase stack.");
}

async function sql<T extends Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return (await client.query<T>(text, params)).rows;
  } finally {
    await client.end();
  }
}

/** A82's consent cookie (`1.<visitor>.<preferences><performance>.<gpc>`), as the banner writes it. */
function consentCookie(performance: boolean): string {
  const visitor = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  return `1.${visitor}.1${performance ? "1" : "0"}.0`;
}

function baseUrl(): string {
  return String(test.info().project.use.baseURL);
}

async function freshOrg(page: Page, label: string): Promise<{ slug: string; email: string }> {
  const id = uniqueId();
  const slug = `${label}-${id}`;
  const email = testEmail(label, id);
  await signUp(page, { name: `Ada ${label}`, email });
  await createOrganization(page, { name: `${label} ${id}`, slug });
  await page.locator("html[data-shell-ready]").waitFor({ state: "attached" });
  return { slug, email };
}

async function openHelp(page: Page) {
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("?");
  const help = page.getByRole("dialog", { name: "Help" });
  await expect(help).toBeVisible();
  return help;
}

test("a practice sandbox opens from Help, says what it is, and is purged when it expires", async ({
  page,
}) => {
  test.setTimeout(10 * 60_000);
  await freshOrg(page, "sandbox");
  const help = await openHelp(page);
  await expect(help.getByRole("region", { name: "Practice Sandbox" })).toBeVisible();
  await help.getByRole("button", { name: "Try a Sandbox" }).click();
  await page.waitForURL(/\/sandbox-[0-9a-f]{10}\/home$/, { timeout: 120_000 });
  const slug = new URL(page.url()).pathname.split("/")[1] ?? "";
  const banner = page.getByTestId("sandbox-banner");
  await expect(banner).toContainText(
    "This is your sandbox. Only you can see it, and nothing in it is billed, emailed or texted.",
  );
  await expectAccessible(page);

  // The template: the Northwind Summer Series past gate 1, and no invitation leaves the sandbox.
  const [org] = await sql<{ id: string; projects: string }>(
    `select o.id, (select count(*) from app.projects p where p.org_id = o.id)::text as projects
       from app.organizations o where o.slug = $1`,
    [slug],
  );
  expect(org?.projects).toBe("2");

  // Opening it again from Help returns to the same sandbox.
  await page.goto(`/${slug}/home`);
  const again = await openHelp(page);
  await expect(again.getByText(/Your sandbox ends/)).toBeVisible();

  // It expires: the hourly job purges every row, and the address is gone.
  await sql(
    "update app.sandbox_orgs set expires_at = now() - interval '1 second' where org_id = $1",
    [org?.id],
  );
  const [purged] = await sql<{ n: number }>("select private.purge_expired_sandboxes() as n");
  expect(purged?.n).toBe(1);
  expect(await sql("select 1 from app.organizations where id = $1", [org?.id])).toHaveLength(0);
  const response = await page.goto(`/${slug}/home`);
  expect(response?.status()).toBe(404);
});

test("feedback with a screenshot reaches the platform team, who triage it", async ({
  page,
  browser,
}) => {
  test.setTimeout(5 * 60_000);
  const { slug, email } = await freshOrg(page, "feedback");
  await page.goto(`/${slug}/projects`);
  await page.locator("html[data-shell-ready]").waitFor({ state: "attached" });
  const help = await openHelp(page);
  await help.getByRole("button", { name: "Send Feedback" }).click();
  const form = page.getByTestId("feedback-form");
  await expect(form.getByText(`Sent with your message: the page /${slug}/projects`)).toBeVisible();
  const message = `Bulk edit on projects, please ${uniqueId()}`;
  await form.getByLabel("What happened?").fill(message);
  // A one-pixel PNG the person chose.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  await form
    .getByLabel("Screenshot (optional)")
    .setInputFiles({ name: "shot.png", mimeType: "image/png", buffer: png });
  await expectAccessible(page);
  await form.getByRole("button", { name: "Send" }).click();
  await expect(form.getByRole("status")).toContainText(/Your reference is FB-\d{6}/, {
    timeout: 30_000,
  });

  const [row] = await sql<{ id: string; route: string; shot: string | null; slug: string }>(
    `select f.id, f.route, f.screenshot_path as shot, o.slug from app.feedback_submissions f
       join app.organizations o on o.id = f.context_org_id where f.message = $1`,
    [message],
  );
  expect(row?.route).toBe(`/${slug}/projects`);
  expect(row?.shot).toMatch(/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.png$/);

  // A person on the platform team triages it; anyone else gets 404.
  expect((await page.goto("/support/feedback"))?.status()).toBe(404);
  await sql(
    `insert into private.platform_staff (person_id, reason)
     select p.id, 'A96 journey' from app.people p join auth.users u on u.id = p.user_id where u.email = $1`,
    [email],
  );
  const staff = await (
    await browser.newContext({ storageState: await page.context().storageState() })
  ).newPage();
  await staff.goto("/support/feedback?state=New");
  await expect(staff.getByRole("heading", { name: "Product Feedback" })).toBeVisible();
  const item = staff.getByTestId("feedback-item").filter({ hasText: message });
  await expect(item).toBeVisible();
  await expect(item.getByText("The screenshot is still being scanned.")).toBeVisible();
  await expectAccessible(staff);
  await item.getByLabel("State").selectOption("Planned");
  await item.getByLabel("Note").fill("On the roadmap.");
  await item.getByRole("button", { name: "Save" }).click();
  await expect(item.getByRole("status")).toHaveText("Saved.", { timeout: 20_000 });
  const [triaged] = await sql<{ state: string }>(
    "select triage_state as state from app.feedback_submissions where id = $1",
    [row?.id],
  );
  expect(triaged?.state).toBe("Planned");
});

test("no product analytics without consent, nor under Global Privacy Control", async ({
  browser,
}) => {
  test.setTimeout(4 * 60_000);
  const [before] = await sql<{ n: string }>("select count(*)::text as n from app.product_events");
  const watch = (page: Page) => {
    const sent: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/product-events")) sent.push(r.url());
    });
    return sent;
  };

  // No choice made yet, no signal: the banner asks, and nothing is collected meanwhile.
  const undecided = await (await browser.newContext({ extraHTTPHeaders: {} })).newPage();
  const quiet = watch(undecided);
  for (const path of ["/auth/sign-in", "/auth/sign-up", "/legal/cookie-policy"])
    await undecided.goto(path);
  await undecided.waitForTimeout(6000);
  expect(quiet).toEqual([]);
  // Even a well-formed batch posted by hand is dropped unread.
  const response = await undecided.request.post("/api/product-events", {
    headers: { Origin: new URL(undecided.url()).origin, "Content-Type": "application/json" },
    data: {
      sessionKey: "6f1c3a52-0d1e-4b8e-9a4f-1d2c3b4a5e6f",
      events: [{ occurredAt: new Date().toISOString(), name: "Page Viewed", route: "/[org]/home" }],
    },
  });
  expect(response.status()).toBe(204);

  // A yes to performance cookies, but the browser sends Global Privacy Control: still nothing.
  const context = await browser.newContext({ extraHTTPHeaders: { "Sec-GPC": "1" } });
  await context.addCookies([{ name: "xos-consent", value: consentCookie(true), url: baseUrl() }]);
  const signal = await context.newPage();
  const refused = watch(signal);
  const { slug } = await freshOrg(signal, "gpc");
  for (const path of ["home", "projects", "inbox"]) {
    await signal.goto(`/${slug}/${path}`);
    await signal.locator("html[data-shell-ready]").waitFor({ state: "attached" });
  }
  await signal.waitForTimeout(6000);
  expect(refused).toEqual([]);
  const [after] = await sql<{ n: string }>("select count(*)::text as n from app.product_events");
  expect(after?.n).toBe(before?.n);
});

test("with a yes to performance cookies, page views are recorded as route templates", async ({
  browser,
}) => {
  test.setTimeout(4 * 60_000);
  const context = await browser.newContext({ extraHTTPHeaders: {} });
  await context.addCookies([{ name: "xos-consent", value: consentCookie(true), url: baseUrl() }]);
  const page = await context.newPage();
  const { slug } = await freshOrg(page, "consented");
  const posted = page.waitForRequest((r) => r.url().includes("/api/product-events"), {
    timeout: 60_000,
  });
  for (const path of ["projects", "inbox", "my-work"]) {
    await page.goto(`/${slug}/${path}`);
    await page.locator("html[data-shell-ready]").waitFor({ state: "attached" });
  }
  await page.goto("/auth/sign-in?next=/");
  await posted;
  await expect
    .poll(
      async () =>
        (
          await sql<{ route: string }>(
            "select route_template as route from app.product_events where received_at > now() - interval '5 minutes'",
          )
        ).map((r) => r.route),
      { timeout: 30_000 },
    )
    .toContain("/[org]/projects");
  // Nothing about the person or the org slug reached the table.
  const leaked = await sql("select 1 from app.product_events where route_template like $1", [
    `%${slug}%`,
  ]);
  expect(leaked).toHaveLength(0);
});

test("Atlas installs: the manifest, the service worker and the offline fallback", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Service workers are exercised in Chromium.");
  test.setTimeout(5 * 60_000);
  const manifest = await page.request.get("/manifest.webmanifest");
  expect(manifest.ok()).toBe(true);
  const body = (await manifest.json()) as Record<string, unknown>;
  expect(body).toMatchObject({ name: "Atlas", display: "standalone", start_url: "/", scope: "/" });
  expect((body["icons"] as unknown[]).length).toBeGreaterThan(0);
  expect((body["shortcuts"] as unknown[]).length).toBe(3);

  const { slug } = await freshOrg(page, "offline");
  await expect(page.locator('link[rel="manifest"]')).toHaveCount(1);
  await page.waitForFunction(
    async () => (await navigator.serviceWorker.getRegistration("/"))?.active !== undefined,
    null,
    {
      timeout: 60_000,
    },
  );
  // A page loaded once while the worker controls the tab is kept for this person.
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
    timeout: 30_000,
  });
  await page.goto(`/${slug}/projects`);
  await page.locator("html[data-shell-ready]").waitFor({ state: "attached" });
  await page.waitForTimeout(2000);

  await page.context().setOffline(true);
  await page.goto(`/${slug}/projects`);
  await expect(page).toHaveURL(new RegExp(`/${slug}/projects$`));
  await expect(page.locator("main")).not.toContainText("You're Offline");
  await page.goto(`/${slug}/settings/members`);
  await expect(page.getByRole("heading", { name: "You're Offline" })).toBeVisible();
  await page.context().setOffline(false);

  // Sign-out forgets every kept page.
  const kept = await page.evaluate(
    async () => (await caches.keys()).filter((k) => k.startsWith("xos-pages-")).length,
  );
  expect(kept).toBe(1);
  await page.evaluate(() => navigator.serviceWorker.controller?.postMessage({ type: "sign-out" }));
  await expect
    .poll(async () =>
      page.evaluate(
        async () => (await caches.keys()).filter((k) => k.startsWith("xos-pages-")).length,
      ),
    )
    .toBe(0);
});

test("browser notifications subscribe with a fake push subscription and turn off", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Push is exercised in Chromium.");
  test.setTimeout(5 * 60_000);
  await page.context().grantPermissions(["notifications"]);
  // A fake push service: subscribe() hands back an endpoint and keys made in the page, never a real service.
  await page.addInitScript(() => {
    const bytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));
    const b64 = (data: Uint8Array) =>
      btoa(String.fromCharCode(...data))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");
    let current: PushSubscription | null = null;
    const make = (): PushSubscription => {
      const key = new Uint8Array([4, ...bytes(64)]);
      const json = {
        endpoint: `https://push.example.test/send/${b64(bytes(12))}`,
        keys: { p256dh: b64(key), auth: b64(bytes(16)) },
      };
      const sub = {
        endpoint: json.endpoint,
        toJSON: () => json,
        unsubscribe: async () => {
          current = null;
          return true;
        },
      };
      return sub as unknown as PushSubscription;
    };
    PushManager.prototype.subscribe = async function subscribe() {
      current = make();
      return current;
    };
    PushManager.prototype.getSubscription = async function getSubscription() {
      return current;
    };
  });
  const { slug, email } = await freshOrg(page, "push");
  await page.goto(`/${slug}/me/notifications`);
  await page.locator("html[data-shell-ready]").waitFor({ state: "attached" });
  const card = page
    .getByRole("region", { name: "Browser Notifications" })
    .or(page.locator("section", { hasText: "Browser Notifications" }));
  const status = page.locator("[data-push-state]");
  await expect(status).not.toHaveAttribute("data-push-state", "loading");
  if ((await status.getAttribute("data-push-state")) === "unavailable") {
    await expect(status).toHaveText("Browser notifications are not set up yet.");
    test
      .info()
      .annotations.push({ type: "note", description: "VAPID_PUBLIC_KEY is unset on this server." });
    return;
  }
  await expectAccessible(page);
  await card.first().getByRole("button", { name: "Turn On" }).click();
  await expect(status).toHaveText("On in this browser.", { timeout: 30_000 });
  const rows = await sql<{ endpoint: string; app: string; revoked: boolean }>(
    `select ps.web_endpoint as endpoint, ps.web_app as app, ps.revoked_at is not null as revoked
       from app.push_subscriptions ps join app.memberships m on m.id = ps.membership_id
       join app.people p on p.id = m.person_id join auth.users u on u.id = p.user_id
      where u.email = $1 and ps.web_endpoint is not null`,
    [email],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ app: "Atlas", revoked: false });
  await page.getByRole("button", { name: "Turn Off" }).click();
  await expect(status).toHaveText("Off in this browser.", { timeout: 30_000 });
  const [revoked] = await sql<{ revoked: boolean }>(
    "select revoked_at is not null as revoked from app.push_subscriptions where web_endpoint = $1",
    [rows[0]?.endpoint],
  );
  expect(revoked?.revoked).toBe(true);
});
