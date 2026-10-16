import { z } from "zod";

/**
 * Password rules for new passwords (A22-010, ASVS V6.2.1, V6.1.2 and V6.2.11). They match the
 * Supabase Auth settings in supabase/config.toml: at least 12 characters with letters and digits
 * (`minimum_password_length = 12`, `password_requirements = "letters_digits"`). Supabase Auth
 * enforces the same rules and, on the hosted project, refuses passwords found in breach lists; this
 * check runs first so the form names the rule that failed.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

export const newPassword = z
  .string()
  .min(PASSWORD_MIN_LENGTH)
  .max(PASSWORD_MAX_LENGTH)
  .regex(/\p{L}/u)
  .regex(/\p{Nd}/u);

/** Product names a password may not contain: the context-specific word list of ASVS V6.2.11. */
const PRODUCT_WORDS = ["xos", "atlas", "gateway", "compass", "ghxstship"] as const;

/** Words from the person's own details that are long enough to matter. */
function personalWords(details: { readonly email?: string; readonly fullName?: string }): string[] {
  const local = (details.email ?? "").split("@")[0] ?? "";
  const parts = [
    local,
    ...(details.fullName ?? "").split(/[\s.\-_'@]+/u),
    ...local.split(/[.\-_+]+/u),
  ];
  return parts.map((part) => part.toLowerCase()).filter((part) => part.length >= 4);
}

/**
 * True when the password contains a product name, the email's local part or a part of the person's
 * name, ignoring case. These are the first words an attacker tries against a known account.
 */
export function passwordHasContextWords(
  password: string,
  details: { readonly email?: string; readonly fullName?: string },
): boolean {
  const lowered = password.toLowerCase();
  return [...PRODUCT_WORDS, ...personalWords(details)].some((word) => lowered.includes(word));
}
