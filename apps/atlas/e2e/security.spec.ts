import { expect, test } from "./engine-test";

test("pages carry a nonce-based CSP and the security headers, with no CSP violations", async ({
  page,
}) => {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (/Content Security Policy/i.test(message.text())) violations.push(message.text());
  });
  const response = await page.goto("/auth/sign-in");
  const headers = response?.headers() ?? {};
  const csp = headers["content-security-policy"] ?? "";
  expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
  expect(csp).toContain("frame-ancestors 'none'");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
  const scripts = await page
    .locator("script[src]")
    .evaluateAll((els) => els.map((el) => (el as HTMLScriptElement).nonce));
  expect(scripts.length).toBeGreaterThan(0);
  // Server-rendered scripts carry the nonce; chunks they load are trusted through strict-dynamic.
  expect(scripts.some((n) => n === nonce)).toBe(true);
  expect(await response?.text()).toContain(`nonce="${nonce}"`);
  await page.locator("#signin-email").fill("someone@atlas-e2e.test");
  expect(violations).toEqual([]);
});

test("a cross-site POST is refused (CSRF)", async ({ request, baseURL }) => {
  const response = await request.post(`${baseURL}/auth/sign-out`, {
    headers: { Origin: "https://evil.example" },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(403);
});
