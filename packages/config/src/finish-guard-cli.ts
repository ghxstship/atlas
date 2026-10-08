import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { formatFinding, isScannable, scanText } from "./finish-guard.ts";

const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => f.length > 0 && isScannable(f));

const findings = files.flatMap((file) => scanText(file, readFileSync(file, "utf8")));

if (findings.length > 0) {
  console.error(`Finish guard failed with ${findings.length} finding(s):`);
  for (const f of findings) console.error(`  ${formatFinding(f)}`);
  process.exit(1);
}
console.log(`Finish guard passed: ${files.length} files scanned.`);
