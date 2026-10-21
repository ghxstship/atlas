import { createHmac } from "node:crypto";

/**
 * RFC 6238 TOTP (SHA-1, 6 digits, 30 seconds), as authenticator apps compute it, for tests that enroll a second
 * factor against the local Supabase stack. Secrets are the per-run ones Supabase Auth issues; none is stored.
 */
function base32(secret: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of secret.replace(/=+$/, "").toUpperCase()) {
    const value = alphabet.indexOf(c);
    if (value < 0) throw new Error("not base32");
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function totp(secret: string, at: number = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const digest = createHmac("sha1", base32(secret)).update(counter).digest();
  const offset = (digest[digest.length - 1] as number) & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
