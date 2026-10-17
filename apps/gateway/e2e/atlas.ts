import type { Browser, BrowserContext, Page } from "@playwright/test";
import { DEMO_PASSWORD } from "./support";

/**
 * The org's side of a cross-app journey, in Atlas (E2E_ATLAS_URL; playwright.config.ts starts it).
 * Each person gets their own browser context: on a local stack both apps answer on 127.0.0.1, and
 * one context would share one session cookie between the org's person and the external party.
 */
export const ATLAS_URL = process.env["E2E_ATLAS_URL"] ?? "http://127.0.0.1:3006";
export const ORG = "demo-productions";

export async function atlasAs(
  browser: Browser,
  email: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: ATLAS_URL, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.goto(`/auth/sign-in?next=${encodeURIComponent(`/${ORG}/home`)}`);
  await page.locator("#signin-email").fill(email);
  await page.locator("#signin-password").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await page.waitForURL(`**/${ORG}/home`);
  return { context, page };
}
