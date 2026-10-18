import { execFileSync } from "node:child_process";
import { checkLicenses, type LicensedPackage } from "./license-check.ts";

/**
 * `pnpm --filter @xos/config licenses:check` from the repository: lists the production dependencies of every
 * workspace package with pnpm and fails on a license outside the allowlist (gate 11).
 */
const json = execFileSync("pnpm", ["licenses", "list", "--json", "--prod", "--recursive"], {
  encoding: "utf8",
  maxBuffer: 64 << 20,
});
const byLicense = JSON.parse(json) as Record<string, LicensedPackage[]>;
const violations = checkLicenses(byLicense);
const total = Object.values(byLicense).reduce((n, list) => n + list.length, 0);

if (violations.length > 0) {
  console.error(`License check failed: ${violations.length} license(s) need review by counsel.`);
  for (const v of violations) console.error(`  ${v.license}: ${v.packages.join(", ")}`);
  process.exit(1);
}
console.log(`License check passed: ${total} production packages.`);
