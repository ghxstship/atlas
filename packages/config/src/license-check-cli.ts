import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { reviewLicenses, type LicensedPackage, type LicenseException } from "./license-check.ts";

/**
 * `pnpm --filter @xos/config licenses:check` from the repository: lists the production dependencies of every
 * workspace package with pnpm and fails on a license outside the allowlist (gate 11). Packages recorded in
 * `license-exceptions.json` (pending or approved by counsel) pass with a notice; any other package with a
 * license outside the allowlist fails.
 */
const json = execFileSync("pnpm", ["licenses", "list", "--json", "--prod", "--recursive"], {
  encoding: "utf8",
  maxBuffer: 64 << 20,
});
const byLicense = JSON.parse(json) as Record<string, LicensedPackage[]>;
const exceptions = (
  JSON.parse(readFileSync(new URL("../license-exceptions.json", import.meta.url), "utf8")) as {
    exceptions: LicenseException[];
  }
).exceptions;
const review = reviewLicenses(byLicense, exceptions);
const total = Object.values(byLicense).reduce((n, list) => n + list.length, 0);
const inActions = process.env["GITHUB_ACTIONS"] === "true";

for (const e of review.excepted) {
  const message = `${e.license} (${e.exception.status}): ${e.packages.join(", ")}. ${e.exception.decision}`;
  console.log(inActions ? `::warning title=License exception::${message}` : `Excepted: ${message}`);
}
for (const e of review.unused) {
  console.log(`Exception for ${e.package} (${e.license}) matched no installed package.`);
}
if (review.violations.length > 0 || review.invalid.length > 0) {
  console.error(
    `License check failed: ${review.violations.length} license(s) need review by counsel.`,
  );
  for (const v of review.violations) console.error(`  ${v.license}: ${v.packages.join(", ")}`);
  for (const problem of review.invalid) console.error(`  license-exceptions.json: ${problem}`);
  process.exit(1);
}
console.log(
  `License check passed: ${total} production packages, ${review.excepted.length} license exception(s).`,
);
