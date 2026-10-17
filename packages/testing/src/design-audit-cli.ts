import { fileURLToPath } from "node:url";
import { runDesignAudit } from "./design-audit-repo.ts";

/**
 * `pnpm --filter @xos/testing design:audit` prints the design QA report and exits 1 when any raw
 * value, unknown token or missing web component is found. `--json` prints the report as JSON.
 */
const root = fileURLToPath(new URL("../../../", import.meta.url));
const report = runDesignAudit(root);

if (process.argv.includes("--json")) {
  process.stdout.write(
    `${JSON.stringify({ ...report, usage: Object.fromEntries(report.usage) }, null, 2)}\n`,
  );
} else {
  const lines = [
    `Design QA audit: ${report.files} source files`,
    `Raw values and unknown tokens: ${report.findings.length}`,
    ...report.findings.map((f) => `  ${f.file}:${f.line} ${f.rule} ${f.text}`),
    `Tokens referenced: ${report.usage.size}; tokens never referenced: ${report.unusedTokens.length}`,
    `Web components (Section 11.4): ${report.web.present.length} of ${report.web.present.length + report.web.missing.length}`,
    ...report.web.missing.map((name) => `  missing in @xos/ui: ${name}`),
    `Native components exported: ${report.native.present.length} (Compass ships the field subset)`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

process.exitCode = report.findings.length > 0 || report.web.missing.length > 0 ? 1 : 0;
