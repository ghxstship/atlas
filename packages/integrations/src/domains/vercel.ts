import { IntegrationError } from "../framework/errors.ts";
import { callJson, type HttpClient } from "../framework/http.ts";
import type { DnsRecord, HostProvider, ProviderState } from "./types.ts";

/**
 * Atlas and Gateway custom hosts through the Vercel Domains API (Section 12). The host is added to the
 * surface's Vercel project; Vercel verifies DNS and issues the TLS certificate itself once the records
 * resolve. Endpoints (Vercel REST API):
 *   POST   /v10/projects/{project}/domains            add the host to the project
 *   GET    /v9/projects/{project}/domains/{host}      the project domain, with `verified` and `verification`
 *   POST   /v9/projects/{project}/domains/{host}/verify
 *   GET    /v6/domains/{host}/config                  whether DNS points at Vercel (`misconfigured`)
 *   DELETE /v9/projects/{project}/domains/{host}
 * Every call carries the owner's token as a bearer and the team id as a query parameter.
 */

export const VERCEL_API = "https://api.vercel.com";
const PROVIDER = "Vercel Domains";

/** Records Vercel recommends when its config response names none: an A record at the apex, a CNAME below it. */
export const VERCEL_APEX_IP = "76.76.21.21";
export const VERCEL_CNAME = "cname.vercel-dns.com";

export interface VercelConfig {
  readonly token: string;
  readonly projectId: string;
  readonly teamId?: string | null;
  readonly baseUrl?: string;
}

interface ProjectDomain {
  readonly name: string;
  readonly apexName?: string;
  readonly verified?: boolean;
  readonly verification?: readonly {
    type?: string;
    domain?: string;
    value?: string;
    reason?: string;
  }[];
}

interface DomainConfig {
  readonly misconfigured?: boolean;
  readonly recommendedIPv4?: readonly { rank?: number; value?: readonly string[] }[];
  readonly recommendedCNAME?: readonly { rank?: number; value?: string }[];
}

function query(config: VercelConfig): string {
  return config.teamId ? `?teamId=${encodeURIComponent(config.teamId)}` : "";
}

function best<T extends { rank?: number }>(list: readonly T[] | undefined): T | undefined {
  return [...(list ?? [])].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))[0];
}

/** The records the org publishes: routing (A or CNAME) and any verification TXT records Vercel asks for. */
export function vercelRecords(domain: ProjectDomain, config: DomainConfig | null): DnsRecord[] {
  const host = domain.name;
  const apex = (domain.apexName ?? host) === host;
  const records: DnsRecord[] = [];
  if (apex) {
    const ips = best(config?.recommendedIPv4)?.value ?? [VERCEL_APEX_IP];
    for (const ip of ips) records.push({ type: "A", name: host, value: ip, purpose: "routing" });
  } else {
    const cname = best(config?.recommendedCNAME)?.value?.replace(/\.$/, "") ?? VERCEL_CNAME;
    records.push({ type: "CNAME", name: host, value: cname, purpose: "routing" });
  }
  for (const v of domain.verification ?? []) {
    if (v.type && v.domain && v.value)
      records.push({ type: v.type, name: v.domain, value: v.value, purpose: "verification" });
  }
  return records;
}

export function vercelHosts(http: HttpClient, config: VercelConfig): HostProvider {
  const base = (config.baseUrl ?? VERCEL_API).replace(/\/+$/, "");
  const project = encodeURIComponent(config.projectId);
  const q = query(config);
  const call = <T>(method: "GET" | "POST" | "DELETE", path: string, json?: unknown) =>
    callJson<T>(http, PROVIDER, {
      method,
      url: `${base}${path}${q}`,
      token: config.token,
      ...(json === undefined ? {} : { json }),
    });

  async function state(domain: ProjectDomain): Promise<ProviderState> {
    let dns: DomainConfig | null = null;
    try {
      dns = await call<DomainConfig>(
        "GET",
        `/v6/domains/${encodeURIComponent(domain.name)}/config`,
      );
    } catch (error) {
      if (!(error instanceof IntegrationError) || error.code !== "provider_not_found") throw error;
    }
    const verified = domain.verified === true;
    const routed = dns !== null && dns.misconfigured === false;
    return {
      ref: domain.name,
      verified: verified && routed,
      tlsReady: verified && routed,
      records: vercelRecords(domain, dns),
    };
  }

  return {
    async add(hostname) {
      let domain: ProjectDomain;
      try {
        domain = await call<ProjectDomain>("POST", `/v10/projects/${project}/domains`, {
          name: hostname,
        });
      } catch (error) {
        // Already on this project (a retried job): read it instead.
        if (!(error instanceof IntegrationError) || error.code !== "provider_conflict") throw error;
        domain = await call<ProjectDomain>(
          "GET",
          `/v9/projects/${project}/domains/${encodeURIComponent(hostname)}`,
        );
      }
      return state(domain);
    },
    async check(hostname) {
      let domain = await call<ProjectDomain>(
        "GET",
        `/v9/projects/${project}/domains/${encodeURIComponent(hostname)}`,
      );
      if (domain.verified !== true) {
        try {
          domain = await call<ProjectDomain>(
            "POST",
            `/v9/projects/${project}/domains/${encodeURIComponent(hostname)}/verify`,
          );
        } catch (error) {
          // Vercel answers 400 while the TXT record is not there yet; the next check tries again.
          if (!(error instanceof IntegrationError) || error.code !== "provider_rejected")
            throw error;
        }
      }
      return state(domain);
    },
    async remove(hostname) {
      try {
        await call<unknown>(
          "DELETE",
          `/v9/projects/${project}/domains/${encodeURIComponent(hostname)}`,
        );
      } catch (error) {
        if (!(error instanceof IntegrationError) || error.code !== "provider_not_found")
          throw error;
      }
    },
  };
}
