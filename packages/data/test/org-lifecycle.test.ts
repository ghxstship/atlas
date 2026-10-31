import { describe, expect, it } from "vitest";
import type { XosClient } from "../src/client.ts";
import {
  acceptOwnershipTransfer,
  calendarDaysBetween,
  cancelOwnershipTransfer,
  dayOf,
  daysOverdue,
  declineOwnershipTransfer,
  downloadDeletionCertificate,
  endStandingGrant,
  getDeletionRequest,
  getOpenOwnershipTransfer,
  getOrgBannerStatus,
  leavePartner,
  listDomainProvisioning,
  listMyDeletionCertificates,
  listStandingGrants,
  offerOwnershipTransfer,
  purgeDay,
  readOnlyOn,
  recordStandingGrant,
  recoverOrgDeletion,
  requestDomainCheck,
  requestOrgDeletion,
  toBannerStatus,
  toDnsRecords,
  transferStatus,
  trialDaysLeft,
  windowLastDay,
} from "../src/org-lifecycle.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

/** A79 (migrations 1350 to 1355): the org lifecycle repository maps rows and refusals faithfully. */

const certificateRow = {
  id: "0192a000-0000-7000-8000-00000000c001",
  deleted_org_id: "0192a000-0000-7000-8000-0000000000b1",
  org_name: "Harbor Lights Productions",
  org_slug: "harbor-lights",
  basis: "deletion_request",
  requested_at: "2026-10-01T12:00:00Z",
  due_at: "2026-10-08T12:00:00Z",
  purged_at: "2026-10-08T13:23:00Z",
  tables_purged: 41,
  rows_purged: 1820,
  storage_objects_deleted: 12,
  issued_at: "2026-10-08T13:30:00Z",
  document_object: "0192a000-0000-7000-8000-00000000c001.pdf",
  document_sha256: "a".repeat(64),
  delivered_at: null,
};

describe("banner status", () => {
  it("maps the one-call banner status and ignores unknown values", async () => {
    const { db, calls } = fakeClient({
      "rpc:org_banner_status": [
        okResponse([
          {
            read_only_reason: "dunning",
            read_only_until: null,
            purge_after: null,
            recover_until: null,
            trial_plan: null,
            trial_ends_at: null,
            billing_state: "read_only",
            past_due_since: "2026-09-20T14:05:00Z",
            white_label_until: "2026-11-01T00:00:00Z",
            ownership_transfer_id: "tr-1",
            ownership_offered_by: "Alice Moreno",
            ownership_expires_at: "2026-10-27T00:00:00Z",
            over_limit_plan: "access",
            read_only_projects: 2,
            read_only_seats: 1,
            read_only_field_seats: 0,
            own_seat_read_only: "seats",
          },
        ]),
      ],
    });
    const result = await getOrgBannerStatus(db, "org-1");
    expect(result).toEqual({
      ok: true,
      data: {
        readOnlyReason: "dunning",
        readOnlyUntil: null,
        purgeAfter: null,
        recoverUntil: null,
        trialPlan: null,
        trialEndsAt: null,
        billingState: "read_only",
        pastDueSince: "2026-09-20T14:05:00Z",
        whiteLabelUntil: "2026-11-01T00:00:00Z",
        ownershipOffer: {
          transferId: "tr-1",
          offeredBy: "Alice Moreno",
          expiresAt: "2026-10-27T00:00:00Z",
        },
        overLimit: { planCode: "access", projects: 2, seats: 1, fieldSeats: 0 },
        ownSeatReadOnly: "seats",
      },
    });
    expect(calls[0]?.steps[0]).toEqual(["args", [{ p_org_id: "org-1" }]]);
    expect(toBannerStatus({ read_only_reason: "other", billing_state: "trialing" })).toMatchObject({
      readOnlyReason: null,
      billingState: null,
    });
    expect(toBannerStatus(undefined).trialPlan).toBeNull();
    expect(toBannerStatus({ over_limit_plan: null, own_seat_read_only: "projects" })).toMatchObject(
      {
        overLimit: null,
        ownSeatReadOnly: null,
      },
    );
  });

  it("counts dunning days and the read-only day", () => {
    const since = "2026-10-01T00:00:00Z";
    expect(daysOverdue(since, new Date("2026-10-04T08:00:00Z"))).toBe(3);
    expect(daysOverdue(since, new Date("2026-09-30T00:00:00Z"))).toBe(0);
    expect(readOnlyOn(since)).toBe("2026-10-22T00:00:00.000Z");
  });

  it("returns not-found when the caller is not a member", async () => {
    const { db } = fakeClient({ "rpc:org_banner_status": [errorResponse("42501", "denied")] });
    expect(await getOrgBannerStatus(db, "org-1")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
  });
});

describe("days on the org's calendar", () => {
  // A trial that started on 2026-10-20 in New York ends at New York's midnight after 14 whole days (1350).
  const ny = "America/New_York";
  const trialEnd = "2026-11-04T05:00:00Z"; // 2026-11-04 00:00 in New York (EST)

  it("counts whole calendar days between dates", () => {
    expect(calendarDaysBetween("2026-10-20", "2026-11-03")).toBe(14);
    expect(calendarDaysBetween("2026-11-03", "2026-10-20")).toBe(-14);
    expect(calendarDaysBetween("2026-03-07", "2026-03-09")).toBe(2);
  });

  it("names the day an instant falls on where the org is", () => {
    expect(dayOf("2026-10-21T02:30:00Z", ny)).toBe("2026-10-20");
    expect(dayOf("2026-10-21T02:30:00Z", "UTC")).toBe("2026-10-21");
    expect(dayOf("2026-10-21T02:30:00Z", "Not/AZone")).toBe("2026-10-21");
  });

  it("shows a window ending at the org's midnight by its last day", () => {
    expect(windowLastDay(trialEnd, ny)).toBe("2026-11-03");
    expect(windowLastDay("2026-10-28T04:00:00Z", ny)).toBe("2026-10-27");
    expect(windowLastDay("2026-10-28T00:00:00Z", "UTC")).toBe("2026-10-27");
  });

  it("counts the trial down on the org's calendar, never the UTC date", () => {
    // 21:00 in New York on the first day is already the next day in UTC.
    expect(trialDaysLeft(trialEnd, ny, new Date("2026-10-21T01:00:00Z"))).toBe(14);
    expect(trialDaysLeft(trialEnd, ny, new Date("2026-11-03T04:59:59Z"))).toBe(1);
    expect(trialDaysLeft(trialEnd, ny, new Date("2026-11-03T05:00:00Z"))).toBe(0);
    expect(trialDaysLeft(trialEnd, ny, new Date("2026-11-05T00:00:00Z"))).toBe(0);
  });

  it("puts day 90 of a cancellation on the org's calendar", () => {
    // Canceled at 22:00 on 2026-10-20 in New York: day 90 is 2027-01-18 there, a day before the UTC count.
    expect(purgeDay("2026-10-21T02:00:00Z", ny)).toBe("2027-01-18");
    expect(purgeDay("2026-10-21T02:00:00Z", "UTC")).toBe("2027-01-19");
  });
});

describe("deletion", () => {
  it("reads the open deletion request", async () => {
    const { db, calls } = fakeClient({
      "from:org_deletion_requests": [
        okResponse([
          {
            id: "del-1",
            reason: "Closing.",
            requested_at: "2026-10-01T00:00:00Z",
            recover_until: "2026-10-08T00:00:00Z",
            requested_by: "p-1",
          },
        ]),
        okResponse([]),
      ],
    });
    expect(await getDeletionRequest(db, "org-1")).toEqual({
      ok: true,
      data: {
        id: "del-1",
        reason: "Closing.",
        requestedAt: "2026-10-01T00:00:00Z",
        recoverUntil: "2026-10-08T00:00:00Z",
        requestedBy: "p-1",
      },
    });
    expect(calls[0]?.steps).toContainEqual(["is", ["recovered_at", null]]);
    expect(await getDeletionRequest(db, "org-1")).toEqual({ ok: true, data: null });
  });

  it("requests deletion and surfaces the step-up refusal by its rule", async () => {
    const { db, calls } = fakeClient({
      "rpc:request_org_deletion": [
        errorResponse("XR001", "step_up_required: Confirm it is you.", "step_up_required"),
        okResponse("del-1"),
      ],
      "rpc:recover_org_deletion": [okResponse("del-1")],
    });
    const input = { orgId: "org-1", confirmName: "Harbor Lights", reason: "Closing." };
    expect(await requestOrgDeletion(db, input)).toEqual({
      ok: false,
      error: { kind: "refusal", rule: "step_up_required", message: "Confirm it is you." },
    });
    expect(await requestOrgDeletion(db, input)).toEqual({ ok: true, data: "del-1" });
    expect(calls[0]?.steps[0]).toEqual([
      "args",
      [{ p_org_id: "org-1", p_confirm_name: "Harbor Lights", p_reason: "Closing." }],
    ]);
    expect(await recoverOrgDeletion(db, "org-1")).toEqual({ ok: true, data: "del-1" });
  });

  it("lists the signed-in person's certificates", async () => {
    const { db } = fakeClient({ "from:deletion_certificates": [okResponse([certificateRow])] });
    const result = await listMyDeletionCertificates(db);
    expect(result.ok && result.data[0]).toMatchObject({
      orgName: "Harbor Lights Productions",
      basis: "deletion_request",
      rowsPurged: 1820,
      tablesPurged: 41,
      storageObjectsDeleted: 12,
      deliveredAt: null,
    });
  });

  it("downloads a certificate PDF with the caller's own client, or not-found", async () => {
    const pdf = new TextEncoder().encode("%PDF-1.7");
    const make = (rowsData: unknown[], file: Uint8Array | null) => {
      const { db } = fakeClient({ "from:deletion_certificates": [okResponse(rowsData)] });
      return Object.assign(db, {
        storage: {
          from: (bucket: string) => ({
            download: async (name: string) =>
              bucket === "deletion-certificates" && file && name.endsWith(".pdf")
                ? { data: new Blob([file as unknown as ArrayBuffer]), error: null }
                : { data: null, error: { message: "missing" } },
          }),
        },
      }) as unknown as XosClient;
    };
    const found = await downloadDeletionCertificate(make([certificateRow], pdf), certificateRow.id);
    expect(found.ok && new TextDecoder().decode(found.data.bytes)).toBe("%PDF-1.7");
    expect(await downloadDeletionCertificate(make([], pdf), "x")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect(
      await downloadDeletionCertificate(
        make([{ ...certificateRow, document_object: null }], pdf),
        "x",
      ),
    ).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
    expect(await downloadDeletionCertificate(make([certificateRow], null), "x")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
  });
});

describe("ownership transfer", () => {
  const row = {
    id: "tr-1",
    org_id: "org-1",
    from_person_id: "p-alice",
    to_person_id: "p-dave",
    previous_owner_outcome: "leave",
    offered_at: "2026-10-20T00:00:00Z",
    expires_at: "2099-10-27T00:00:00Z",
    accepted_at: null,
    declined_at: null,
    canceled_at: null,
    expired_at: null,
  };

  it("reads the open offer and derives each status", async () => {
    const { db } = fakeClient({ "from:ownership_transfers": [okResponse([row]), okResponse([])] });
    const open = await getOpenOwnershipTransfer(db, "org-1");
    expect(open.ok && open.data).toMatchObject({
      id: "tr-1",
      previousOwnerOutcome: "leave",
      status: "open",
    });
    expect(await getOpenOwnershipTransfer(db, "org-1")).toEqual({ ok: true, data: null });
    const now = new Date("2026-10-21T00:00:00Z");
    expect(transferStatus({ ...row, accepted_at: "x" }, now)).toBe("accepted");
    expect(transferStatus({ ...row, declined_at: "x" }, now)).toBe("declined");
    expect(transferStatus({ ...row, canceled_at: "x" }, now)).toBe("canceled");
    expect(transferStatus({ ...row, expires_at: "2026-10-20T12:00:00Z" }, now)).toBe("expired");
  });

  it("offers, accepts, declines and cancels through the RPCs", async () => {
    const { db, calls } = fakeClient({
      "rpc:offer_ownership_transfer": [okResponse("tr-1")],
      "rpc:accept_ownership_transfer": [okResponse("tr-1")],
      "rpc:decline_ownership_transfer": [okResponse("tr-1")],
      "rpc:cancel_ownership_transfer": [
        errorResponse("XR001", "ownership_transfer_closed: Answered.", "ownership_transfer_closed"),
      ],
    });
    expect(
      await offerOwnershipTransfer(db, { orgId: "org-1", toPersonId: "p-dave", outcome: "admin" }),
    ).toEqual({
      ok: true,
      data: "tr-1",
    });
    expect(calls[0]?.steps[0]).toEqual([
      "args",
      [{ p_org_id: "org-1", p_to_person_id: "p-dave", p_previous_owner_outcome: "admin" }],
    ]);
    expect(await acceptOwnershipTransfer(db, "tr-1")).toEqual({ ok: true, data: "tr-1" });
    expect(await declineOwnershipTransfer(db, "tr-1")).toEqual({ ok: true, data: "tr-1" });
    const canceled = await cancelOwnershipTransfer(db, "tr-1");
    expect(!canceled.ok && canceled.error).toMatchObject({
      kind: "refusal",
      rule: "ownership_transfer_closed",
    });
  });
});

describe("partners", () => {
  it("lists standing grants and marks the open ones", async () => {
    const { db } = fakeClient({
      "from:partner_standing_grants": [
        okResponse([
          {
            id: "sg-1",
            capability_code: "org.settings.read",
            agreement_reference: "Clause 7.2",
            valid_from: "2026-10-01T00:00:00Z",
            valid_to: "2027-01-01T00:00:00Z",
            ended_at: null,
          },
          {
            id: "sg-0",
            capability_code: "projects.project.read",
            agreement_reference: "Clause 7.1",
            valid_from: "2026-09-01T00:00:00Z",
            valid_to: "2027-01-01T00:00:00Z",
            ended_at: "2026-09-15T00:00:00Z",
          },
        ]),
      ],
    });
    const result = await listStandingGrants(db, "org-c", new Date("2026-10-20T00:00:00Z"));
    expect(result.ok && result.data.map((g) => [g.id, g.open])).toEqual([
      ["sg-1", true],
      ["sg-0", false],
    ]);
  });

  it("records and ends standing grants and leaves the partner", async () => {
    const { db, calls } = fakeClient({
      "rpc:record_standing_grant": [okResponse("sg-1")],
      "rpc:end_standing_grant": [okResponse("sg-1")],
      "rpc:leave_partner": [okResponse("org-c")],
    });
    expect(
      await recordStandingGrant(db, {
        orgId: "org-c",
        capabilityCode: "org.settings.read",
        validTo: "2027-01-01T00:00:00Z",
        agreementReference: "Clause 7.2",
      }),
    ).toEqual({ ok: true, data: "sg-1" });
    expect(await endStandingGrant(db, "sg-1")).toEqual({ ok: true, data: "sg-1" });
    expect(await leavePartner(db, { orgId: "org-c", confirmName: "Tidewater Events" })).toEqual({
      ok: true,
      data: "org-c",
    });
    expect(calls[2]?.steps[0]).toEqual([
      "args",
      [{ p_org_id: "org-c", p_confirm_name: "Tidewater Events" }],
    ]);
  });
});

describe("custom domains", () => {
  it("lists provisioning with the DNS records to publish", async () => {
    const { db } = fakeClient({
      "from:org_domains": [
        okResponse([
          {
            id: "d-1",
            hostname: "atlas.northwind.example",
            purpose: "Atlas",
            verification_state: "Pending",
            provisioning_status: "Pending DNS",
            dns_records: [
              {
                type: "CNAME",
                name: "atlas.northwind.example",
                value: "cname.vercel-dns.com",
                purpose: "routing",
              },
              { type: "", name: "broken" },
            ],
            tls_ready: false,
            provisioning_error: null,
          },
        ]),
      ],
    });
    const result = await listDomainProvisioning(db, "org-a");
    expect(result.ok && result.data[0]).toEqual({
      id: "d-1",
      hostname: "atlas.northwind.example",
      purpose: "Atlas",
      verificationState: "Pending",
      provisioningStatus: "Pending DNS",
      dnsRecords: [
        {
          type: "CNAME",
          name: "atlas.northwind.example",
          value: "cname.vercel-dns.com",
          purpose: "routing",
        },
      ],
      tlsReady: false,
      provisioningError: null,
    });
    expect(toDnsRecords("not a list")).toEqual([]);
  });

  it("asks for another check", async () => {
    const { db } = fakeClient({
      "rpc:request_domain_check": [okResponse("job-1"), errorResponse("42501", "denied")],
    });
    expect(await requestDomainCheck(db, "d-1")).toEqual({ ok: true, data: "job-1" });
    expect(await requestDomainCheck(db, "d-1")).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
  });
});
