import { describe, expect, it } from "vitest";
import {
  dmarcRecord,
  resendSendingDomains,
  runDomainJobs,
  supabaseDomainJobStore,
  vercelHosts,
  vercelRecords,
  type DomainJobKind,
  type DomainRecord,
  type DomainRow,
  type DomainStore,
  type ProviderState,
} from "../src/domains/index.ts";
import { scriptedHttp } from "./doubles.ts";

/**
 * Custom domain provisioning (A79, finding A65-033): the Vercel Domains and Resend domains adapters against
 * recorded provider responses, and the worker against fake providers and a fake store. No test calls either
 * API; the tokens are built at run time and never resemble a real one.
 */

const token = ["fixture", "token", String(Date.now())].join("-");

describe("Vercel hosts", () => {
  it("adds a subdomain to the project and lists the CNAME and verification records", async () => {
    const { http, requests } = scriptedHttp([
      {
        match: "POST https://api.vercel.com/v10/projects/prj_atlas/domains",
        respond: () => ({
          json: {
            name: "atlas.northwind.example",
            apexName: "northwind.example",
            verified: false,
            verification: [
              {
                type: "TXT",
                domain: "_vercel.northwind.example",
                value: "vc-domain-verify=atlas.northwind.example,abc",
                reason: "pending_domain_verification",
              },
            ],
          },
        }),
      },
      {
        match: "GET https://api.vercel.com/v6/domains/atlas.northwind.example/config",
        respond: () => ({
          json: {
            misconfigured: true,
            recommendedCNAME: [{ rank: 1, value: "cname.vercel-dns-017.com." }],
          },
        }),
      },
    ]);
    const hosts = vercelHosts(http, { token, projectId: "prj_atlas", teamId: "team_xos" });
    const state = await hosts.add("atlas.northwind.example");
    expect(state).toEqual({
      ref: "atlas.northwind.example",
      verified: false,
      tlsReady: false,
      records: [
        {
          type: "CNAME",
          name: "atlas.northwind.example",
          value: "cname.vercel-dns-017.com",
          purpose: "routing",
        },
        {
          type: "TXT",
          name: "_vercel.northwind.example",
          value: "vc-domain-verify=atlas.northwind.example,abc",
          purpose: "verification",
        },
      ],
    });
    expect(requests[0]?.url).toBe(
      "https://api.vercel.com/v10/projects/prj_atlas/domains?teamId=team_xos",
    );
    expect(requests[0]?.headers?.["authorization"]).toBe(`Bearer ${token}`);
    expect(JSON.parse(String(requests[0]?.body))).toEqual({ name: "atlas.northwind.example" });
  });

  it("reads the domain back when a retried add finds it already on the project", async () => {
    const { http } = scriptedHttp([
      {
        match: "POST https://api.vercel.com/v10/projects/prj_atlas/domains",
        respond: () => ({ status: 409, json: { error: { code: "domain_already_in_use" } } }),
      },
      {
        match: "GET https://api.vercel.com/v9/projects/prj_atlas/domains/northwind.example",
        respond: () => ({
          json: { name: "northwind.example", apexName: "northwind.example", verified: true },
        }),
      },
      {
        match: "GET https://api.vercel.com/v6/domains/northwind.example/config",
        respond: () => ({ json: { misconfigured: false } }),
      },
    ]);
    const state = await vercelHosts(http, { token, projectId: "prj_atlas" }).add(
      "northwind.example",
    );
    expect(state.verified).toBe(true);
    expect(state.tlsReady).toBe(true);
    expect(state.records).toEqual([
      { type: "A", name: "northwind.example", value: "76.76.21.21", purpose: "routing" },
    ]);
  });

  it("asks Vercel to verify an unverified host on a check and waits while the TXT record is missing", async () => {
    const { http, requests } = scriptedHttp([
      {
        match: "GET https://api.vercel.com/v9/projects/prj_gw/domains/gw.northwind.example",
        respond: () => ({
          json: { name: "gw.northwind.example", apexName: "northwind.example", verified: false },
        }),
      },
      {
        match: "POST https://api.vercel.com/v9/projects/prj_gw/domains/gw.northwind.example/verify",
        respond: () => ({ status: 400, json: { error: { code: "missing_txt_record" } } }),
      },
      {
        match: "GET https://api.vercel.com/v6/domains/gw.northwind.example/config",
        respond: () => ({ status: 404, json: {} }),
      },
    ]);
    const state = await vercelHosts(http, { token, projectId: "prj_gw" }).check(
      "gw.northwind.example",
    );
    expect(state.verified).toBe(false);
    expect(requests.map((r) => r.method)).toEqual(["GET", "POST", "GET"]);
  });

  it("removes a host and treats one already gone as removed", async () => {
    const { http, requests } = scriptedHttp([
      {
        match: "DELETE https://api.vercel.com/v9/projects/prj_atlas/domains/old.northwind.example",
        respond: () => ({ status: 404, json: {} }),
      },
    ]);
    await expect(
      vercelHosts(http, { token, projectId: "prj_atlas" }).remove("old.northwind.example"),
    ).resolves.toBeUndefined();
    expect(requests).toHaveLength(1);
  });

  it("refuses with the credential error when the token is wrong", async () => {
    const { http } = scriptedHttp([
      {
        match: "POST https://api.vercel.com/v10/projects/prj_atlas/domains",
        respond: () => ({ status: 403, json: { error: { code: "forbidden" } } }),
      },
    ]);
    await expect(
      vercelHosts(http, { token, projectId: "prj_atlas" }).add("a.northwind.example"),
    ).rejects.toMatchObject({
      code: "credential_refused",
    });
  });

  it("falls back to Vercel's documented records when the config names none", () => {
    expect(vercelRecords({ name: "app.example.org", apexName: "example.org" }, null)).toEqual([
      { type: "CNAME", name: "app.example.org", value: "cname.vercel-dns.com", purpose: "routing" },
    ]);
  });
});

describe("Resend sending domains", () => {
  const created = {
    id: "dom-recorded-1",
    name: "mail.northwind.example",
    status: "not_started",
    records: [
      {
        record: "SPF",
        name: "send",
        type: "MX",
        value: "feedback-smtp.us-east-1.amazonses.com",
        priority: 10,
        status: "not_started",
      },
      {
        record: "SPF",
        name: "send",
        type: "TXT",
        value: "v=spf1 include:amazonses.com ~all",
        status: "not_started",
      },
      {
        record: "DKIM",
        name: "resend._domainkey",
        type: "TXT",
        value: "p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQ",
        status: "not_started",
      },
    ],
  };

  it("creates the domain and lists SPF, DKIM and a monitoring DMARC record with full names", async () => {
    const { http, requests } = scriptedHttp([
      { match: "POST https://api.resend.com/domains", respond: () => ({ json: created }) },
    ]);
    const state = await resendSendingDomains(http, { token, region: "us-east-1" }).create(
      "mail.northwind.example",
    );
    expect(state.ref).toBe("dom-recorded-1");
    expect(state.verified).toBe(false);
    expect(state.records).toEqual([
      {
        type: "MX",
        name: "send.mail.northwind.example",
        value: "feedback-smtp.us-east-1.amazonses.com",
        purpose: "spf",
        priority: 10,
      },
      {
        type: "TXT",
        name: "send.mail.northwind.example",
        value: "v=spf1 include:amazonses.com ~all",
        purpose: "spf",
      },
      {
        type: "TXT",
        name: "resend._domainkey.mail.northwind.example",
        value: "p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQ",
        purpose: "dkim",
      },
      dmarcRecord("mail.northwind.example"),
    ]);
    expect(JSON.parse(String(requests[0]?.body))).toEqual({
      name: "mail.northwind.example",
      region: "us-east-1",
    });
  });

  it("asks Resend to verify on a check and reports verified once it is", async () => {
    let reads = 0;
    const { http, requests } = scriptedHttp([
      {
        match: "GET https://api.resend.com/domains/dom-recorded-1",
        respond: () => ({
          json: { ...created, status: (reads += 1) === 1 ? "pending" : "verified" },
        }),
      },
      {
        match: "POST https://api.resend.com/domains/dom-recorded-1/verify",
        respond: () => ({ json: { object: "domain", id: "dom-recorded-1" } }),
      },
    ]);
    const state = await resendSendingDomains(http, { token }).check("dom-recorded-1");
    expect(state.verified).toBe(true);
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      "GET https://api.resend.com/domains/dom-recorded-1",
      "POST https://api.resend.com/domains/dom-recorded-1/verify",
      "GET https://api.resend.com/domains/dom-recorded-1",
    ]);
  });

  it("removes a domain, and one already gone counts as removed", async () => {
    const { http } = scriptedHttp([
      {
        match: "DELETE https://api.resend.com/domains/dom-gone",
        respond: () => ({ status: 404, json: {} }),
      },
    ]);
    await expect(resendSendingDomains(http, { token }).remove("dom-gone")).resolves.toBeUndefined();
  });
});

// The worker ---------------------------------------------------------------------------------------------------------

function fakeStore(domains: DomainRow[], jobs: Partial<Record<DomainJobKind, string[]>>) {
  const recorded: [string, DomainRecord][] = [];
  const finished: [string, boolean, string | undefined][] = [];
  const queues = new Map(Object.entries(jobs).map(([k, v]) => [k, [...(v ?? [])]]));
  const store: DomainStore = {
    async claim(_worker, kind) {
      const ids = queues.get(kind) ?? [];
      queues.set(kind, []);
      return ids.map((subjectId, i) => ({ id: `${kind}-${i}`, subjectId, attempts: 1 }));
    },
    async finish(jobId, succeeded, error) {
      finished.push([jobId, succeeded, error]);
      return succeeded ? "Succeeded" : "Queued";
    },
    async domains(ids) {
      return domains.filter((d) => ids.includes(d.id));
    },
    async record(domainId, record) {
      recorded.push([domainId, record]);
    },
  };
  return { store, recorded, finished };
}

const pending = (ref: string): ProviderState => ({
  ref,
  verified: false,
  tlsReady: false,
  records: [{ type: "CNAME", name: ref, value: "cname.vercel-dns.com", purpose: "routing" }],
});

describe("domain worker", () => {
  const atlas: DomainRow = {
    id: "d-atlas",
    hostname: "atlas.northwind.example",
    purpose: "Atlas",
    providerRef: null,
    deleted: false,
  };
  const mail: DomainRow = {
    id: "d-mail",
    hostname: "mail.northwind.example",
    purpose: "Email Sending",
    providerRef: "dom-1",
    deleted: false,
  };

  it("provisions an Atlas host, checks a sending domain and records each outcome", async () => {
    const { store, recorded, finished } = fakeStore([atlas, mail], {
      "domain.provision": ["d-atlas"],
      "domain.check": ["d-mail"],
    });
    const results = await runDomainJobs({
      store,
      worker: "test",
      providers: {
        atlas: {
          add: async (h) => pending(h),
          check: async (h) => pending(h),
          remove: async () => undefined,
        },
        gateway: null,
        sending: {
          create: async () => pending("dom-1"),
          check: async (ref) => ({ ref, verified: true, tlsReady: true, records: [] }),
          remove: async () => undefined,
        },
      },
    });
    expect(results.map((r) => r.outcome)).toEqual(["pending-dns", "active"]);
    expect(recorded[0]).toEqual([
      "d-atlas",
      {
        status: "Pending DNS",
        providerRef: "atlas.northwind.example",
        records: pending("atlas.northwind.example").records,
        tlsReady: false,
        verified: false,
      },
    ]);
    expect(recorded[1]?.[1].status).toBe("Active");
    expect(finished.every(([, ok]) => ok)).toBe(true);
  });

  it("records a purpose with no provider as Failed with the reason", async () => {
    const gateway: DomainRow = {
      id: "d-gw",
      hostname: "gw.northwind.example",
      purpose: "Gateway",
      providerRef: null,
      deleted: false,
    };
    const { store, recorded } = fakeStore([gateway], { "domain.provision": ["d-gw"] });
    const results = await runDomainJobs({
      store,
      worker: "test",
      providers: { atlas: null, gateway: null, sending: null },
    });
    expect(results[0]?.outcome).toBe("failed");
    expect(recorded[0]?.[1]).toEqual({
      status: "Failed",
      error: "Custom Gateway domains are not set up on this platform yet.",
    });
  });

  it("queues a retryable provider failure again and records a final refusal", async () => {
    const { store, recorded, finished } = fakeStore(
      [atlas, { ...atlas, id: "d-two", hostname: "two.northwind.example" }],
      {
        "domain.provision": ["d-atlas", "d-two"],
      },
    );
    const { IntegrationError } = await import("../src/framework/errors.ts");
    let calls = 0;
    const results = await runDomainJobs({
      store,
      worker: "test",
      providers: {
        atlas: {
          add: async () => {
            calls += 1;
            if (calls === 1)
              throw new IntegrationError("provider_unavailable", "Vercel returned 503", {
                retryable: true,
              });
            throw new IntegrationError("provider_rejected", "Vercel returned 400: invalid domain");
          },
          check: async (h) => pending(h),
          remove: async () => undefined,
        },
        gateway: null,
        sending: null,
      },
    });
    expect(results.map((r) => r.outcome)).toEqual(["retrying", "failed"]);
    expect(finished[0]).toEqual(["domain.provision-0", false, "Vercel returned 503"]);
    expect(recorded).toEqual([
      ["d-two", { status: "Failed", error: "Vercel returned 400: invalid domain" }],
    ]);
  });

  it("releases a removed domain at its provider and skips work for removed or unknown domains", async () => {
    const removed: string[] = [];
    const gone: DomainRow = { ...mail, deleted: true };
    const { store, recorded } = fakeStore([gone, { ...atlas, deleted: true }], {
      "domain.release": ["d-mail"],
      "domain.provision": ["d-atlas", "d-missing"],
    });
    const results = await runDomainJobs({
      store,
      worker: "test",
      providers: {
        atlas: null,
        gateway: null,
        sending: {
          create: async () => pending("x"),
          check: async () => pending("x"),
          remove: async (ref) => void removed.push(ref),
        },
      },
    });
    expect(removed).toEqual(["dom-1"]);
    expect(recorded).toEqual([["d-mail", { status: "Released" }]]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["released", "skipped", "skipped"]);
  });
});

describe("Supabase domain job store", () => {
  it("calls the 0510 queue and 1355 worker RPCs", async () => {
    const calls: [string, Record<string, unknown>][] = [];
    const answers: Record<string, unknown> = {
      claim_jobs: [{ id: "job-1", subject_id: "d-atlas", attempts: 1 }],
      finish_job: "Succeeded",
      domains_to_provision: [
        {
          id: "d-atlas",
          hostname: "atlas.northwind.example",
          purpose: "Atlas",
          provider_ref: null,
          deleted: false,
        },
      ],
      record_domain_provisioning: "Pending DNS",
    };
    const store = supabaseDomainJobStore({
      rpc: (fn, args) => {
        calls.push([fn, args]);
        return Promise.resolve({ data: answers[fn], error: null });
      },
    });
    expect(await store.claim("w", "domain.provision", 5)).toEqual([
      { id: "job-1", subjectId: "d-atlas", attempts: 1 },
    ]);
    expect((await store.domains(["d-atlas"]))[0]?.providerRef).toBeNull();
    await store.record("d-atlas", {
      status: "Pending DNS",
      providerRef: "atlas.northwind.example",
      records: [],
      tlsReady: false,
      verified: false,
    });
    expect(await store.finish("job-1", true)).toBe("Succeeded");
    expect(calls.map(([fn]) => fn)).toEqual([
      "claim_jobs",
      "domains_to_provision",
      "record_domain_provisioning",
      "finish_job",
    ]);
    expect(calls[2]?.[1]).toMatchObject({
      p_status: "Pending DNS",
      p_provider_ref: "atlas.northwind.example",
      p_error: null,
    });
  });

  it("raises a database error with the RPC's name", async () => {
    const store = supabaseDomainJobStore({
      rpc: () => Promise.resolve({ data: null, error: { message: "permission denied" } }),
    });
    await expect(store.claim("w", "domain.check", 1)).rejects.toThrow(
      "claim_jobs: permission denied",
    );
  });
});
