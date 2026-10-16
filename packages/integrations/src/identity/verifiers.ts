import { unwrap, type DbClient } from "../framework/db.ts";
import { IntegrationError } from "../framework/errors.ts";
import { callJson, type HttpClient } from "../framework/http.ts";

/**
 * The verifier callers routed to A19: a job that checks pending org domains over DNS and records the
 * result through A30's app.record_domain_verification, and a job that checks organization
 * verification requests with Stripe Identity or a business registry and records them through
 * app.record_organization_check (which calls A30's app.record_organization_verification). Every
 * outside call goes through an injected client; no credential is read here.
 */

/** TXT records of a host name (node:dns resolveTxt in production), each record's strings joined. */
export type TxtResolver = (hostname: string) => Promise<readonly string[]>;

export interface PendingDomain {
  readonly id: string;
  readonly hostname: string;
  readonly token: string;
}

export interface DomainStore {
  dueDomains(limit: number, olderThan: Date): Promise<readonly PendingDomain[]>;
  record(domainId: string, verified: boolean): Promise<string>;
}

export interface CheckSummary {
  readonly checked: number;
  readonly passed: number;
  readonly failed: number;
  readonly pending: number;
}

/** The TXT names a domain may prove itself under: the dedicated label first, then the apex. */
export function verificationNames(hostname: string): string[] {
  return [`_xos-verification.${hostname}`, hostname];
}

/**
 * Checks each due domain: verified when a TXT record holds the domain's token. A lookup that finds no
 * record (NXDOMAIN, no data) is a failed check; any other DNS error is left for the next run.
 */
export async function verifyDomains(
  store: DomainStore,
  resolve: TxtResolver,
  now: Date,
  limit = 100,
): Promise<CheckSummary> {
  const domains = await store.dueDomains(limit, new Date(now.getTime() - 15 * 60_000));
  let passed = 0;
  let failed = 0;
  let pending = 0;
  for (const domain of domains) {
    let found = false;
    let unresolved = false;
    for (const name of verificationNames(domain.hostname)) {
      try {
        if ((await resolve(name)).some((record) => record.trim() === domain.token)) {
          found = true;
          break;
        }
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== "ENOTFOUND" && code !== "ENODATA") unresolved = true;
      }
    }
    if (!found && unresolved) {
      pending += 1;
      continue;
    }
    await store.record(domain.id, found);
    if (found) passed += 1;
    else failed += 1;
  }
  return { checked: domains.length, passed, failed, pending };
}

export function supabaseDomainStore(db: DbClient): DomainStore {
  return {
    async dueDomains(limit, olderThan) {
      const rows = await unwrap<
        {
          id: string;
          hostname: string;
          verification_token: string;
          last_checked_at: string | null;
        }[]
      >(
        db
          .from("org_domains")
          .select("id, hostname, verification_token, last_checked_at")
          .in("verification_state", ["Pending", "Failed"])
          .is("deleted_at", null)
          .order("last_checked_at", { ascending: true })
          .limit(limit * 2),
      );
      return rows
        .filter((r) => r.last_checked_at === null || new Date(r.last_checked_at) < olderThan)
        .slice(0, limit)
        .map((r) => ({ id: r.id, hostname: r.hostname, token: r.verification_token }));
    },
    async record(domainId, verified) {
      return unwrap<string>(
        db.rpc("record_domain_verification", { p_org_domain_id: domainId, p_verified: verified }),
      );
    },
  };
}

// Organization verification ----------------------------------------------------------------------------------------------

export interface VerificationRequest {
  readonly id: string;
  readonly method: "Stripe Identity" | "Business Registry";
  readonly reference: string;
}

/** Passed, failed with a reason, or still pending at the provider (null). */
export interface CheckOutcome {
  readonly passed: boolean | null;
  readonly reason: string | null;
  readonly expiresAt: string | null;
}

export interface VerificationStore {
  pendingRequests(limit: number): Promise<readonly VerificationRequest[]>;
  record(requestId: string, outcome: CheckOutcome): Promise<string>;
}

export type OrganizationCheck = (request: VerificationRequest) => Promise<CheckOutcome>;

/** Stripe Identity: a verified session passes; a canceled one, or one needing input with an error, fails. */
export function stripeIdentityCheck(http: HttpClient, secretKey: string): OrganizationCheck {
  return async (request) => {
    if (!/^vs_[A-Za-z0-9_]+$/.test(request.reference))
      return {
        passed: false,
        reason: "The reference is not a Stripe Identity verification session.",
        expiresAt: null,
      };
    const session = await callJson<{ status: string; last_error?: { reason?: string } | null }>(
      http,
      "Stripe Identity",
      {
        method: "GET",
        url: `https://api.stripe.com/v1/identity/verification_sessions/${request.reference}`,
        token: secretKey,
      },
    );
    if (session.status === "verified") return { passed: true, reason: null, expiresAt: null };
    if (session.status === "canceled")
      return { passed: false, reason: "The verification session was canceled.", expiresAt: null };
    if (session.status === "requires_input" && session.last_error) {
      return {
        passed: false,
        reason: session.last_error.reason ?? "Stripe Identity could not verify the documents.",
        expiresAt: null,
      };
    }
    return { passed: null, reason: null, expiresAt: null };
  };
}

/** A business registry lookup (OpenCorporates): an active company passes for one year; anything else fails. */
export function businessRegistryCheck(
  http: HttpClient,
  apiToken: string,
  now: () => Date,
): OrganizationCheck {
  return async (request) => {
    const [jurisdiction, number] = request.reference.split("/");
    if (!jurisdiction || !number)
      return {
        passed: false,
        reason: "The registry reference must be <jurisdiction>/<company number>.",
        expiresAt: null,
      };
    let body: { results?: { company?: { current_status?: string | null; inactive?: boolean } } };
    try {
      body = await callJson(http, "Business registry", {
        method: "GET",
        url: `https://api.opencorporates.com/v0.4/companies/${encodeURIComponent(jurisdiction)}/${encodeURIComponent(number)}?api_token=${encodeURIComponent(apiToken)}`,
      });
    } catch (error) {
      if (error instanceof IntegrationError && error.code === "provider_not_found") {
        return {
          passed: false,
          reason: "The registry has no company with that number.",
          expiresAt: null,
        };
      }
      throw error;
    }
    const company = body.results?.company;
    if (company === undefined)
      return { passed: false, reason: "The registry returned no company.", expiresAt: null };
    const status = (company.current_status ?? "").toLowerCase();
    if (company.inactive === true || (status !== "active" && status !== "good standing")) {
      return {
        passed: false,
        reason: `The registry lists the company as ${company.current_status ?? "inactive"}.`,
        expiresAt: null,
      };
    }
    const expires = now();
    expires.setUTCFullYear(expires.getUTCFullYear() + 1);
    return { passed: true, reason: null, expiresAt: expires.toISOString() };
  };
}

/** Checks pending organization verification requests and records each outcome. A provider error leaves the request pending. */
export async function verifyOrganizations(
  store: VerificationStore,
  checks: { readonly stripe: OrganizationCheck; readonly registry: OrganizationCheck },
  limit = 50,
): Promise<
  CheckSummary & {
    readonly errors: readonly { readonly requestId: string; readonly message: string }[];
  }
> {
  const requests = await store.pendingRequests(limit);
  let passed = 0;
  let failed = 0;
  let pending = 0;
  const errors: { requestId: string; message: string }[] = [];
  for (const request of requests) {
    let outcome: CheckOutcome;
    try {
      outcome = await (request.method === "Stripe Identity" ? checks.stripe : checks.registry)(
        request,
      );
    } catch (error) {
      if (!(error instanceof IntegrationError)) throw error;
      errors.push({ requestId: request.id, message: error.message });
      pending += 1;
      continue;
    }
    await store.record(request.id, outcome);
    if (outcome.passed === true) passed += 1;
    else if (outcome.passed === false) failed += 1;
    else pending += 1;
  }
  return { checked: requests.length, passed, failed, pending, errors };
}

export function supabaseVerificationStore(db: DbClient): VerificationStore {
  return {
    async pendingRequests(limit) {
      const rows = await unwrap<
        { id: string; method: VerificationRequest["method"]; provider_reference: string }[]
      >(
        db
          .from("organization_verification_requests")
          .select("id, method, provider_reference")
          .eq("request_state", "Pending")
          .is("deleted_at", null)
          .order("last_checked_at", { ascending: true })
          .limit(limit),
      );
      return rows.map((r) => ({ id: r.id, method: r.method, reference: r.provider_reference }));
    },
    async record(requestId, outcome) {
      return unwrap<string>(
        db.rpc("record_organization_check", {
          p_request_id: requestId,
          p_passed: outcome.passed,
          p_reason: outcome.reason,
          p_expires_at: outcome.expiresAt,
        }),
      );
    },
  };
}
