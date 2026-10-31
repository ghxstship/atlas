import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { certifiedPayrollModel } from "../src/certified-payroll.ts";
import { buildDeletionCertificateModel } from "../src/documents/deletion-certificate.ts";
import { buildDocumentModel, sharedImageModel, watermarkText } from "../src/documents/generate.ts";
import { DOCUMENT_KINDS, PAPERS, type PrintSize } from "../src/documents/model.ts";
import { renderDocumentPdf, renderDocumentsPdf } from "../src/documents/render.ts";
import { osha300Model, osha300aModel, osha301Model } from "../src/osha.ts";
import {
  CASES,
  ESTABLISHMENT,
  PAYROLL,
  SUMMARY,
  TOTALS,
} from "../test/documents/compliance-fixtures.ts";
import {
  BADGE_V2,
  BRAND,
  DELETION_CERTIFICATE,
  FIXTURES,
  LOGO_PNG,
  NOW,
  PHOTO_JPEG,
  PHOTO_PNG,
} from "../test/documents/fixtures.ts";

/**
 * Section 18 gate 19: renders every Section 11.9 template from fixture data, on US Letter and A4, in
 * en-US and es-US, and validates each file against PDF/UA-1 with veraPDF in its pinned Docker image
 * (ADR 0031). It also renders the Section 8.6 watermarked copies (a Confidential document and a
 * shared image), so the watermark keeps the files compliant, and the Section 14.5 compliance forms
 * (OSHA Forms 300, 300A and 301 and the WH-347, ADR 0041), and the P5 credential badges: CR80 and A6 cards
 * with and without a photo, version 2 on Letter and A4 with a photo, and 3-badge batches on CR80 and Letter
 * (8 files per locale), and the B8 guest pass on A6 and CR80 cards (the per-kind loop renders it on Letter and A4).
 * The per-kind loop keeps the version 1 badge, issued before BADGE_V2_FROM. Exits 1 when any file is not compliant or
 * veraPDF cannot run.
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
// mkdtemp makes the folder owner-only; on Linux the veraPDF container runs as another user and
// would see no files at all. The PDFs hold fixture data only.
chmodSync(dir, 0o755);
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
      writeFileSync(join(dir, name), await renderDocumentPdf(model, { paper }), { mode: 0o644 });
      files.push(name);
    }
  }
  // P5 badges: the card layout, the portrait and the gate code, and the batch file.
  const badge = (paper: PrintSize, photo: Uint8Array | null, number = BADGE_V2.credential.number) =>
    buildDocumentModel(
      "credential-badge",
      {
        ...BADGE_V2,
        credential: { ...BADGE_V2.credential, number },
        photo: photo ? { bytes: photo, source: "Badge" } : null,
      },
      {
        locale,
        messages,
        brand: BRAND,
        recordUrl: "https://atlas.example.test/northwind/documents/credential-badge",
        now: NOW,
        paper,
      },
    );
  for (const [name, model, paper] of [
    [`credential-badge-photo.${locale}.cr80.pdf`, badge("cr80", PHOTO_JPEG), "cr80"],
    [`credential-badge-no-photo.${locale}.cr80.pdf`, badge("cr80", null), "cr80"],
    [`credential-badge-photo.${locale}.a6.pdf`, badge("a6", PHOTO_PNG), "a6"],
    [`credential-badge-no-photo.${locale}.a6.pdf`, badge("a6", null), "a6"],
    [`credential-badge-v2-photo.${locale}.letter.pdf`, badge("letter", PHOTO_JPEG), "letter"],
    [`credential-badge-v2-photo.${locale}.a4.pdf`, badge("a4", PHOTO_JPEG), "a4"],
  ] as const) {
    writeFileSync(join(dir, name), await renderDocumentPdf(model, { paper }), { mode: 0o644 });
    files.push(name);
  }
  for (const paper of ["cr80", "letter"] as const) {
    const name = `credential-badges-batch.${locale}.${paper}.pdf`;
    const batch = ["CR-000041", "CR-000042", "CR-000043"].map((n, i) =>
      badge(paper, i === 1 ? null : PHOTO_JPEG, n),
    );
    writeFileSync(
      join(dir, name),
      await renderDocumentsPdf(batch, { paper, title: `Credential badges (3)`, lang: locale }),
      { mode: 0o644 },
    );
    files.push(name);
  }
  // B8 guest passes on the two cards: the card layout without a portrait, the door code centred.
  for (const paper of ["a6", "cr80"] as const) {
    const name = `guest-pass.${locale}.${paper}.pdf`;
    const model = buildDocumentModel("guest-pass", FIXTURES["guest-pass"], {
      locale,
      messages,
      brand: BRAND,
      recordUrl: "https://atlas.example.test/northwind/documents/guest-pass",
      now: NOW,
      paper,
    });
    writeFileSync(join(dir, name), await renderDocumentPdf(model, { paper }), { mode: 0o644 });
    files.push(name);
  }
  // The platform's deletion certificate (A79, Section 14.7) goes through the same renderer and gate.
  const certificate = buildDeletionCertificateModel(DELETION_CERTIFICATE, {
    locale,
    messages,
    recordUrl: "https://atlas.example.test/deletion-certificates/fixture",
    now: NOW,
  });
  for (const paper of PAPERS) {
    const name = `deletion-certificate.${locale}.${paper}.pdf`;
    writeFileSync(join(dir, name), await renderDocumentPdf(certificate, { paper }), {
      mode: 0o644,
    });
    files.push(name);
  }
  // Section 8.6 watermarks: a watermarked document, landscape, and a Confidential image delivered as a PDF.
  const watermark = watermarkText(messages, locale, "viewer@example.test", NOW);
  const marked = buildDocumentModel("incident-report", FIXTURES["incident-report"], {
    locale,
    messages,
    brand: BRAND,
    recordUrl: "https://atlas.example.test/northwind/documents/incident-report",
    now: NOW,
    watermark,
  });
  for (const [name, model, orientation] of [
    [`watermarked-incident-report.${locale}.letter.pdf`, marked, "landscape"],
    [
      `shared-image.${locale}.letter.pdf`,
      sharedImageModel({
        bytes: LOGO_PNG,
        filename: "stage-plot.png",
        orgName: BRAND.name,
        locale,
        messages,
        sourceUrl: "https://atlas.example.test/share/xshr_example",
        watermark,
        now: NOW,
      }),
      "portrait",
    ],
    ...(() => {
      const forms = {
        locale,
        messages,
        brand: BRAND,
        recordUrl: "https://atlas.example.test/northwind/forms",
        watermark,
        now: NOW,
      };
      return [
        [
          `osha-300.${locale}.letter.pdf`,
          osha300Model(ESTABLISHMENT, 2026, CASES, forms),
          "landscape",
        ],
        [
          `osha-300a.${locale}.letter.pdf`,
          osha300aModel(ESTABLISHMENT, 2026, TOTALS, SUMMARY, forms),
          "portrait",
        ],
        [
          `osha-301.${locale}.letter.pdf`,
          osha301Model(ESTABLISHMENT, CASES[0] as (typeof CASES)[number], forms),
          "portrait",
        ],
        [
          `certified-payroll.${locale}.letter.pdf`,
          certifiedPayrollModel(PAYROLL, { ...forms, certifyingOfficial: "Alice Morgan" }),
          "landscape",
        ],
      ] as const;
    })(),
  ] as const) {
    writeFileSync(
      join(dir, name),
      await renderDocumentPdf(model, { paper: "letter", orientation }),
      {
        mode: 0o644,
      },
    );
    files.push(name);
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
