import { providerEntry } from "./catalog.ts";
import type { Connector, SyncOutcome } from "./connector.ts";
import { unwrap, StoreError, type DbClient } from "./db.ts";
import { asIntegrationError, IntegrationError } from "./errors.ts";
import type { HttpClient } from "./http.ts";
import type { IntegrationStore } from "./store.ts";
import { parseCredential } from "./support.ts";

/** The job kind migration 0600 registers on the A18 job queue. */
export const INTEGRATION_SYNC_JOB = "integration.sync";

/** A job claimed from `app.claim_jobs` (migration 0510). */
export interface ClaimedJob {
  readonly id: string;
  readonly subjectId: string;
  readonly attempts: number;
}

/** The A18 job queue (migration 0510): claim with SKIP LOCKED, report through finish_job. */
export interface JobQueue {
  claim(worker: string, kind: string, limit: number): Promise<readonly ClaimedJob[]>;
  finish(jobId: string, succeeded: boolean, error: string | null): Promise<string>;
}

export function supabaseJobQueue(db: DbClient): JobQueue {
  return {
    async claim(worker, kind, limit) {
      const rows = await unwrap<{ id: string; subject_id: string; attempts: number }[]>(
        db.rpc("claim_jobs", { p_worker: worker, p_job_kind: kind, p_limit: limit }),
      );
      return rows.map((r) => ({ id: r.id, subjectId: r.subject_id, attempts: r.attempts }));
    },
    async finish(jobId, succeeded, error) {
      return unwrap<string>(
        db.rpc("finish_job", { p_job_id: jobId, p_succeeded: succeeded, p_error: error }),
      );
    },
  };
}

export interface RunnerOptions {
  readonly queue: JobQueue;
  readonly store: IntegrationStore;
  readonly connectors: ReadonlyMap<string, Connector>;
  readonly http: HttpClient;
  readonly worker: string;
  readonly limit?: number;
  readonly now?: () => Date;
}

export type JobOutcome =
  | { readonly jobId: string; readonly runId: string; readonly result: "succeeded" }
  | {
      readonly jobId: string;
      readonly runId: string;
      readonly result: "retrying" | "failed";
      readonly code: string;
    }
  | {
      readonly jobId: string;
      readonly runId: string;
      readonly result: "skipped";
      readonly reason: string;
    };

/**
 * Claims ready integration.sync jobs and runs one attempt of each job's sync run. The sync run owns
 * attempts and backoff (migration 0600), so the job itself always finishes as succeeded once the
 * attempt's outcome is recorded; it finishes as failed only when recording the outcome failed, which
 * leaves the evidence on the job queue.
 */
export async function runIntegrationJobs(options: RunnerOptions): Promise<readonly JobOutcome[]> {
  const jobs = await options.queue.claim(options.worker, INTEGRATION_SYNC_JOB, options.limit ?? 10);
  const outcomes: JobOutcome[] = [];
  for (const job of jobs) {
    try {
      const outcome = await runOne(options, job);
      await options.queue.finish(job.id, true, null);
      outcomes.push(outcome);
    } catch (error) {
      // Recording the attempt itself failed (database unreachable): the job keeps the error and the
      // run stays as it was, so the next worker claim sees it again.
      const message = error instanceof Error ? error.message : String(error);
      await options.queue.finish(job.id, false, message);
      outcomes.push({
        jobId: job.id,
        runId: job.subjectId,
        result: "failed",
        code: "runner_error",
      });
    }
  }
  return outcomes;
}

async function runOne(options: RunnerOptions, job: ClaimedJob): Promise<JobOutcome> {
  const runId = job.subjectId;
  let run;
  try {
    run = await options.store.claimRun(runId, job.id);
  } catch (error) {
    // The run was canceled, is not due, or its connection is no longer Connected: nothing to attempt.
    if (error instanceof StoreError && error.error.kind === "refusal") {
      return { jobId: job.id, runId, result: "skipped", reason: error.error.rule };
    }
    throw error;
  }

  let outcome: SyncOutcome;
  try {
    const connection = await options.store.connection(run.connectionId);
    const connector = options.connectors.get(connection.providerCode);
    if (connector === undefined) {
      throw new IntegrationError(
        "connector_missing",
        `No connector is registered for ${connection.providerCode}.`,
      );
    }
    if (!connector.scopes.includes(run.scope)) {
      throw new IntegrationError(
        "scope_unsupported",
        `${connection.providerCode} does not run ${run.scope}.`,
      );
    }
    const needsCredential = providerEntry(connection.providerCode)?.needsCredential ?? true;
    const credential = needsCredential
      ? parseCredential(await options.store.credential(connection.id))
      : null;
    outcome = await connector.sync({
      run,
      connection,
      credential,
      http: options.http,
      store: options.store,
      cursor: run.cursorBefore ?? (await options.store.lastCursor(connection.id, run.scope)),
      now: options.now ?? (() => new Date()),
    });
  } catch (error) {
    const failure = asIntegrationError(error);
    const state = await options.store.failRun(run.id, failure);
    return {
      jobId: job.id,
      runId,
      result: state === "Retrying" ? "retrying" : "failed",
      code: failure.code,
    };
  }
  await options.store.completeRun(run.id, outcome.counts, outcome.cursorAfter);
  return { jobId: job.id, runId, result: "succeeded" };
}
