/**
 * Contract tests for A79's handlers (Section 18, gate 5): ownership transfers, deletion requests and their
 * recovery, deletion certificates, standing partner grants, leaving a partner and checking a custom domain.
 * Requests run through `contractApp`, every response is checked against openapi/v1.json with
 * `expectContract`, and the database is a recording stand-in for supabase-js. Refusals (422, step-up among
 * them) and hidden rows (404) are checked.
 */
import { describe, expect, it } from "vitest";
import { handlers as identityHandlers } from "../src/handlers/identity.ts";
import { handlers as platformHandlers } from "../src/handlers/platform.ts";
import { contractApp, expectContract, testContext } from "./support/contract.ts";

type Response = { data: unknown; error: { code: string; message: string; hint?: string } | null };
type Call = { target: string; steps: [string, unknown[]][] };

function fakeDb(queues: Record<string, Response[]>) {
  const calls: Call[] = [];
  const take = (key: string): Response => {
    const next = queues[key]?.shift();
    if (!next) throw new Error(`no queued response for ${key}`);
    return next;
  };
  const builder = (key: string, steps: [string, unknown[]][]) => {
    const response = take(key);
    const proxy: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") return (resolve: (r: Response) => unknown) => resolve(response);
          return (...args: unknown[]) => {
            steps.push([prop, args]);
            return proxy;
          };
        },
      },
    );
    return proxy;
  };
  const db: Record<string, unknown> = {
    from(table: string) {
      const call: Call = { target: `from:${table}`, steps: [] };
      calls.push(call);
      return builder(call.target, call.steps);
    },
    rpc(name: string, args: unknown) {
      const call: Call = { target: `rpc:${name}`, steps: [["args", [args]]] };
      calls.push(call);
      return builder(call.target, call.steps);
    },
  };
  db["schema"] = () => db;
  return { db, calls };
}

const ctx = testContext();
const ORG = ctx.org?.id as string;
const T = "2026-10-20T12:00:00.000Z";
const id = (n: number) => `0192f1e2-7c3a-7b4d-9e8f-${String(n).padStart(12, "0")}`;
const ok = (data: unknown): Response => ({ data, error: null });
const refusal = (rule: string): Response => ({
  data: null,
  error: { code: "XR001", message: `${rule}: Refused.`, hint: rule },
});
const hidden: Response = { data: null, error: null };
const audit = (n: number) => ({
  id: id(n),
  org_id: ORG,
  created_at: T,
  created_by: null,
  updated_at: T,
  updated_by: null,
});

let keys = 0;
const post = (body: unknown) => ({
  method: "POST",
  headers: { "Idempotency-Key": `a79-contract-${(keys += 1)}`, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

function app(queues: Record<string, Response[]>) {
  const fake = fakeDb(queues);
  return {
    api: contractApp({ handlers: [platformHandlers, identityHandlers], db: fake.db as never }),
    calls: fake.calls,
  };
}

const transfer = {
  ...audit(1),
  from_person_id: id(700),
  to_person_id: id(701),
  previous_owner_outcome: "admin",
  offered_at: T,
  expires_at: "2026-10-27T12:00:00.000Z",
  accepted_at: null,
  declined_at: null,
  canceled_at: null,
  canceled_by: null,
  expired_at: null,
};
const deletion = {
  ...audit(2),
  reason: "We are closing down.",
  requested_at: T,
  recover_until: "2026-10-27T12:00:00.000Z",
  requested_by: id(700),
  recovered_at: null,
  recovered_by: null,
};
const certificate = {
  id: id(3),
  created_at: T,
  updated_at: T,
  deleted_org_id: id(950),
  org_name: "Harbor Lights Productions",
  org_slug: "harbor-lights",
  basis: "deletion_request",
  requested_at: "2026-10-01T12:00:00.000Z",
  due_at: "2026-10-08T12:00:00.000Z",
  purged_at: "2026-10-08T13:00:00.000Z",
  tables_purged: 41,
  rows_purged: 1820,
  storage_objects_deleted: 12,
  document_sha256: "a".repeat(64),
  issued_at: "2026-10-08T13:30:00.000Z",
  delivered_at: null,
};
const grant = {
  ...audit(4),
  partner_org_id: id(900),
  capability_code: "org.settings.read",
  agreement_reference: "Partner agreement, clause 7.2",
  valid_from: T,
  valid_to: "2027-01-20T12:00:00.000Z",
  record_grant_id: id(901),
  ended_at: null,
  ended_by: null,
};
const organization = {
  id: ORG,
  created_at: T,
  updated_at: T,
  name: "Tidewater Events",
  slug: "tidewater-events",
  parent_org_id: null,
  organization_type: "For-Profit",
};
const domain = {
  ...audit(5),
  hostname: "atlas.northwindlive.example",
  purpose: "Atlas",
  verification_state: "Pending",
  verification_token: "xos-verify-7d1c",
  last_checked_at: null,
  auto_join_role_id: null,
  provisioning_status: "Pending DNS",
  dns_records: [
    {
      type: "CNAME",
      name: "atlas.northwindlive.example",
      value: "cname.vercel-dns.com",
      purpose: "routing",
    },
  ],
  tls_ready: false,
  provisioning_error: null,
};

describe("Ownership transfers", () => {
  it("lists, offers, accepts, declines and withdraws through the RPCs, and names the step-up refusal", async () => {
    const { api, calls } = app({
      "from:ownership_transfers": [
        ok([transfer]),
        ok(transfer),
        hidden,
        ok(transfer),
        ok({ id: transfer.id }),
        ok({ ...transfer, accepted_at: T }),
        ok({ id: transfer.id }),
        ok({ id: transfer.id }),
        ok({ ...transfer, declined_at: T }),
        ok({ id: transfer.id }),
        ok({ ...transfer, canceled_at: T, canceled_by: id(700) }),
      ],
      "rpc:offer_ownership_transfer": [refusal("step_up_required"), ok(transfer.id)],
      "rpc:accept_ownership_transfer": [ok(transfer.id), refusal("ownership_transfer_closed")],
      "rpc:decline_ownership_transfer": [ok(transfer.id)],
      "rpc:cancel_ownership_transfer": [ok(transfer.id)],
    });
    await expectContract(await api.request("/ownership-transfers"), "ownershipTransfers.list");
    await expectContract(
      await api.request(`/ownership-transfers/${transfer.id}`),
      "ownershipTransfers.get",
    );
    expect((await api.request(`/ownership-transfers/${id(999)}`)).status).toBe(404);
    const body = { to_person_id: id(701), previous_owner_outcome: "admin" };
    const refused = await api.request("/ownership-transfers/offer", post(body));
    expect(refused.status).toBe(422);
    await expectContract(refused, "ownershipTransfers.offer");
    const offered = await api.request("/ownership-transfers/offer", post(body));
    expect(offered.status).toBe(201);
    await expectContract(offered, "ownershipTransfers.offer");
    expect(
      calls.find((c) => c.target === "rpc:offer_ownership_transfer")?.steps[0]?.[1][0],
    ).toEqual({
      p_org_id: ORG,
      p_to_person_id: id(701),
      p_previous_owner_outcome: "admin",
    });
    const accepted = await api.request(`/ownership-transfers/${transfer.id}/accept`, post({}));
    await expectContract(accepted, "ownershipTransfers.accept");
    const closed = await api.request(`/ownership-transfers/${transfer.id}/accept`, post({}));
    expect(closed.status).toBe(422);
    const declined = await api.request(`/ownership-transfers/${transfer.id}/decline`, post({}));
    await expectContract(declined, "ownershipTransfers.decline");
    const withdrawn = await api.request(`/ownership-transfers/${transfer.id}/cancel`, post({}));
    await expectContract(withdrawn, "ownershipTransfers.cancel");
  });
});

describe("Deletion requests and certificates", () => {
  it("asks for deletion with the typed name and recovers within the window", async () => {
    const { api, calls } = app({
      "from:org_deletion_requests": [
        ok([deletion]),
        ok(deletion),
        ok(deletion),
        ok({ id: deletion.id }),
        ok({ ...deletion, recovered_at: T, recovered_by: id(700) }),
      ],
      "rpc:request_org_deletion": [ok(deletion.id), refusal("org_name_mismatch")],
      "rpc:recover_org_deletion": [ok(deletion.id)],
    });
    await expectContract(await api.request("/org-deletion-requests"), "orgDeletionRequests.list");
    await expectContract(
      await api.request(`/org-deletion-requests/${deletion.id}`),
      "orgDeletionRequests.get",
    );
    const requested = await api.request(
      "/org-deletion-requests/request",
      post({ confirm_name: "Harbor Lights Productions", reason: "We are closing down." }),
    );
    expect(requested.status).toBe(201);
    await expectContract(requested, "orgDeletionRequests.request");
    expect(calls.find((c) => c.target === "rpc:request_org_deletion")?.steps[0]?.[1][0]).toEqual({
      p_org_id: ORG,
      p_confirm_name: "Harbor Lights Productions",
      p_reason: "We are closing down.",
    });
    const mismatch = await api.request(
      "/org-deletion-requests/request",
      post({ confirm_name: "Harbor", reason: "Closing." }),
    );
    expect(mismatch.status).toBe(422);
    const recovered = await api.request(`/org-deletion-requests/${deletion.id}/recover`, post({}));
    await expectContract(recovered, "orgDeletionRequests.recover");
  });

  it("lists the caller's deletion certificates with no org filter", async () => {
    const { api, calls } = app({
      "from:deletion_certificates": [ok([certificate]), ok(certificate)],
    });
    await expectContract(await api.request("/deletion-certificates"), "deletionCertificates.list");
    await expectContract(
      await api.request(`/deletion-certificates/${certificate.id}`),
      "deletionCertificates.get",
    );
    expect(calls[0]?.steps.some(([m, args]) => m === "eq" && args[0] === "org_id")).toBe(false);
  });
});

describe("Standing partner grants", () => {
  it("records and ends a standing grant", async () => {
    const { api } = app({
      "from:partner_standing_grants": [
        ok([grant]),
        ok(grant),
        ok(grant),
        ok({ id: grant.id }),
        ok({ ...grant, ended_at: T, ended_by: id(700) }),
      ],
      "rpc:record_standing_grant": [ok(grant.id), refusal("standing_grant_scope")],
      "rpc:end_standing_grant": [ok(grant.id)],
    });
    await expectContract(
      await api.request("/partner-standing-grants"),
      "partnerStandingGrants.list",
    );
    await expectContract(
      await api.request(`/partner-standing-grants/${grant.id}`),
      "partnerStandingGrants.get",
    );
    const body = {
      capability_code: "org.settings.read",
      valid_to: "2027-01-20T12:00:00.000Z",
      agreement_reference: "Partner agreement, clause 7.2",
    };
    const recorded = await api.request("/partner-standing-grants/record", post(body));
    expect(recorded.status).toBe(201);
    await expectContract(recorded, "partnerStandingGrants.record");
    const outOfScope = await api.request(
      "/partner-standing-grants/record",
      post({ ...body, capability_code: "org.billing.read" }),
    );
    expect(outOfScope.status).toBe(422);
    const ended = await api.request(`/partner-standing-grants/${grant.id}/end`, post({}));
    await expectContract(ended, "partnerStandingGrants.end");
  });
});

describe("Leaving a partner and checking a domain", () => {
  it("leaves the partner with the typed name and answers with the org", async () => {
    const { api, calls } = app({
      "rpc:leave_partner": [ok(ORG), refusal("leave_partner_no_partner")],
      "from:organizations": [ok(organization)],
    });
    const left = await api.request(
      "/organizations/leave-partner",
      post({ confirm_name: "Tidewater Events" }),
    );
    await expectContract(left, "organizations.leavePartner");
    expect(calls.find((c) => c.target === "rpc:leave_partner")?.steps[0]?.[1][0]).toEqual({
      p_org_id: ORG,
      p_confirm_name: "Tidewater Events",
    });
    const again = await api.request(
      "/organizations/leave-partner",
      post({ confirm_name: "Tidewater Events" }),
    );
    expect(again.status).toBe(422);
  });

  it("queues another check of a custom domain", async () => {
    const { api } = app({
      "from:org_domains": [ok({ id: domain.id }), ok(domain), hidden],
      "rpc:request_domain_check": [ok(id(990))],
    });
    const checked = await api.request(`/verified-domains/${domain.id}/check`, post({}));
    await expectContract(checked, "verifiedDomains.check");
    expect((await api.request(`/verified-domains/${id(998)}/check`, post({}))).status).toBe(404);
  });
});
