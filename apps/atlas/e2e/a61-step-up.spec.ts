import { createHmac } from "node:crypto";
import { expect, test } from "./engine-test";
import { createOrganization, expectAccessible, signUp, testEmail, uniqueId } from "./support";

/**
 * Finding A59-019 (A61, RRR-106): an Owner without a second factor who takes emergency access is
 * offered the step-up in place. They set up an authenticator app (QR code and key), verify a code, and
 * the request is retried, so the session ends with emergency access open. Runs as a new Owner in a new
 * org, so the demo tenant's people keep no factor.
 */

test.use({ reducedMotion: "reduce" });

/** RFC 6238 time-based code (SHA-1, 30 seconds, six digits) from a base32 secret. */
function totp(secret: string, at = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of secret.replace(/=+$/, "").toUpperCase()) {
    bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  }
  const bytes = Buffer.from(bits.match(/.{8}/g)?.map((b) => parseInt(b, 2)) ?? []);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const hmac = createHmac("sha1", bytes).update(counter).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0xf;
  const value = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(value).padStart(6, "0");
}

test("emergency access without a second factor offers enrolment, verifies and retries", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const id = uniqueId();
  const slug = `stp-${id}`;
  await signUp(page, { name: "Sam Owner", email: testEmail("owner", id) });
  await createOrganization(page, { name: `Step Up ${id}`, slug });

  await page.goto(`/${slug}/settings/security`);
  await page
    .locator("#break-glass-reason")
    .fill("Owner locked out of the venue network at load-in.");
  await page.getByRole("button", { name: "Take emergency access" }).click();

  // No factor yet: the step-up offers to set one up instead of a dead end.
  const enrol = page.getByRole("button", { name: "Set up an authenticator app" });
  await expect(enrol).toBeVisible({ timeout: 30_000 });
  await expectAccessible(page);
  await enrol.click();
  await expect(page.getByRole("img", { name: "QR code for your authenticator app" })).toBeVisible({
    timeout: 30_000,
  });
  const secret = (await page.locator("p code").first().textContent())?.trim() ?? "";
  expect(secret).toMatch(/^[A-Z2-7]+=*$/);

  await page.getByLabel("Six-digit code").fill(totp(secret));
  await page.getByRole("button", { name: "Verify" }).click();

  // Verified, the request runs again and emergency access is open.
  await expect(page.getByText(/You hold emergency access until/)).toBeVisible({ timeout: 30_000 });

  // Personal settings list the new authenticator app.
  await page.goto(`/${slug}/me/security`);
  await expect(page.getByRole("heading", { name: "Second factor" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add another authenticator app" })).toBeVisible();
});
