import { expect, settle, test } from "./engine-test";
import { DEMO, expectAccessible, signIn, sql } from "./support";

/**
 * A96 (RRR-141, findings A65-022 and A65-023) in Gateway: the installable app's manifest and offline page, and
 * feedback from the help panel to the platform team with the page context shown before sending.
 */

test("Gateway installs: its manifest, service worker script and offline page", async ({ page }) => {
  const manifest = await page.request.get("/manifest.webmanifest");
  expect(manifest.ok()).toBe(true);
  expect(await manifest.json()).toMatchObject({
    name: "Gateway",
    display: "standalone",
    start_url: "/",
    scope: "/",
  });
  const worker = await page.request.get("/sw.js");
  expect(worker.headers()["content-type"]).toContain("javascript");
  expect(await worker.text()).toContain('"app":"Gateway"');
  await page.goto("/auth/offline");
  await expect(page.getByRole("heading", { name: "You're Offline" })).toBeVisible();
  await expectAccessible(page);
});

test("feedback from the help panel reaches the platform team", async ({ page }) => {
  await signIn(page, "crew@example.com");
  await settle(page);
  await page.getByRole("heading", { level: 1 }).click();
  await page.keyboard.press("?");
  const help = page.getByRole("dialog", { name: "Help" });
  await help.getByRole("button", { name: "Send Feedback" }).click();
  const form = page.getByTestId("feedback-form");
  await expect(form.getByText("Sent with your message: the page /home")).toBeVisible();
  const message = `Pay first on the card, please ${Date.now().toString(36)}`;
  await form.getByLabel("What happened?").fill(message);
  await expectAccessible(page);
  await form.getByRole("button", { name: "Send" }).click();
  await expect(form.getByRole("status")).toContainText(/Your reference is FB-\d{6}/, {
    timeout: 30_000,
  });
  const rows = await sql<{ app: string; route: string; person: string }>(
    "select app_code as app, route, person_id::text as person from app.feedback_submissions where message = $1",
    [message],
  );
  expect(rows).toEqual([{ app: "Gateway", route: "/home", person: DEMO.crew }]);
});
