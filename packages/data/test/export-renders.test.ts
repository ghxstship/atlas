import type { SupabaseClient } from "@supabase/supabase-js";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPORT_COPY,
  EXPORT_FILES_BUCKET,
  EXPORT_ROW_LIMITS,
  exportFilePath,
  renderExportCsv,
  renderExportPdf,
  renderExportXlsx,
  runExportRenders,
  sheetName,
  supabaseExportRenderStore,
  type ClaimedExport,
  type ExportColumn,
  type ExportCopy,
  type ExportOutcome,
  type ExportRenderStore,
} from "../src/export-renders.ts";
import { pdfPageCount, pdfPageTexts } from "./pdf-text.ts";

/**
 * The export.render worker (A102, migration 1680): the CSV and .xlsx carry the recorded columns in order under
 * their headers, a Confidential or Restricted PDF carries the requester and the time on every page (S8.6-03), and
 * each attempt is recorded so a failure retries and an expired file is removed.
 */
const columns: ExportColumn[] = [
  { name: "role_code", header: "Role" },
  { name: "pay_basis", header: "Pay basis" },
  { name: "rate_minor", header: "Rate (minor units)" },
];

const rows = [
  { role_code: "GRIP", pay_basis: "Hourly", rate_minor: 4500 },
  { role_code: '=HYPERLINK("x")', pay_basis: "Day, flat", rate_minor: null },
];

const claimed: ClaimedExport = {
  jobId: "job-1",
  exportId: "exp-1",
  orgId: "org-1",
  format: "CSV",
  label: "Rate cards",
  classification: "Internal",
  watermark: false,
  requestedAt: "2026-10-23T14:00:00Z",
  requesterEmail: "carol@northwind.test",
  locale: "en-US",
  timeZone: "America/New_York",
};

const copy: ExportCopy = {
  subtitle: ({ rows: n }) => `${n} rows`,
  truncated: ({ limit }) => `First ${limit} rows only.`,
  watermark: ({ email, timeZone }) => `Exported by ${email} on Oct 23, 2026 (${timeZone})`,
};

function fakeStore(options: {
  claim?: ClaimedExport[];
  rows?: Record<string, unknown>[] | Error;
  statusOnFailure?: string;
  expired?: { exportId: string; path: string }[];
}) {
  const calls = {
    finished: [] as { jobId: string; outcome: ExportOutcome }[],
    rowsAsked: [] as { exportId: string; limit: number }[],
    expired: [] as string[],
  };
  const store: ExportRenderStore = {
    claim: async () => options.claim ?? [claimed],
    columns: async () => columns,
    rows: async (exportId, limit) => {
      calls.rowsAsked.push({ exportId, limit });
      if (options.rows instanceof Error) throw options.rows;
      return options.rows ?? rows;
    },
    finish: async (jobId, outcome) => {
      calls.finished.push({ jobId, outcome });
      return outcome.ok ? "Ready" : (options.statusOnFailure ?? "Queued");
    },
    expired: async () => options.expired ?? [],
    markExpired: async (exportId) => {
      calls.expired.push(exportId);
    },
  };
  return { store, calls };
}

function fakeFiles(removeFails = false) {
  const uploads: {
    bucket: string;
    name: string;
    body: string | Uint8Array;
    contentType: string;
  }[] = [];
  const removed: string[] = [];
  return {
    uploads,
    removed,
    files: {
      upload: async (
        bucket: string,
        name: string,
        body: string | Uint8Array,
        contentType: string,
      ) => {
        uploads.push({ bucket, name, body, contentType });
      },
      remove: async (_bucket: string, names: readonly string[]) => {
        if (removeFails) throw new Error("storage unavailable");
        removed.push(...names);
      },
    },
  };
}

describe("export files", () => {
  it("writes the CSV columns in order under their headers, NULL empty and formulas neutralized", () => {
    expect(renderExportCsv(columns, rows)).toBe(
      'Role,Pay basis,Rate (minor units)\nGRIP,Hourly,4500\n"\'=HYPERLINK(""x"")","Day, flat",\n',
    );
  });

  it("writes the .xlsx columns with the header row frozen and numbers as numbers", async () => {
    const body = await renderExportXlsx({
      label: "Rate cards: 2026/27",
      columns,
      rows,
      note: null,
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(body as unknown as ArrayBuffer);
    const sheet = workbook.worksheets[0];
    expect(sheet?.name).toBe("Rate cards  2026 27");
    expect(sheet?.getRow(1).values).toEqual([undefined, "Role", "Pay basis", "Rate (minor units)"]);
    expect(sheet?.getRow(1).font?.bold).toBe(true);
    expect(sheet?.getRow(2).values).toEqual([undefined, "GRIP", "Hourly", 4500]);
    expect(sheet?.getCell("C3").value).toBeNull();
    expect(sheet?.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    expect(sheet?.rowCount).toBe(3);
  });

  it("keeps sheet names Excel accepts", () => {
    expect(sheetName("A/B?C*D[E]F:G\\H")).toBe("A B C D E F G H");
    expect(sheetName("x".repeat(40))).toHaveLength(31);
    expect(sheetName("///")).toBe("Export");
  });

  it("stamps the requester and the time on every page of a watermarked PDF (S8.6-03)", async () => {
    const many = Array.from({ length: 120 }, (_, i) => ({
      role_code: `ROLE${i}`,
      pay_basis: "Hourly",
      rate_minor: 1000 + i,
    }));
    const mark = "Exported by carol@northwind.test on Oct 23, 2026, 2:05 PM EDT";
    const body = await renderExportPdf({
      label: "Rate cards",
      subtitle: "120 rows",
      columns,
      rows: many,
      note: null,
      watermark: mark,
    });
    const pages = pdfPageTexts(body);
    expect(pdfPageCount(body)).toBeGreaterThan(2);
    expect(pages).toHaveLength(pdfPageCount(body));
    for (const page of pages) {
      expect(page.split(mark).length - 1).toBe(2);
      // The header repeats on every page.
      expect(page).toContain("Rate (minor units)");
    }
    expect(pages[0]).toContain("Rate cards");
    expect(pages.at(-1)).toContain("ROLE119");
  });

  it("leaves an unmarked PDF without any viewer", async () => {
    const body = await renderExportPdf({
      label: "Rate cards",
      subtitle: "2 rows",
      columns,
      rows,
      note: null,
      watermark: null,
    });
    const text = pdfPageTexts(body).join("\n");
    expect(text).toContain("GRIP");
    expect(text).not.toContain("Exported by");
  });

  it("names each file as private.export_file_path does", () => {
    expect(exportFilePath("org-1", "exp-1", "XLSX")).toBe("org-1/exp-1.xlsx");
  });
});

describe("the export.render worker", () => {
  it("reads as the requester, stores the file at its path and records it Ready", async () => {
    const { store, calls } = fakeStore({});
    const { files, uploads } = fakeFiles();
    const outcome = await runExportRenders({ store, files, copy: () => copy, worker: "test" });
    expect(outcome.renders).toEqual([{ jobId: "job-1", exportId: "exp-1", status: "Ready" }]);
    expect(calls.rowsAsked).toEqual([{ exportId: "exp-1", limit: EXPORT_ROW_LIMITS.CSV + 1 }]);
    expect(uploads).toEqual([
      {
        bucket: EXPORT_FILES_BUCKET,
        name: "org-1/exp-1.csv",
        body: renderExportCsv(columns, rows),
        contentType: "text/csv",
      },
    ]);
    expect(calls.finished).toEqual([
      { jobId: "job-1", outcome: { ok: true, path: "org-1/exp-1.csv", rowCount: 2 } },
    ]);
  });

  it("watermarks a Restricted PDF in the requester's language and time zone", async () => {
    const { store } = fakeStore({
      claim: [{ ...claimed, format: "PDF", classification: "Restricted", watermark: true }],
    });
    const { files, uploads } = fakeFiles();
    const locales: string[] = [];
    await runExportRenders({
      store,
      files,
      copy: (locale) => {
        locales.push(locale);
        return copy;
      },
      worker: "test",
    });
    expect(locales).toEqual(["en-US"]);
    expect(uploads[0]).toMatchObject({ name: "org-1/exp-1.pdf", contentType: "application/pdf" });
    const pages = pdfPageTexts(uploads[0]?.body as Uint8Array);
    for (const page of pages) {
      expect(page).toContain("Exported by carol@northwind.test on Oct 23, 2026 (America/New_York)");
    }
  });

  it("cuts a file at its format's limit and says so", async () => {
    const many = Array.from({ length: EXPORT_ROW_LIMITS.PDF + 1 }, (_, i) => ({
      role_code: `R${i}`,
      pay_basis: "Hourly",
      rate_minor: i,
    }));
    const { store, calls } = fakeStore({ claim: [{ ...claimed, format: "XLSX" }], rows: many });
    const { files, uploads } = fakeFiles();
    await runExportRenders({ store, files, copy: () => copy, worker: "test" });
    expect(calls.finished[0]?.outcome).toEqual({
      ok: true,
      path: "org-1/exp-1.xlsx",
      rowCount: EXPORT_ROW_LIMITS.PDF + 1,
    });
    const pdf = fakeStore({ claim: [{ ...claimed, format: "PDF" }], rows: many });
    await runExportRenders({ store: pdf.store, files, copy: () => copy, worker: "test" });
    expect(pdf.calls.rowsAsked[0]?.limit).toBe(EXPORT_ROW_LIMITS.PDF + 1);
    expect(pdf.calls.finished[0]?.outcome).toMatchObject({ rowCount: EXPORT_ROW_LIMITS.PDF });
    const text = pdfPageTexts(uploads[1]?.body as Uint8Array).join("\n");
    expect(text).toContain(`First ${EXPORT_ROW_LIMITS.PDF} rows only.`);
  });

  it("records a failure with its reason, Queued while the job retries and Failed after", async () => {
    const refused = new Error("export_job_rows: permission denied for view rate_card_lines_masked");
    const retrying = fakeStore({ rows: refused });
    const { files, uploads } = fakeFiles();
    const first = await runExportRenders({
      store: retrying.store,
      files,
      copy: () => copy,
      worker: "t",
    });
    expect(first.renders).toEqual([
      { jobId: "job-1", exportId: "exp-1", status: "Queued", error: refused.message },
    ]);
    expect(retrying.calls.finished).toEqual([
      { jobId: "job-1", outcome: { ok: false, error: refused.message } },
    ]);
    const last = fakeStore({ rows: refused, statusOnFailure: "Failed" });
    const second = await runExportRenders({
      store: last.store,
      files,
      copy: () => copy,
      worker: "t",
    });
    expect(second.renders[0]?.status).toBe("Failed");
    expect(uploads).toEqual([]);
  });

  it("never writes a watermarked PDF without the requester's email", async () => {
    const { store, calls } = fakeStore({
      claim: [
        {
          ...claimed,
          format: "PDF",
          classification: "Confidential",
          watermark: true,
          requesterEmail: null,
        },
      ],
    });
    const { files, uploads } = fakeFiles();
    await runExportRenders({ store, files, copy: () => DEFAULT_EXPORT_COPY, worker: "test" });
    expect(uploads).toEqual([]);
    expect(calls.finished[0]?.outcome).toMatchObject({ ok: false });
  });

  it("removes expired files before marking their exports Expired", async () => {
    const due = [{ exportId: "exp-old", path: "org-1/exp-old.csv" }];
    const { store, calls } = fakeStore({ claim: [], expired: due });
    const { files, removed } = fakeFiles();
    expect((await runExportRenders({ store, files, copy: () => copy, worker: "t" })).expired).toBe(
      1,
    );
    expect(removed).toEqual(["org-1/exp-old.csv"]);
    expect(calls.expired).toEqual(["exp-old"]);

    const kept = fakeStore({ claim: [], expired: due });
    const failing = fakeFiles(true);
    const warnings: string[] = [];
    const outcome = await runExportRenders({
      store: kept.store,
      files: failing.files,
      copy: () => copy,
      worker: "t",
      warn: (m) => warnings.push(m),
    });
    expect(outcome.expired).toBe(0);
    expect(kept.calls.expired).toEqual([]);
    expect(warnings[0]).toContain("org-1/exp-old.csv");
  });
});

/** A service-role client whose RPCs answer from `answers` by name, recording each call. */
function rpcClient(
  answers: Record<string, { data: unknown; error: { message: string } | null }>,
  calls: unknown[][],
): SupabaseClient {
  return {
    schema: () => ({
      rpc: async (...args: unknown[]) => {
        calls.push(args);
        return answers[args[0] as string] ?? { data: null, error: { message: "unexpected" } };
      },
    }),
  } as unknown as SupabaseClient;
}

describe("supabaseExportRenderStore", () => {
  it("maps a claim and finishes through the 1680 RPCs", async () => {
    const calls: unknown[][] = [];
    const store = supabaseExportRenderStore(
      rpcClient(
        {
          claim_export_renders: {
            data: [
              {
                job_id: "job-1",
                export_job_id: "exp-1",
                org_id: "org-1",
                export_format: "PDF",
                source_label: "Rate cards",
                classification: "Restricted",
                watermark: true,
                requested_at: "2026-10-23T14:00:00Z",
                requester_email: "carol@northwind.test",
                locale: "es-US",
                time_zone: "America/New_York",
              },
            ],
            error: null,
          },
          finish_export_render: { data: "Ready", error: null },
        },
        calls,
      ),
    );
    expect(await store.claim("worker-1", 3)).toEqual([
      { ...claimed, format: "PDF", classification: "Restricted", watermark: true, locale: "es-US" },
    ]);
    expect(await store.finish("job-1", { ok: true, path: "org-1/exp-1.pdf", rowCount: 2 })).toBe(
      "Ready",
    );
    expect(calls).toEqual([
      ["claim_export_renders", { p_worker: "worker-1", p_limit: 3 }],
      [
        "finish_export_render",
        {
          p_job_id: "job-1",
          p_succeeded: true,
          p_storage_object_path: "org-1/exp-1.pdf",
          p_row_count: 2,
        },
      ],
    ]);
  });

  it("reads rows from the replica with GET and falls back to the primary when it refuses", async () => {
    const primaryCalls: unknown[][] = [];
    const replicaCalls: unknown[][] = [];
    const fallbacks: string[] = [];
    const primary = rpcClient(
      { export_job_rows: { data: [{ role_code: "GRIP" }], error: null } },
      primaryCalls,
    );
    const replica = rpcClient(
      { export_job_rows: { data: null, error: { message: "export_not_rendering" } } },
      replicaCalls,
    );
    const store = supabaseExportRenderStore(primary, {
      replica,
      onReplicaFallback: (label) => fallbacks.push(label),
    });
    expect(await store.rows("exp-1", 11)).toEqual([{ role_code: "GRIP" }]);
    expect(replicaCalls).toEqual([
      ["export_job_rows", { p_export_job_id: "exp-1", p_limit: 11 }, { get: true }],
    ]);
    expect(primaryCalls).toEqual([["export_job_rows", { p_export_job_id: "exp-1", p_limit: 11 }]]);
    expect(fallbacks).toEqual(["export rows"]);
  });
});
