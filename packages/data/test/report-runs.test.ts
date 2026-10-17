import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import type { ReportDefinition } from "../src/report-builder.ts";
import {
  REPORT_RESULTS_BUCKET,
  RUN_ROW_LIMIT,
  resultPath,
  runReportJobs,
  type ReportRunRecord,
  type ReportRunStore,
  type RunLabels,
  type RunOutcome,
} from "../src/report-runs.ts";

const definition: ReportDefinition = {
  id: "def-1",
  name: "Spend by Account",
  sourceCode: "finance",
  customObjectTypeId: null,
  chart: "Table",
  groupBy: "account_code",
  shared: false,
  mine: true,
  fields: [{ field: "extended_minor", aggregate: "Sum" }],
  filters: [],
};

const run: ReportRunRecord = {
  orgId: "org-1",
  reportDefinitionId: "def-1",
  membershipId: "m-1",
  exportFormat: "CSV",
  runStatus: "Queued",
};

const labels: RunLabels = {
  field: (_source, key) => (key === "account_code" ? "Account" : "Extended"),
  column: (_source, key, aggregate) =>
    `${aggregate} of ${key === "extended_minor" ? "Extended" : key}`,
};

/** An in-memory store recording every call the worker makes. */
function fakeStore(options: {
  run?: ReportRunRecord | null;
  rows?: Record<string, unknown>[] | Error;
  jobStatusOnFailure?: string;
}) {
  const calls = {
    started: [] as string[],
    finished: [] as { runId: string; outcome: RunOutcome }[],
    jobs: [] as { jobId: string; succeeded: boolean; error: string | null }[],
    rowsAsked: [] as { columns: readonly string[]; limit: number }[],
  };
  const store: ReportRunStore = {
    claim: async () => [{ jobId: "job-1", runId: "run-1" }],
    run: async () => (options.run === undefined ? run : options.run),
    definition: async () => definition,
    start: async (runId) => {
      calls.started.push(runId);
    },
    rows: async (_runId, columns, limit) => {
      calls.rowsAsked.push({ columns, limit });
      if (options.rows instanceof Error) throw options.rows;
      return options.rows ?? [];
    },
    finish: async (runId, outcome) => {
      calls.finished.push({ runId, outcome });
    },
    finishJob: async (jobId, succeeded, error) => {
      calls.jobs.push({ jobId, succeeded, error });
      return succeeded ? "Succeeded" : (options.jobStatusOnFailure ?? "Queued");
    },
  };
  return { store, calls };
}

function fakeStorage() {
  const files: { bucket: string; name: string; body: string | Uint8Array; contentType: string }[] =
    [];
  return {
    files,
    storage: {
      upload: async (
        bucket: string,
        name: string,
        body: string | Uint8Array,
        contentType: string,
      ) => {
        files.push({ bucket, name, body, contentType });
      },
    },
  };
}

describe("the report.run worker", () => {
  it("reads as the run's person, aggregates like the preview and stores the CSV", async () => {
    const { store, calls } = fakeStore({
      rows: [
        { account_code: "4000", extended_minor: 1000, currency_code: "USD" },
        { account_code: "4000", extended_minor: 2550, currency_code: "USD" },
        { account_code: "5000", extended_minor: null, currency_code: "USD" },
        { account_code: "5000", extended_minor: 700, currency_code: "USD" },
      ],
    });
    const { storage, files } = fakeStorage();
    const results = await runReportJobs({ store, storage, labels, worker: "test" });
    expect(results).toEqual([{ jobId: "job-1", runId: "run-1", status: "Succeeded" }]);
    expect(calls.started).toEqual(["run-1"]);
    expect(calls.rowsAsked).toEqual([
      { columns: ["extended_minor", "account_code", "currency_code"], limit: RUN_ROW_LIMIT + 1 },
    ]);
    expect(files).toEqual([
      {
        bucket: REPORT_RESULTS_BUCKET,
        name: "org-1/run-1.csv",
        contentType: "text/csv",
        // An unpriced line makes its group's total blank, never a smaller number (Section 3.7).
        body: "Account,Sum of Extended\n4000,35.50 USD\n5000,\n",
      },
    ]);
    expect(calls.finished).toEqual([
      {
        runId: "run-1",
        outcome: {
          status: "Succeeded",
          path: resultPath("org-1", "run-1"),
          rowCount: 2,
          unpricedCount: 1,
        },
      },
    ]);
    expect(calls.jobs).toEqual([{ jobId: "job-1", succeeded: true, error: null }]);
  });

  it("puts a failed attempt back in the queue while the job has attempts left", async () => {
    const { store, calls } = fakeStore({ rows: new Error("report_run_rows: connection reset") });
    const { storage, files } = fakeStorage();
    const results = await runReportJobs({ store, storage, labels, worker: "test" });
    expect(results[0]?.status).toBe("Queued");
    expect(files).toEqual([]);
    expect(calls.jobs).toEqual([
      { jobId: "job-1", succeeded: false, error: "report_run_rows: connection reset" },
    ]);
    expect(calls.finished).toEqual([
      { runId: "run-1", outcome: { status: "Queued", error: "report_run_rows: connection reset" } },
    ]);
  });

  it("marks the run Failed when the queue has used the job's attempts", async () => {
    const { store, calls } = fakeStore({
      rows: new Error("report_run_rows: permission denied"),
      jobStatusOnFailure: "Failed",
    });
    const { storage } = fakeStorage();
    const results = await runReportJobs({ store, storage, labels, worker: "test" });
    expect(results[0]).toMatchObject({
      status: "Failed",
      error: "report_run_rows: permission denied",
    });
    expect(calls.finished[0]?.outcome.status).toBe("Failed");
  });

  const rows = [
    { account_code: "4000", extended_minor: 1000, currency_code: "USD" },
    { account_code: "4000", extended_minor: 2550, currency_code: "USD" },
    { account_code: "5000", extended_minor: null, currency_code: "USD" },
    { account_code: "5000", extended_minor: 700, currency_code: "USD" },
  ];
  const fileLabels: RunLabels = {
    ...labels,
    unpriced: "Unpriced",
    subtitle: ({ rows: n, unpriced }) => `${n} rows, ${unpriced} unpriced`,
    truncated: "Cut at the row limit.",
  };

  it("stores an .xlsx run with NULL-aware totals and the unpriced count (A38-004)", async () => {
    const { store, calls } = fakeStore({ run: { ...run, exportFormat: "XLSX" }, rows });
    const { storage, files } = fakeStorage();
    const results = await runReportJobs({ store, storage, labels: fileLabels, worker: "test" });
    expect(results[0]?.status).toBe("Succeeded");
    expect(files[0]).toMatchObject({
      name: "org-1/run-1.xlsx",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(files[0]?.body as unknown as ArrayBuffer);
    const sheet = workbook.worksheets[0];
    expect(sheet?.getCell("A1").value).toBe("Spend by Account");
    expect(sheet?.getCell("A2").value).toBe("2 rows, 1 unpriced");
    expect(sheet?.getRow(4).values).toEqual([undefined, "Account", "Sum of Extended", "Unpriced"]);
    expect(sheet?.getRow(5).values).toEqual([undefined, "4000", 35.5, 0]);
    // The unpriced line leaves the group's total blank and is counted beside it.
    expect(sheet?.getCell("B6").value).toBeNull();
    expect(sheet?.getCell("C6").value).toBe(1);
    expect(calls.finished[0]?.outcome).toMatchObject({
      status: "Succeeded",
      path: "org-1/run-1.xlsx",
    });
  });

  it("stores a PDF run (A38-004)", async () => {
    const { store, calls } = fakeStore({ run: { ...run, exportFormat: "PDF" }, rows });
    const { storage, files } = fakeStorage();
    await runReportJobs({ store, storage, labels: fileLabels, worker: "test" });
    expect(files[0]).toMatchObject({ name: "org-1/run-1.pdf", contentType: "application/pdf" });
    const body = files[0]?.body as Uint8Array;
    expect(new TextDecoder().decode(body.slice(0, 5))).toBe("%PDF-");
    expect(body.length).toBeGreaterThan(1000);
    expect(calls.finished[0]?.outcome).toMatchObject({ status: "Succeeded", unpricedCount: 1 });
    expect(resultPath("org-1", "run-1", "PDF")).toBe("org-1/run-1.pdf");
  });

  it("skips a job whose run is gone or already finished", async () => {
    const { store, calls } = fakeStore({ run: { ...run, runStatus: "Succeeded" } });
    const { storage } = fakeStorage();
    const results = await runReportJobs({ store, storage, labels, worker: "test" });
    expect(results[0]?.status).toBe("Skipped");
    expect(calls.started).toEqual([]);
    expect(calls.jobs).toEqual([{ jobId: "job-1", succeeded: true, error: null }]);
    const gone = fakeStore({ run: null });
    expect(
      (await runReportJobs({ store: gone.store, storage, labels, worker: "test" }))[0]?.status,
    ).toBe("Skipped");
  });
});
