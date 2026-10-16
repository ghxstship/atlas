import type { SupabaseClient } from "@supabase/supabase-js";
import type { XosClient } from "./client.ts";
import {
  getReportDefinition,
  planReport,
  previewCsv,
  summarizeReport,
  unpricedRows,
  type Aggregate,
  type ReportDefinition,
} from "./report-builder.ts";

/**
 * The report.run worker (A35, RRR-79; migration 1050). A18 queues a report.run job for every run
 * (app.run_report); this worker claims them from the 0510 job queue and, for each, reads the source
 * rows as the person the run is for (app.report_run_rows switches to their identity, so their row
 * level security applies), aggregates them exactly as the builder preview does, stores the CSV in the
 * private report-results bucket and records the outcome. A failed attempt goes back to Queued while
 * the job has attempts left, then the run is marked Failed with its error.
 */
export const REPORT_RUN_JOB = "report.run";
export const REPORT_RESULTS_BUCKET = "report-results";
/** Source rows a run reads at most; the run file says so when it is cut. */
export const RUN_ROW_LIMIT = 50_000;

export interface ClaimedReportRun {
  readonly jobId: string;
  readonly runId: string;
}

export interface ReportRunRecord {
  readonly orgId: string;
  readonly reportDefinitionId: string;
  readonly membershipId: string;
  readonly exportFormat: "CSV" | "XLSX" | "PDF";
  readonly runStatus: string;
}

export type RunOutcome =
  | {
      readonly status: "Succeeded";
      readonly path: string;
      readonly rowCount: number;
      readonly unpricedCount: number;
    }
  | { readonly status: "Failed" | "Queued"; readonly error: string };

/** The database side of the worker; supabaseReportRunStore implements it over the service role. */
export interface ReportRunStore {
  claim(worker: string, limit: number): Promise<readonly ClaimedReportRun[]>;
  run(runId: string): Promise<ReportRunRecord | null>;
  definition(id: string, membershipId: string): Promise<ReportDefinition | null>;
  start(runId: string): Promise<void>;
  rows(
    runId: string,
    columns: readonly string[],
    limit: number,
  ): Promise<Record<string, unknown>[]>;
  finish(runId: string, outcome: RunOutcome): Promise<void>;
  /** Records the job attempt; answers the job's status after it (Queued means it will retry). */
  finishJob(jobId: string, succeeded: boolean, error: string | null): Promise<string>;
}

export interface ResultStorage {
  upload(bucket: string, name: string, body: string, contentType: string): Promise<void>;
}

/** Column headers of a run file, in the person's language where the caller knows it. */
export interface RunLabels {
  field(sourceCode: string, key: string): string;
  column(sourceCode: string, key: string, aggregate: Aggregate): string;
}

export interface ReportRunResult {
  readonly jobId: string;
  readonly runId: string;
  readonly status: "Succeeded" | "Failed" | "Queued" | "Skipped";
  readonly error?: string;
}

/** The object name of a run's CSV, the same as private.report_result_path. */
export function resultPath(orgId: string, runId: string): string {
  return `${orgId}/${runId}.csv`;
}

/** Builds the CSV of one running run, as its person; throws an Error whose message is for the person. */
async function renderRun(
  store: ReportRunStore,
  labels: RunLabels,
  runId: string,
  run: ReportRunRecord,
): Promise<{ csv: string; rowCount: number; unpricedCount: number }> {
  if (run.exportFormat !== "CSV") {
    throw new Error(
      `${run.exportFormat} report files are not available yet. Run the report as CSV.`,
    );
  }
  const definition = await store.definition(run.reportDefinitionId, run.membershipId);
  if (!definition) throw new Error("The report no longer exists.");
  const plan = planReport(definition);
  if (!plan) throw new Error(`The report's source ${definition.sourceCode} cannot be read.`);
  if (plan.columns.length === 0)
    throw new Error("The report has no columns. Add a field and run it again.");
  const rows = await store.rows(runId, plan.select, RUN_ROW_LIMIT + 1);
  const truncated = rows.length > RUN_ROW_LIMIT;
  const summary = summarizeReport(plan, truncated ? rows.slice(0, RUN_ROW_LIMIT) : rows, truncated);
  const code = definition.sourceCode;
  const csv = previewCsv(
    summary,
    summary.columns.map((c) =>
      c.aggregate === "None"
        ? labels.field(code, c.field)
        : labels.column(code, c.field, c.aggregate),
    ),
    plan.group ? labels.field(code, plan.group) : null,
  );
  return { csv, rowCount: summary.rows.length, unpricedCount: unpricedRows(summary) };
}

/** One pass of the worker: claims ready report.run jobs and runs one attempt of each. */
export async function runReportJobs(options: {
  readonly store: ReportRunStore;
  readonly storage: ResultStorage;
  readonly labels: RunLabels;
  readonly worker: string;
  readonly limit?: number;
}): Promise<readonly ReportRunResult[]> {
  const { store, storage, labels, worker } = options;
  const claimed = await store.claim(worker, options.limit ?? 5);
  const results: ReportRunResult[] = [];
  for (const job of claimed) {
    const run = await store.run(job.runId);
    if (!run || run.runStatus !== "Queued") {
      // Deleted, or already finished by an earlier attempt: nothing left to do for this job.
      await store.finishJob(job.jobId, true, null);
      results.push({ jobId: job.jobId, runId: job.runId, status: "Skipped" });
      continue;
    }
    await store.start(job.runId);
    try {
      const out = await renderRun(store, labels, job.runId, run);
      const path = resultPath(run.orgId, job.runId);
      await storage.upload(REPORT_RESULTS_BUCKET, path, out.csv, "text/csv");
      await store.finish(job.runId, {
        status: "Succeeded",
        path,
        rowCount: out.rowCount,
        unpricedCount: out.unpricedCount,
      });
      await store.finishJob(job.jobId, true, null);
      results.push({ jobId: job.jobId, runId: job.runId, status: "Succeeded" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The queue retries with backoff until the kind's attempts are used, then marks the job Failed.
      const jobStatus = await store.finishJob(job.jobId, false, message);
      const status = jobStatus === "Queued" ? "Queued" : "Failed";
      await store.finish(job.runId, { status, error: message });
      results.push({ jobId: job.jobId, runId: job.runId, status, error: message });
    }
  }
  return results;
}

function text(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string")
    throw new Error(`Expected text in ${key} of the database response.`);
  return value;
}

/** ReportRunStore over the service-role client: the 0510 queue RPCs and the 1050 run RPCs. */
export function supabaseReportRunStore(client: SupabaseClient): ReportRunStore {
  const app = client.schema("app");
  const call = async (fn: string, args: Record<string, unknown>): Promise<unknown> => {
    const { data, error } = await app.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data;
  };
  return {
    async claim(worker, limit) {
      const rows = (await call("claim_jobs", {
        p_worker: worker,
        p_job_kind: REPORT_RUN_JOB,
        p_limit: limit,
      })) as Record<string, unknown>[] | null;
      return (rows ?? []).map((r) => ({ jobId: text(r, "id"), runId: text(r, "subject_id") }));
    },
    async run(runId) {
      const { data, error } = await app
        .from("report_runs")
        .select("org_id, report_definition_id, run_for_membership_id, export_format, run_status")
        .eq("id", runId)
        .is("deleted_at", null)
        .maybeSingle();
      if (error) throw new Error(`report_runs: ${error.message}`);
      if (!data) return null;
      const row = data as Record<string, unknown>;
      return {
        orgId: text(row, "org_id"),
        reportDefinitionId: text(row, "report_definition_id"),
        membershipId: text(row, "run_for_membership_id"),
        exportFormat: text(row, "export_format") as ReportRunRecord["exportFormat"],
        runStatus: text(row, "run_status"),
      };
    },
    async definition(id, membershipId) {
      const result = await getReportDefinition(app as unknown as XosClient, { id, membershipId });
      if (result.ok) return result.data;
      if (result.error.kind === "not-found") return null;
      throw new Error(`report definition: ${JSON.stringify(result.error)}`);
    },
    async start(runId) {
      await call("start_report_run", { p_run_id: runId });
    },
    async rows(runId, columns, limit) {
      const rows = (await call("report_run_rows", {
        p_run_id: runId,
        p_columns: columns,
        p_limit: limit,
      })) as Record<string, unknown>[] | null;
      return rows ?? [];
    },
    async finish(runId, outcome) {
      await call(
        "finish_report_run",
        outcome.status === "Succeeded"
          ? {
              p_run_id: runId,
              p_outcome: "Succeeded",
              p_storage_object_path: outcome.path,
              p_row_count: outcome.rowCount,
              p_unpriced_count: outcome.unpricedCount,
            }
          : { p_run_id: runId, p_outcome: outcome.status, p_error: outcome.error },
      );
    },
    async finishJob(jobId, succeeded, error) {
      return String(
        await call("finish_job", { p_job_id: jobId, p_succeeded: succeeded, p_error: error }),
      );
    },
  };
}

/** ResultStorage over Supabase Storage of the service-role client; an existing file is replaced. */
export function supabaseResultStorage(client: SupabaseClient): ResultStorage {
  return {
    async upload(bucket, name, body, contentType) {
      const { error } = await client.storage
        .from(bucket)
        .upload(name, new Blob([body], { type: contentType }), { contentType, upsert: true });
      if (error) throw new Error(`storage ${bucket}: ${error.message}`);
    },
  };
}
