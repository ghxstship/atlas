import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDocumentModel } from "../src/documents/generate.ts";
import { DOCUMENT_KINDS, PAPERS } from "../src/documents/model.ts";
import { renderDocumentPdf } from "../src/documents/render.ts";
import { BRAND, FIXTURES, NOW } from "../test/documents/fixtures.ts";

/**
 * Section 18 gate 19: renders every Section 11.9 template from fixture data, on US Letter and A4, in
 * en-US and es-US, and validates each file against PDF/UA-1 with veraPDF in its pinned Docker image
 * (ADR 0031). Exits 1 when any file is not compliant or veraPDF cannot run.
 *
 *   pnpm --filter @xos/data documents:verapdf [--keep]
 */
export const VERAPDF_IMAGE = "verapdf/cli:v1.30.2";
const LOCALES = ["en-US", "es-US"] as const;

const messagesFor = (locale: string): unknown =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../../i18n/messages/${locale}/documents.json`, import.meta.url)),
      "utf8",
    ),
  );

const dir = mkdtempSync(join(tmpdir(), "xos-verapdf-"));
const files: string[] = [];
for (const locale of LOCALES) {
  const messages = messagesFor(locale);
  for (const kind of DOCUMENT_KINDS) {
    const model = buildDocumentModel(kind, FIXTURES[kind] as never, {
      locale,
      messages,
      brand: BRAND,
      recordUrl: `https://atlas.example.test/northwind/documents/${kind}`,
      now: NOW,
    });
    for (const paper of PAPERS) {
      const name = `${kind}.${locale}.${paper}.pdf`;
      writeFileSync(join(dir, name), await renderDocumentPdf(model, { paper }));
      files.push(name);
    }
  }
}
console.log(`Rendered ${files.length} documents into ${dir}.`);

interface Job {
  itemDetails?: { name?: string };
  validationResult?: { compliant?: boolean; details?: { ruleSummaries?: RuleSummary[] } }[];
}
interface RuleSummary {
  clause?: string;
  testNumber?: number;
  description?: string;
  failedChecks?: number;
}

let output: string;
try {
  output = execFileSync(
    "docker",
    [
      "run",
      "--rm",
      "--platform",
      "linux/amd64",
      "-v",
      `${dir}:/data:ro`,
      VERAPDF_IMAGE,
      "--flavour",
      "ua1",
      "--format",
      "json",
      ...files.map((f) => `/data/${f}`),
    ],
    { encoding: "utf8", maxBuffer: 256 << 20, stdio: ["ignore", "pipe", "inherit"] },
  );
} catch (error) {
  // veraPDF exits 1 when a file fails; its report is still on stdout.
  const stdout = (error as { stdout?: string }).stdout;
  if (!stdout) {
    console.error(`veraPDF could not run (${VERAPDF_IMAGE}). Is Docker running?`);
    process.exit(1);
  }
  output = stdout;
}

const jobs = (JSON.parse(output) as { report?: { jobs?: Job[] } }).report?.jobs ?? [];
let failed = 0;
for (const job of jobs) {
  const name = (job.itemDetails?.name ?? "?").replace(/^\/data\//, "");
  const result = job.validationResult?.[0];
  if (result?.compliant) {
    console.log(`PASS ${name}`);
    continue;
  }
  failed += 1;
  console.log(`FAIL ${name}`);
  for (const rule of result?.details?.ruleSummaries ?? []) {
    console.log(
      `  ${rule.clause}-${rule.testNumber} (${rule.failedChecks} checks): ${rule.description}`,
    );
  }
}
if (jobs.length !== files.length) {
  console.error(`veraPDF reported ${jobs.length} of ${files.length} files.`);
  failed += 1;
}
if (!process.argv.includes("--keep")) rmSync(dir, { recursive: true, force: true });
if (failed > 0) {
  console.error(`veraPDF PDF/UA-1: ${failed} problem(s).`);
  process.exit(1);
}
console.log(`veraPDF PDF/UA-1: all ${files.length} documents pass (${VERAPDF_IMAGE}).`);
