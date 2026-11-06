import { expect, test } from "@playwright/test";

/**
 * B2 vendor intake (RRR-226, ADR 0141; gap G-226): the anonymous side of a reusable intake link. The code form travels in
 * the form body only and an unknown token is refused. Sign-in, the tax form, the bank number refusal, the signature, the
 * draft and approval are covered by pgTAP 2915 on the database's rules.
 */

test("an intake address asks for a code and answers no-store", async ({ page }) => {
  const token = `xvin_${"0".repeat(64)}`;
  await page.goto(`/onboard/${token}`);
  await expect(page.getByLabel("Access code")).toBeVisible();
  const post = await page.request.post(`/onboard/${token}/open`, {
    form: { accessCode: "000000" },
    maxRedirects: 0,
  });
  expect(post.status()).toBe(303);
  expect(post.headers()["cache-control"]).toContain("no-store");
  expect(post.headers()["location"]).toContain("reason=intake_link_invalid");
  const get = await page.request.get(`/onboard/${token}/open`, { maxRedirects: 0 });
  expect(get.status()).toBe(303);
  expect((await page.request.get("/onboard/nope")).status()).toBe(404);
});
