import { describe, expect, it } from "vitest";
import { newPassword, passwordHasContextWords } from "../lib/auth/password";

describe("new password rules (A22-010)", () => {
  it("need 12 characters with letters and digits, matching supabase/config.toml", () => {
    expect(newPassword.safeParse("short1a").success).toBe(false);
    expect(newPassword.safeParse("onlyletterslong").success).toBe(false);
    expect(newPassword.safeParse("123456789012").success).toBe(false);
    expect(newPassword.safeParse("river4tangerine").success).toBe(true);
    expect(newPassword.safeParse(`a1${"x".repeat(255)}`).success).toBe(false);
  });

  it("refuse product names, the email local part and name parts, ignoring case", () => {
    const person = { email: "ada.lovelace@example.com", fullName: "Ada Lovelace" };
    expect(passwordHasContextWords("MyAtlasPassword9", person)).toBe(true);
    expect(passwordHasContextWords("compass2026rocks", person)).toBe(true);
    expect(passwordHasContextWords("LOVELACE-4-ever-x", person)).toBe(true);
    expect(passwordHasContextWords("ada.lovelace1234", person)).toBe(true);
    expect(passwordHasContextWords("river4tangerine", person)).toBe(false);
    // Name parts shorter than four letters are not refused on their own.
    expect(passwordHasContextWords("adamant7granite", person)).toBe(false);
  });
});
