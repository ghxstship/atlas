import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { OBJECTIONABLE_TERMS } from "../src/objectionable-terms.ts";
import { LOAD_MARKER, objectionableTermsLoad } from "../src/objectionable-terms-sql.ts";

/**
 * Loads src/objectionable-terms.ts into the database: `content-filter:migration <number>_<name>` writes
 * supabase/migrations/<number>_<name>.sql with the statement that replaces the filter's terms. With an existing
 * migration that already holds the generated statement (6890 on its own branch), it rewrites that statement in place.
 */
const name = process.argv[2];
// A release number for a new migration (ADR 0022: 9MMmmBBSS), or a four-digit one to rewrite in place.
if (!name || !/^(\d{4}|9\d{8})_[a-z0-9_]+$/.test(name)) {
  console.error(
    "Usage: content-filter:migration <number>_<name>, for example 904090001_objectionable_terms",
  );
  process.exit(1);
}
const target = fileURLToPath(new URL(`../../../supabase/migrations/${name}.sql`, import.meta.url));
const statement = objectionableTermsLoad(OBJECTIONABLE_TERMS);
if (existsSync(target)) {
  const current = readFileSync(target, "utf8");
  const at = current.indexOf(LOAD_MARKER);
  if (at < 0) {
    console.error(`${target} exists and holds no generated statement`);
    process.exit(1);
  }
  writeFileSync(target, current.slice(0, at) + statement);
} else {
  writeFileSync(
    target,
    `-- ${name}.sql\n-- Loads the objectionable language filter's terms (6890) again after a change to the list.\n\n${statement}`,
  );
}
console.log(`Wrote ${target}`);
