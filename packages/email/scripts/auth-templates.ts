import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AUTH_EMAILS, renderAuthEmail } from "../src/auth-templates.ts";

/**
 * Writes supabase/templates from src/auth-templates.ts, one file per Supabase Auth email. With --check, writes
 * nothing and exits 1 when a file is out of date.
 */
const dir = fileURLToPath(new URL("../../../supabase/templates/", import.meta.url));
const check = process.argv.includes("--check");
let stale = 0;
for (const email of AUTH_EMAILS) {
  const path = `${dir}${email.file}`;
  const html = renderAuthEmail(email);
  if (check) {
    let current: string | null = null;
    try {
      current = readFileSync(path, "utf8");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (current !== html) {
      console.error(`supabase/templates/${email.file} is out of date.`);
      stale += 1;
    }
  } else {
    writeFileSync(path, html);
  }
}
if (check && stale > 0) {
  console.error("Run pnpm --filter @xos/email auth-templates.");
  process.exit(1);
}
console.log(
  check ? "Auth email templates are current." : `Wrote ${AUTH_EMAILS.length} auth email templates.`,
);
