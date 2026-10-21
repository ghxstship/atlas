import { createHmac } from "node:crypto";
import { expect as baseExpect, type Locator, type Page } from "@playwright/test";

const expect = baseExpect.configure({ timeout: 20_000 });

/**
 * Second factors in journeys (A77): RFC 6238 codes computed from the setup key the enrollment shows, as an
 * authenticator app would. Each run enrolls a fresh factor on a fresh account, so no secret is stored anywhere.
 */
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

/** The code an authenticator app shows `windows` 30-second windows from now. */
export function totp(secret: string, windows = 0): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + windows));
  const digest = createHmac("sha1", base32(secret)).update(counter).digest();
  const offset = (digest[digest.length - 1] as number) & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

/**
 * Enrolls an authenticator app inside `scope` (a page section or the step-up dialog): starts it, reads the setup
 * key, enters the current code. Returns the secret for later codes.
 */
export async function enrollAuthenticator(scope: Locator | Page, label?: string): Promise<string> {
  const name = scope.getByLabel("Name", { exact: true });
  if (label !== undefined) await name.fill(label);
  await scope.getByRole("button", { name: "Set up authenticator app" }).click();
  await expect(scope.getByRole("img", { name: /QR code that sets up/ })).toBeVisible();
  await scope.getByRole("button", { name: "Can't scan? Show the setup key" }).click();
  const secret = (await scope.locator("code").first().textContent())?.trim() ?? "";
  expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
  await scope.getByLabel("Code", { exact: true }).fill(totp(secret));
  await scope.getByRole("button", { name: "Verify and turn on" }).click();
  return secret;
}
