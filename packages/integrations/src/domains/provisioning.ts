import { asIntegrationError } from "../framework/errors.ts";
import type {
  DomainProviders,
  HostProvider,
  ProviderState,
  SendingDomainProvider,
} from "./types.ts";
import type { Database } from "@xos/data/database.types";

/**
 * The domain provisioning worker (A79, migration 1355; Section 12): claims domain.provision, domain.check and
 * domain.release jobs from the 0510 queue, calls the provider of each domain's purpose and records the outcome
 * through app.record_domain_provisioning, the only writer of the provisioning fields. A retryable provider
 * failure (rate limit, outage) goes back to the queue with its backoff; any other failure is recorded on the
 * domain as Failed with the provider's reason, and an Owner asks for another try from White label settings.
 */

export const DOMAIN_JOB_KINDS = ["domain.provision", "domain.check", "domain.release"] as const;
export type DomainJobKind = (typeof DOMAIN_JOB_KINDS)[number];

export type ProvisioningStatus = "Pending DNS" | "Active" | "Failed" | "Released";

export interface DomainJob {
  readonly id: string;
  readonly subjectId: string;
  readonly attempts: number;
}

export interface DomainRow {
  readonly id: string;
  readonly hostname: string;
  readonly purpose: Database["app"]["Enums"]["org_domain_purpose"];
  readonly providerRef: string | null;
  readonly deleted: boolean;
}

export interface DomainRecord {
  readonly status: ProvisioningStatus;
  readonly providerRef?: string;
  readonly records?: ProviderState["records"];
  readonly tlsReady?: boolean;
  readonly verified?: boolean;
  readonly error?: string;
}

export interface DomainStore {
  claim(worker: string, kind: DomainJobKind, limit: number): Promise<readonly DomainJob[]>;
  /** Returns the job's new status: Succeeded, Queued (retry) or Failed (attempts used). */
  finish(jobId: string, succeeded: boolean, error?: string): Promise<string>;
  domains(ids: readonly string[]): Promise<readonly DomainRow[]>;
  record(domainId: string, record: DomainRecord): Promise<void>;
}

export interface DomainJobResult {
  readonly jobId: string;
  readonly domainId: string;
  readonly kind: DomainJobKind;
  readonly outcome: "active" | "pending-dns" | "released" | "skipped" | "failed" | "retrying";
  readonly error?: string;
}

/** Copy the worker records when a purpose has no provider yet; Atlas translates the state, not this text. */
export const NOT_CONFIGURED: Record<DomainRow["purpose"], string> = {
  Atlas: "Custom Atlas domains are not set up on this platform yet.",
  Gateway: "Custom Gateway domains are not set up on this platform yet.",
  "Email Sending": "Custom sending domains are not set up on this platform yet.",
  "Verified Domain": "Verified domains are checked by their TXT record.",
};

function hostProvider(
  providers: DomainProviders,
  purpose: DomainRow["purpose"],
): HostProvider | null {
  if (purpose === "Atlas") return providers.atlas;
  if (purpose === "Gateway") return providers.gateway;
  return null;
}

async function provision(
  providers: DomainProviders,
  domain: DomainRow,
  kind: DomainJobKind,
): Promise<DomainRecord | null> {
  if (domain.purpose === "Verified Domain") return null;
  const sending: SendingDomainProvider | null =
    domain.purpose === "Email Sending" ? providers.sending : null;
  const host = hostProvider(providers, domain.purpose);
  if (kind === "domain.release") {
    if (!domain.providerRef) return { status: "Released" };
    if (sending) await sending.remove(domain.providerRef);
    else if (host) await host.remove(domain.providerRef);
    else return { status: "Failed", error: NOT_CONFIGURED[domain.purpose] };
    return { status: "Released" };
  }
  if (domain.deleted) return null;
  if (!sending && !host) return { status: "Failed", error: NOT_CONFIGURED[domain.purpose] };
  let state: ProviderState;
  if (kind === "domain.check" && domain.providerRef) {
    state = sending
      ? await sending.check(domain.providerRef)
      : await (host as HostProvider).check(domain.providerRef);
  } else {
    state = sending
      ? await sending.create(domain.hostname)
      : await (host as HostProvider).add(domain.hostname);
  }
  return {
    status: state.verified ? "Active" : "Pending DNS",
    providerRef: state.ref,
    records: state.records,
    tlsReady: state.tlsReady,
    verified: state.verified,
  };
}

/** One pass of the worker over every domain job kind. */
export async function runDomainJobs(options: {
  readonly store: DomainStore;
  readonly providers: DomainProviders;
  readonly worker: string;
  readonly limit?: number;
}): Promise<DomainJobResult[]> {
  const { store, providers } = options;
  const results: DomainJobResult[] = [];
  for (const kind of DOMAIN_JOB_KINDS) {
    const jobs = await store.claim(options.worker, kind, options.limit ?? 10);
    if (jobs.length === 0) continue;
    const domains = new Map(
      (await store.domains(jobs.map((j) => j.subjectId))).map((d) => [d.id, d]),
    );
    for (const job of jobs) {
      const domain = domains.get(job.subjectId);
      if (!domain) {
        await store.finish(job.id, true);
        results.push({ jobId: job.id, domainId: job.subjectId, kind, outcome: "skipped" });
        continue;
      }
      try {
        const record = await provision(providers, domain, kind);
        if (record) await store.record(domain.id, record);
        await store.finish(job.id, true);
        results.push({
          jobId: job.id,
          domainId: domain.id,
          kind,
          outcome: !record
            ? "skipped"
            : record.status === "Active"
              ? "active"
              : record.status === "Pending DNS"
                ? "pending-dns"
                : record.status === "Released"
                  ? "released"
                  : "failed",
          ...(record?.error ? { error: record.error } : {}),
        });
      } catch (error) {
        const failure = asIntegrationError(error);
        if (failure.retryable) {
          const status = await store.finish(job.id, false, failure.message);
          if (status === "Failed")
            await store.record(domain.id, { status: "Failed", error: failure.message });
          results.push({
            jobId: job.id,
            domainId: domain.id,
            kind,
            outcome: status === "Failed" ? "failed" : "retrying",
            error: failure.message,
          });
        } else {
          await store.record(domain.id, { status: "Failed", error: failure.message });
          await store.finish(job.id, true);
          results.push({
            jobId: job.id,
            domainId: domain.id,
            kind,
            outcome: "failed",
            error: failure.message,
          });
        }
      }
    }
  }
  return results;
}

// Supabase adapter ------------------------------------------------------------------------------------------------

/** The slice of a service-role Supabase client (schema app) the store calls. */
export interface RpcClient {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

export function supabaseDomainJobStore(client: RpcClient): DomainStore {
  const call = async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await client.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data;
  };
  return {
    async claim(worker, kind, limit) {
      const rows = ((await call("claim_jobs", {
        p_worker: worker,
        p_job_kind: kind,
        p_limit: limit,
      })) ?? []) as {
        id: string;
        subject_id: string;
        attempts: number;
      }[];
      return rows.map((r) => ({ id: r.id, subjectId: r.subject_id, attempts: r.attempts }));
    },
    async finish(jobId, succeeded, error) {
      return String(
        await call("finish_job", {
          p_job_id: jobId,
          p_succeeded: succeeded,
          p_error: error ?? null,
        }),
      );
    },
    async domains(ids) {
      const rows = ((await call("domains_to_provision", { p_org_domain_ids: ids })) ?? []) as {
        id: string;
        hostname: string;
        purpose: DomainRow["purpose"];
        provider_ref: string | null;
        deleted: boolean;
      }[];
      return rows.map((r) => ({
        id: r.id,
        hostname: r.hostname,
        purpose: r.purpose,
        providerRef: r.provider_ref,
        deleted: r.deleted,
      }));
    },
    async record(domainId, record) {
      await call("record_domain_provisioning", {
        p_org_domain_id: domainId,
        p_status: record.status,
        p_provider_ref: record.providerRef ?? null,
        p_dns_records: record.records ?? null,
        p_tls_ready: record.tlsReady ?? null,
        p_verified: record.verified ?? null,
        p_error: record.error ?? null,
      });
    },
  };
}
