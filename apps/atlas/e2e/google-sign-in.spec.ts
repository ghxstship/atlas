import { expect, test, type Page } from "./engine-test";
import { expectAccessible } from "./support";

/**
 * Sign in with Google (ADR 0036, RRR-117). The local stack turns the provider on
 * (supabase/config.toml), which puts the button on the page. Each journey stops the browser at
 * Supabase Auth's /authorize with page.route, and anything bound for Google is answered locally,
 * so nothing reaches Google or leaves the machine.
 */

const INVITATION = "/auth/invite/xlnk_e2e_google";

const STOPPED = `<!doctype html><html lang="en"><head><title>Stopped</title></head>
<body><main><h1>Stopped before Google</h1></main></body></html>`;

interface Stop {
  /** The authorize request the browser made, once it has. */
  readonly authorize: () => URL;
  /** Requests that were bound for Google. */
  readonly google: string[];
}

/**
 * Answers Supabase Auth's authorize endpoint and Google locally, recording what reached them. With
 * JavaScript, Next sends the browser to the authorize URL as a new navigation, which page.route
 * sees. It never sees the hops of a redirect, so no journey here lets the browser follow one.
 */
async function stopBeforeGoogle(page: Page): Promise<Stop> {
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

/** Checks the authorize request: Google, a PKCE challenge and a return to this site's callback. */
function expectAuthorize(to: URL, site: string, next: string | null): void {
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

test("Continue with Google starts PKCE at Supabase Auth and keeps the invitation", async ({
  page,
  context,
  baseURL,
}) => {
  const stop = await stopBeforeGoogle(page);
  await page.goto(`/auth/sign-in?next=${encodeURIComponent(INVITATION)}`);
  const google = page.getByRole("button", { name: "Continue with Google" });
  await expect(google).toBeVisible();
  await expect(google.locator("img")).toHaveAttribute("alt", "");
  await google.click();
  await expect(page.getByRole("heading", { name: "Stopped before Google" })).toBeVisible();

  expectAuthorize(stop.authorize(), baseURL ?? "", INVITATION);
  // The verifier stays in an httpOnly, same-site cookie; only its hash went out.
  const verifier = (await context.cookies()).find((c) => c.name === "xos-auth-code-verifier");
  expect(verifier?.httpOnly).toBe(true);
  expect(verifier?.sameSite).toBe("Lax");
  expect(stop.google).toEqual([]);
});

test("the sign-up page offers Google too and goes on to create the organization", async ({
  page,
  baseURL,
}) => {
  const stop = await stopBeforeGoogle(page);
  await page.goto("/auth/sign-up");
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
  await expectAccessible(page);
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await expect(page.getByRole("heading", { name: "Stopped before Google" })).toBeVisible();
  expectAuthorize(stop.authorize(), baseURL ?? "", "/auth/organization");
});

test("a Google sign-in that comes back refused shows why on the sign-in page", async ({ page }) => {
  // Cancelled at Google's consent screen: the return Supabase Auth makes (captured locally).
  await page.goto(
    `/auth/callback?error=access_denied&error_description=&next=${encodeURIComponent(INVITATION)}&provider=google`,
  );
  await expect(page).toHaveURL(
    `/auth/sign-in?error=oauth_cancelled&next=${encodeURIComponent(INVITATION)}`,
  );
  await expect(
    page.getByRole("status").filter({ hasText: "You left the sign-in before it finished." }),
  ).toBeVisible();
  // The invitation is still where the next attempt goes.
  await expect(page.locator('form input[name="next"]').first()).toHaveValue(INVITATION);
  await expectAccessible(page);

  const refusals: [string, string][] = [
    ["error=server_error&error_description=boom", "Your sign-in could not be completed."],
    [
      "error=access_denied&error_code=provider_email_needs_verification",
      "The email address on that account is not verified yet.",
    ],
    ["error=access_denied&error_code=sso_required", "Your organization signs its members in"],
    // A code with no verifier in this browser: started elsewhere, or the cookie is gone.
    ["code=e2e-code-without-verifier", "This sign-in expired or was started in another browser."],
  ];
  for (const [query, message] of refusals) {
    await page.goto(`/auth/callback?${query}&provider=google`);
    await expect(page).toHaveURL(/\/auth\/sign-in\?error=/);
    await expect(page.getByRole("alert").filter({ hasText: message })).toBeVisible();
  }
});

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("the Google form still posts, and the answer is a redirect to Supabase Auth", async ({
    page,
    baseURL,
  }) => {
    // The browser must not follow this redirect (page.route would miss its hops): the form's POST
    // is sent from the test to the local server, and the browser gets a local page instead.
    let sent: { status: number; location: string; cookies: string[] } | null = null;
    await page.route(/\/auth\/sign-in$/, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch({ maxRedirects: 0 });
      sent = {
        status: response.status(),
        location: response.headers()["location"] ?? "",
        cookies: response
          .headersArray()
          .filter((h) => h.name.toLowerCase() === "set-cookie")
          .map((h) => h.value),
      };
      return route.fulfill({ status: 200, contentType: "text/html", body: STOPPED });
    });
    const signIn = await page.goto("/auth/sign-in");
    // Supabase Auth then sends the browser on to Google; the CSP lets the form's redirects go there.
    expect(signIn?.headers()["content-security-policy"]).toMatch(
      /form-action 'self' \S+ https:\/\/accounts\.google\.com(;|$)/,
    );
    await page.getByRole("button", { name: "Continue with Google" }).click();
    await expect(page.getByRole("heading", { name: "Stopped before Google" })).toBeVisible();

    const answer = sent as { status: number; location: string; cookies: string[] } | null;
    expect(answer?.status).toBe(303);
    expectAuthorize(new URL(answer?.location ?? ""), baseURL ?? "", null);
    const verifier = answer?.cookies.find((c) => c.startsWith("xos-auth-code-verifier="));
    expect(verifier).toMatch(/HttpOnly/i);
    expect(verifier).toMatch(/SameSite=lax/i);
  });
});
