import { expect, test, type Page } from "./engine-test";
import { expectAccessible } from "./support";

/**
 * Sign in with Google on Gateway (ADR 0036, RRR-117): the same account Atlas and Compass use. The
 * local stack turns the provider on (supabase/config.toml). Each journey stops the browser at
 * Supabase Auth's /authorize with page.route and answers anything bound for Google locally, so
 * nothing reaches Google or leaves the machine. With JavaScript, Next sends the browser to the
 * authorize URL as a new navigation, which page.route sees; it never sees the hops of a redirect,
 * so no journey here lets the browser follow one.
 */

const CLAIM = "/auth/claim";

const STOPPED = `<!doctype html><html lang="en"><head><title>Stopped</title></head>
<body><main><h1>Stopped before Google</h1></main></body></html>`;

async function stopBeforeGoogle(page: Page): Promise<{ authorize: () => URL; google: string[] }> {
  let authorize: URL | null = null;
  const google: string[] = [];
  await page.route(/\/auth\/v1\/authorize\?/, async (route) => {
    authorize = new URL(route.request().url());
    await route.fulfill({ status: 200, contentType: "text/html", body: STOPPED });
  });
  await page.route(/^https:\/\/accounts\.google\.com\//, async (route) => {
    google.push(route.request().url());
    await route.fulfill({ status: 200, contentType: "text/html", body: STOPPED });
  });
  return {
    authorize: () => {
      if (!authorize) throw new Error("The browser never reached /auth/v1/authorize");
      return authorize;
    },
    google,
  };
}

function expectAuthorize(to: URL, site: string, next: string): void {
  expect(to.pathname).toBe("/auth/v1/authorize");
  expect(to.searchParams.get("provider")).toBe("google");
  expect(to.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(to.searchParams.get("code_challenge_method")).toBe("s256");
  expect(to.searchParams.get("prompt")).toBe("select_account");
  const back = new URL(to.searchParams.get("redirect_to") ?? "");
  expect(back.origin).toBe(new URL(site).origin);
  expect(back.pathname).toBe("/auth/callback");
  expect(back.searchParams.get("next")).toBe(next);
  expect(back.searchParams.get("provider")).toBe("google");
}

test("Continue with Google starts PKCE at Supabase Auth and keeps the claim step", async ({
  page,
  context,
  baseURL,
}) => {
  const stop = await stopBeforeGoogle(page);
  const signIn = await page.goto(`/auth/sign-in?next=${encodeURIComponent(CLAIM)}`);
  expect(signIn?.headers()["content-security-policy"]).toMatch(
    /form-action 'self' \S+ https:\/\/accounts\.google\.com(;|$)/,
  );
  const google = page.getByRole("button", { name: "Continue with Google" });
  await expect(google.locator("img")).toHaveAttribute("alt", "");
  await google.click();
  await expect(page.getByRole("heading", { name: "Stopped before Google" })).toBeVisible();

  expectAuthorize(stop.authorize(), baseURL ?? "", CLAIM);
  const verifier = (await context.cookies()).find((c) => c.name === "xos-auth-code-verifier");
  expect(verifier?.httpOnly).toBe(true);
  expect(verifier?.sameSite).toBe("Lax");
  expect(stop.google).toEqual([]);
});

test("the sign-up page offers Google and goes on to Home", async ({ page, baseURL }) => {
  const stop = await stopBeforeGoogle(page);
  await page.goto("/auth/sign-up");
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
  await expectAccessible(page);
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await expect(page.getByRole("heading", { name: "Stopped before Google" })).toBeVisible();
  expectAuthorize(stop.authorize(), baseURL ?? "", "/home");
});

test("a Google sign-in that comes back refused shows why on the sign-in page", async ({ page }) => {
  await page.goto(
    `/auth/callback?error=access_denied&error_description=&next=${encodeURIComponent(CLAIM)}&provider=google`,
  );
  await expect(page).toHaveURL(
    `/auth/sign-in?error=oauth_cancelled&next=${encodeURIComponent(CLAIM)}`,
  );
  await expect(
    page.getByRole("status").filter({ hasText: "You left the sign-in before it finished." }),
  ).toBeVisible();
  await expect(page.locator('form input[name="next"]').first()).toHaveValue(CLAIM);
  await expectAccessible(page);

  const refusals: [string, string][] = [
    ["error=server_error&error_description=boom", "Your sign-in could not be completed."],
    [
      "error=access_denied&error_code=provider_email_needs_verification",
      "The email address on that account is not verified yet.",
    ],
    ["error=access_denied&error_code=sso_required", "Your organization signs its members in"],
    ["code=e2e-code-without-verifier", "This sign-in expired or was started in another browser."],
  ];
  for (const [query, message] of refusals) {
    await page.goto(`/auth/callback?${query}&provider=google`);
    await expect(page).toHaveURL(/\/auth\/sign-in\?error=/);
    await expect(page.getByRole("alert").filter({ hasText: message })).toBeVisible();
  }
});
