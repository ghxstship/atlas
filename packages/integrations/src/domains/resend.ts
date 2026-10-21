import { IntegrationError } from "../framework/errors.ts";
import { callJson, type HttpClient } from "../framework/http.ts";
import type { DnsRecord, ProviderState, SendingDomainProvider } from "./types.ts";

/**
 * Custom sending domains through the Resend domains API (Section 12: SPF, DKIM and DMARC). Resend returns the
 * SPF (MX and TXT on its sending subdomain) and DKIM records and verifies them; DMARC is a policy the org
 * publishes on its own domain, so the worker adds the recommended starting record (p=none, which reports and
 * rejects nothing) to the records shown. Endpoints:
 *   POST   /domains              create the domain; the response lists its records
 *   GET    /domains/{id}         status: not_started, pending, verified, failed or temporary_failure
 *   POST   /domains/{id}/verify  ask Resend to check the records now
 *   DELETE /domains/{id}
 */

export const RESEND_API = "https://api.resend.com";
const PROVIDER = "Resend domains";

export interface ResendConfig {
  readonly token: string;
  readonly region?: "us-east-1" | "eu-west-1" | "sa-east-1" | "ap-northeast-1";
  readonly baseUrl?: string;
}

interface ResendRecord {
  readonly record?: string;
  readonly name?: string;
  readonly type?: string;
  readonly value?: string;
  readonly priority?: number;
  readonly status?: string;
}

interface ResendDomain {
  readonly id: string;
  readonly name: string;
  readonly status?: string;
  readonly records?: readonly ResendRecord[];
}

/** Resend gives record names relative to the domain; the org's DNS needs them in full. */
function fullName(name: string, domain: string): string {
  if (!name || name === "@") return domain;
  return name.endsWith(domain) ? name : `${name}.${domain}`;
}

/** The DMARC record a new sending domain starts with: monitor only. */
export function dmarcRecord(domain: string): DnsRecord {
  return { type: "TXT", name: `_dmarc.${domain}`, value: "v=DMARC1; p=none;", purpose: "dmarc" };
}

export function resendRecords(domain: ResendDomain): DnsRecord[] {
  const records: DnsRecord[] = (domain.records ?? []).flatMap((r) => {
    if (!r.type || !r.value) return [];
    const purpose = (r.record ?? "").toLowerCase().includes("dkim")
      ? "dkim"
      : (r.record ?? "").toLowerCase().includes("receiving")
        ? "receiving"
        : "spf";
    return [
      {
        type: r.type,
        name: fullName(r.name ?? "", domain.name),
        value: r.value,
        purpose,
        ...(typeof r.priority === "number" ? { priority: r.priority } : {}),
      },
    ];
  });
  return [...records, dmarcRecord(domain.name)];
}

function toState(domain: ResendDomain): ProviderState {
  const verified = domain.status === "verified";
  return { ref: domain.id, verified, tlsReady: verified, records: resendRecords(domain) };
}

export function resendSendingDomains(
  http: HttpClient,
  config: ResendConfig,
): SendingDomainProvider {
  const base = (config.baseUrl ?? RESEND_API).replace(/\/+$/, "");
  const call = <T>(method: "GET" | "POST" | "DELETE", path: string, json?: unknown) =>
    callJson<T>(http, PROVIDER, {
      method,
      url: `${base}${path}`,
      token: config.token,
      ...(json === undefined ? {} : { json }),
    });
  return {
    async create(hostname) {
      const created = await call<ResendDomain>("POST", "/domains", {
        name: hostname,
        ...(config.region ? { region: config.region } : {}),
      });
      return toState(created);
    },
    async check(ref) {
      const id = encodeURIComponent(ref);
      let domain = await call<ResendDomain>("GET", `/domains/${id}`);
      if (domain.status !== "verified") {
        await call<unknown>("POST", `/domains/${id}/verify`);
        domain = await call<ResendDomain>("GET", `/domains/${id}`);
      }
      return toState(domain);
    },
    async remove(ref) {
      try {
        await call<unknown>("DELETE", `/domains/${encodeURIComponent(ref)}`);
      } catch (error) {
        if (!(error instanceof IntegrationError) || error.code !== "provider_not_found")
          throw error;
      }
    },
  };
}
