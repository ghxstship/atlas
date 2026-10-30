import { describe, expect, it } from "vitest";
import {
  businessRegistryCheck,
  stripeIdentityCheck,
  supabaseDomainStore,
  supabaseVerificationStore,
  verificationNames,
  verifyDomains,
  verifyOrganizations,
  type CheckOutcome,
  type DomainStore,
  type VerificationStore,
} from "../src/identity/verifiers.ts";
import {
  groupDisplay,
  groupId,
  handleScimRequest,
  supabaseScimStore,
  type ScimIdentity,
  type ScimStore,
} from "../src/identity/scim.ts";
import { StoreError } from "../src/framework/db.ts";
import { IntegrationError } from "../src/framework/errors.ts";
import { okData, recordingDb, scriptedHttp } from "./doubles.ts";

const now = new Date("2027-06-30T12:00:00Z");

describe("domain verifier", () => {
  function store(domains: { id: string; hostname: string; token: string }[]) {
    const recorded: [string, boolean][] = [];
    const value: DomainStore = {
      dueDomains: async () => domains,
      record: async (id, verified) => {
        recorded.push([id, verified]);
        return verified ? "Verified" : "Failed";
      },
    };
    return { value, recorded };
  }

  it("verifies a domain whose TXT record holds its token and fails one without", async () => {
    const s = store([
      { id: "d1", hostname: "northwind.example.com", token: "xos-verify-abc" },
      { id: "d2", hostname: "apex.example.com", token: "xos-verify-def" },
      { id: "d3", hostname: "missing.example.com", token: "xos-verify-ghi" },
      { id: "d4", hostname: "flaky.example.com", token: "xos-verify-jkl" },
    ]);
    const records: Record<string, string[]> = {
      "_xos-verification.northwind.example.com": [" xos-verify-abc "],
      "apex.example.com": ["v=spf1 -all", "xos-verify-def"],
    };
    const summary = await verifyDomains(
      s.value,
      async (name) => {
        if (name.includes("flaky")) throw Object.assign(new Error("timeout"), { code: "ETIMEOUT" });
        const found = records[name];
        if (found === undefined)
          throw Object.assign(new Error("not found"), {
            code: name.startsWith("_") ? "ENOTFOUND" : "ENODATA",
          });
        return found;
      },
      now,
    );
    expect(s.recorded).toEqual([
      ["d1", true],
      ["d2", true],
      ["d3", false],
    ]);
    expect(summary).toEqual({ checked: 4, passed: 2, failed: 1, pending: 1 });
    expect(verificationNames("a.example.com")).toEqual([
      "_xos-verification.a.example.com",
      "a.example.com",
    ]);
  });

  it("reads due domains and records through A30's RPC", async () => {
    const { db, calls } = recordingDb({
      "from:org_domains": [
        okData([
          { id: "d1", hostname: "a.example.com", verification_token: "t1", last_checked_at: null },
          {
            id: "d2",
            hostname: "b.example.com",
            verification_token: "t2",
            last_checked_at: "2027-06-30T11:59:00Z",
          },
          {
            id: "d3",
            hostname: "c.example.com",
            verification_token: "t3",
            last_checked_at: "2027-06-30T10:00:00Z",
          },
        ]),
      ],
      "rpc:record_domain_verification": [okData("Verified")],
    });
    const s = supabaseDomainStore(db);
    expect(await s.dueDomains(10, new Date("2027-06-30T11:45:00Z"))).toEqual([
      { id: "d1", hostname: "a.example.com", token: "t1" },
      { id: "d3", hostname: "c.example.com", token: "t3" },
    ]);
    expect(await s.record("d1", true)).toBe("Verified");
    expect(calls[1]?.steps[0]?.[1]).toEqual([{ p_org_domain_id: "d1", p_verified: true }]);
  });
});

describe("organization verifier", () => {
  it("reads Stripe Identity session outcomes", async () => {
    const { http, requests } = scriptedHttp([
      {
        match: "GET https://api.stripe.com/v1/identity/verification_sessions/",
        respond: (r) => {
          const id = r.url.split("/").pop();
          if (id === "vs_ok") return { json: { status: "verified" } };
          if (id === "vs_cancel") return { json: { status: "canceled" } };
          if (id === "vs_input")
            return {
              json: { status: "requires_input", last_error: { reason: "Document expired." } },
            };
          if (id === "vs_input2") return { json: { status: "requires_input", last_error: {} } };
          return { json: { status: "processing" } };
        },
      },
    ]);
    const check = stripeIdentityCheck(http, "fixture-stripe-key");
    const ask = (reference: string) => check({ id: "r", method: "Stripe Identity", reference });
    expect(await ask("vs_ok")).toEqual({ passed: true, reason: null, expiresAt: null });
    expect(requests[0]?.headers?.["authorization"]).toBe("Bearer fixture-stripe-key");
    expect((await ask("vs_cancel")).passed).toBe(false);
    expect(await ask("vs_input")).toEqual({
      passed: false,
      reason: "Document expired.",
      expiresAt: null,
    });
    expect((await ask("vs_input2")).reason).toBe("Stripe Identity could not verify the documents.");
    expect((await ask("vs_wait")).passed).toBeNull();
    expect((await ask("not-a-session")).passed).toBe(false);
  });

  it("reads registry status", async () => {
    const { http, requests } = scriptedHttp([
      {
        match: "GET https://api.opencorporates.com/v0.4/companies/",
        respond: (r) => {
          if (r.url.includes("/GONE")) return { status: 404 };
          if (r.url.includes("/DOWN")) return { status: 503 };
          if (r.url.includes("/EMPTY")) return { json: { results: {} } };
          if (r.url.includes("/DISSOLVED"))
            return { json: { results: { company: { current_status: "Dissolved" } } } };
          if (r.url.includes("/NULLSTATUS"))
            return { json: { results: { company: { current_status: null, inactive: true } } } };
          return { json: { results: { company: { current_status: "Active", inactive: false } } } };
        },
      },
    ]);
    const check = businessRegistryCheck(http, "fixture-token", () => new Date(now));
    const ask = (reference: string) => check({ id: "r", method: "Business Registry", reference });
    expect(await ask("us_fl/P12000012345")).toEqual({
      passed: true,
      reason: null,
      expiresAt: "2028-06-30T12:00:00.000Z",
    });
    expect(requests[0]?.url).toBe(
      "https://api.opencorporates.com/v0.4/companies/us_fl/P12000012345?api_token=fixture-token",
    );
    expect(await ask("us_fl/GONE")).toMatchObject({
      passed: false,
      reason: "The registry has no company with that number.",
    });
    expect(await ask("us_fl/EMPTY")).toMatchObject({ passed: false });
    expect(await ask("us_fl/DISSOLVED")).toMatchObject({
      passed: false,
      reason: "The registry lists the company as Dissolved.",
    });
    expect(await ask("us_fl/NULLSTATUS")).toMatchObject({
      reason: "The registry lists the company as inactive.",
    });
    expect(await ask("nonsense")).toMatchObject({ passed: false });
    await expect(ask("us_fl/DOWN")).rejects.toMatchObject({ code: "provider_unavailable" });
  });

  it("records outcomes and leaves provider errors pending", async () => {
    const recorded: [string, CheckOutcome][] = [];
    const store: VerificationStore = {
      pendingRequests: async () => [
        { id: "a", method: "Stripe Identity", reference: "vs_1" },
        { id: "b", method: "Business Registry", reference: "us_fl/1" },
        { id: "c", method: "Business Registry", reference: "us_fl/2" },
        { id: "d", method: "Stripe Identity", reference: "vs_2" },
      ],
      record: async (id, outcome) => {
        recorded.push([id, outcome]);
        return "x";
      },
    };
    const summary = await verifyOrganizations(store, {
      stripe: async (r) =>
        r.reference === "vs_1"
          ? { passed: true, reason: null, expiresAt: null }
          : { passed: null, reason: null, expiresAt: null },
      registry: async (r) => {
        if (r.reference === "us_fl/2")
          throw new IntegrationError("provider_unavailable", "Registry down.", { retryable: true });
        return { passed: false, reason: "Dissolved.", expiresAt: null };
      },
    });
    expect(recorded.map(([id]) => id)).toEqual(["a", "b", "d"]);
    expect(summary).toEqual({
      checked: 4,
      passed: 1,
      failed: 1,
      pending: 2,
      errors: [{ requestId: "c", message: "Registry down." }],
    });
    await expect(
      verifyOrganizations(store, {
        stripe: () => Promise.reject(new Error("bug")),
        registry: async () => ({ passed: null, reason: null, expiresAt: null }),
      }),
    ).rejects.toThrow("bug");
  });

  it("reads pending requests and records checks", async () => {
    const { db, calls } = recordingDb({
      "from:organization_verification_requests": [
        okData([{ id: "r", method: "Stripe Identity", provider_reference: "vs_1" }]),
      ],
      "rpc:record_organization_check": [okData("Passed")],
    });
    const s = supabaseVerificationStore(db);
    expect(await s.pendingRequests(5)).toEqual([
      { id: "r", method: "Stripe Identity", reference: "vs_1" },
    ]);
    expect(await s.record("r", { passed: true, reason: null, expiresAt: null })).toBe("Passed");
    expect(calls[1]?.steps[0]?.[1]).toEqual([
      { p_request_id: "r", p_passed: true, p_reason: null, p_expires_at: null },
    ]);
  });
});

describe("SCIM service provider", () => {
  function scim(initial: ScimIdentity[] = []) {
    const identities = [...initial];
    const provisioned: unknown[][] = [];
    let refuse = false;
    let refuseRule = "scim_unavailable";
    const blocked = new Set<string>();
    const store: ScimStore = {
      emailBlocked: async (_p, email) => blocked.has(email),
      providerForToken: async (token) => (token === "xos_scim_good" ? "idp-1" : null),
      identity: async (_p, id) => identities.find((i) => i.externalId === id) ?? null,
      identityByEmail: async (_p, email) => identities.find((i) => i.email === email) ?? null,
      identitiesInGroup: async (_p, group) => identities.filter((i) => i.groups.includes(group)),
      listIdentities: async () => [...identities],
      provision: async (provider, externalId, userName, userId, active, groups) => {
        if (refuse)
          throw new StoreError({
            kind: "refusal",
            rule: refuseRule,
            message:
              refuseRule === "member_blocked"
                ? "You cannot join this organization. Ask one of its administrators."
                : "SCIM provisioning is off for this identity provider.",
          });
        provisioned.push([provider, externalId, userId, active, [...groups]]);
        const index = identities.findIndex((i) => i.externalId === externalId);
        const existing = identities[index];
        const next = {
          externalId,
          userId,
          email: userName,
          displayName: existing?.displayName ?? null,
          active,
          groups: [...groups],
        };
        if (index >= 0) identities[index] = next;
        else identities.push(next);
        return active ? "membership-1" : null;
      },
    };
    const created: string[] = [];
    const admin = {
      findOrCreateUser: async (email: string) => (created.push(email), `user-${email}`),
    };
    const request = (
      method: string,
      path: string,
      body: unknown = null,
      query = "",
      authorization: string | null = "Bearer xos_scim_good",
    ) =>
      handleScimRequest(
        { method, path, query: new URLSearchParams(query), authorization, body },
        { store, admin },
      );
    return {
      request,
      provisioned,
      created,
      identities,
      blocked,
      setRefuse: (v: boolean, rule = "scim_unavailable") => {
        refuse = v;
        refuseRule = rule;
      },
    };
  }
  const nina: ScimIdentity = {
    externalId: "okta-1",
    userId: "user-nina",
    email: "nina@northwind.example.com",
    displayName: "Nina Halvorsen",
    active: true,
    groups: ["event-finance"],
  };

  it("refuses requests without a valid token", async () => {
    const s = scim();
    expect((await s.request("GET", "/Users", null, "", null)).status).toBe(401);
    expect((await s.request("GET", "/Users", null, "", "Bearer wrong")).status).toBe(401);
  });

  it("creates, reads, filters and replaces users", async () => {
    const s = scim();
    const created = await s.request("POST", "/Users", {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: "Nina@Northwind.example.com",
      externalId: "okta-1",
      name: { givenName: "Nina", familyName: "Halvorsen" },
      groups: [{ display: "event-finance" }, { value: groupId("crew") }, { value: "%%%" }],
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      id: "okta-1",
      userName: "nina@northwind.example.com",
      displayName: "Nina Halvorsen",
      active: true,
      groups: [{ display: "event-finance" }, { display: "crew" }],
    });
    expect(s.created).toEqual(["nina@northwind.example.com"]);
    expect(s.provisioned[0]).toEqual([
      "idp-1",
      "okta-1",
      "user-nina@northwind.example.com",
      true,
      ["event-finance", "crew"],
    ]);
    expect(
      (await s.request("POST", "/Users", { userName: "nina@northwind.example.com" })).status,
    ).toBe(409);
    expect((await s.request("POST", "/Users", { userName: "not an email" })).status).toBe(400);
    const list = await s.request(
      "GET",
      "/Users",
      null,
      'filter=userName eq "NINA@northwind.example.com"',
    );
    expect(list.body).toMatchObject({ totalResults: 1, Resources: [{ id: "okta-1" }] });
    expect(
      (await s.request("GET", "/Users", null, 'filter=userName eq "x@y.example.com"')).body,
    ).toMatchObject({ totalResults: 0 });
    expect((await s.request("GET", "/Users", null, "filter=emails co x")).status).toBe(400);
    expect((await s.request("GET", "/Users/okta-1")).status).toBe(200);
    expect((await s.request("GET", "/Users/nobody")).status).toBe(404);
    const replaced = await s.request("PUT", "/Users/okta-1", {
      userName: "nina@northwind.example.com",
      displayName: "Nina H.",
      active: true,
      emails: [{ value: "nina@northwind.example.com", primary: true }],
    });
    expect(replaced).toMatchObject({
      status: 200,
      body: { displayName: "Nina H.", groups: [{ display: "event-finance" }, { display: "crew" }] },
    });
    expect(
      (await s.request("PUT", "/Users/okta-1", { userName: "other@northwind.example.com" })).body,
    ).toMatchObject({ scimType: "mutability" });
    expect((await s.request("DELETE", "/Users")).status).toBe(405);
    expect((await s.request("HEAD", "/Users/okta-1")).status).toBe(405);
  });

  it("deactivates by PATCH and DELETE, keeps the email and accepts profile patches", async () => {
    const s = scim([nina]);
    const patch = (ops: unknown[]) =>
      s.request("PATCH", "/Users/okta-1", {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: ops,
      });
    expect((await patch([{ op: "Replace", path: "active", value: false }])).body).toMatchObject({
      active: false,
    });
    expect(s.provisioned.at(-1)).toEqual([
      "idp-1",
      "okta-1",
      "user-nina",
      false,
      ["event-finance"],
    ]);
    expect((await patch([{ op: "replace", value: { active: true } }])).body).toMatchObject({
      active: true,
    });
    // Names and titles belong to the person in XOS: accepted, not stored; the email never changes.
    expect((await patch([{ op: "add", path: "title", value: "x" }])).status).toBe(200);
    expect(
      (await patch([{ op: "replace", path: "userName", value: "x@y.example.com" }])).body,
    ).toMatchObject({ scimType: "mutability" });
    expect((await patch([{ op: "remove", path: "title" }])).status).toBe(501);
    expect((await patch([{ op: "Replace", path: "active", value: "False" }])).body).toMatchObject({
      active: false,
    });
    expect((await patch([{ op: "replace", path: "active", value: 3 }])).status).toBe(400);
    expect((await s.request("PATCH", "/Users/okta-1", { Operations: [] })).status).toBe(400);
    expect((await s.request("DELETE", "/Users/okta-1")).status).toBe(204);
    expect(s.provisioned.at(-1)?.[3]).toBe(false);
    s.setRefuse(true);
    expect((await s.request("DELETE", "/Users/okta-1")).body).toMatchObject({
      status: "400",
      detail: "SCIM provisioning is off for this identity provider.",
    });
    expect((await patch([{ op: "replace", path: "active", value: true }])).status).toBe(400);
    expect(
      (await s.request("PUT", "/Users/okta-1", { userName: "nina@northwind.example.com" })).status,
    ).toBe(400);
  });

  it("refuses a blocked address with 400 invalidValue before creating its user (B16, 3050)", async () => {
    const s = scim();
    s.blocked.add("rogue@crew.example.com");
    const refused = await s.request("POST", "/Users", { userName: "rogue@crew.example.com" });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({
      status: "400",
      scimType: "invalidValue",
      detail: "You cannot join this organization. Ask one of its administrators.",
    });
    expect(s.created).toEqual([]);
    expect(s.provisioned).toEqual([]);
    // A refusal from the database's trigger is answered the same way, never with 409.
    s.setRefuse(true, "member_blocked");
    const raced = await s.request("POST", "/Users", { userName: "late@crew.example.com" });
    expect(raced.status).toBe(400);
    expect(raced.body).toMatchObject({ scimType: "invalidValue" });
  });

  it("manages group membership through /Groups", async () => {
    const s = scim([
      nina,
      {
        ...nina,
        externalId: "okta-2",
        userId: "user-sam",
        email: "sam@northwind.example.com",
        groups: [],
      },
    ]);
    const created = await s.request("POST", "/Groups", { displayName: " crew " });
    expect(created).toMatchObject({
      status: 201,
      body: { id: groupId("crew"), displayName: "crew" },
    });
    expect((await s.request("POST", "/Groups", { displayName: "" })).status).toBe(400);
    const patch = (group: string, ops: unknown[]) =>
      s.request("PATCH", `/Groups/${groupId(group)}`, {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: ops,
      });
    expect(
      (
        await patch("crew", [
          { op: "add", path: "members", value: [{ value: "okta-2" }, { value: "okta-1" }] },
        ])
      ).status,
    ).toBe(204);
    expect(s.identities.map((i) => i.groups)).toEqual([["event-finance", "crew"], ["crew"]]);
    expect((await s.request("GET", `/Groups/${groupId("crew")}`)).body).toMatchObject({
      displayName: "crew",
      members: [{ value: "okta-1" }, { value: "okta-2" }],
    });
    expect(
      (await patch("crew", [{ op: "remove", path: 'members[value eq "okta-2"]' }])).status,
    ).toBe(204);
    expect(s.identities[1]?.groups).toEqual([]);
    expect((await patch("crew", [{ op: "replace", path: "displayName", value: "x" }])).status).toBe(
      501,
    );
    expect(
      (await patch("crew", [{ op: "add", path: "members", value: [{ value: "nobody" }] }])).status,
    ).toBe(400);
    expect((await s.request("PATCH", `/Groups/${groupId("crew")}`, {})).status).toBe(400);
    expect((await s.request("DELETE", `/Groups/${groupId("crew")}`)).status).toBe(204);
    expect(s.identities[0]?.groups).toEqual(["event-finance"]);
    expect((await s.request("PUT", `/Groups/${groupId("crew")}`)).status).toBe(405);
    expect((await s.request("GET", "/Groups/!!!")).status).toBe(404);
    expect((await s.request("GET", "/Groups")).body).toMatchObject({
      totalResults: 1,
      Resources: [{ displayName: "event-finance" }],
    });
    s.setRefuse(true);
    expect(
      (await patch("crew", [{ op: "add", path: "members", value: [{ value: "okta-1" }] }])).status,
    ).toBe(400);
    expect((await s.request("GET", "/Schemas")).status).toBe(200);
    expect((await s.request("GET", "/Users/okta-1/extra")).status).toBe(404);
    expect(groupDisplay(groupId("event finance"))).toBe("event finance");
  });

  it("rethrows unexpected store failures", async () => {
    const store: ScimStore = {
      emailBlocked: async () => false,
      providerForToken: async () => "idp",
      identity: async () => nina,
      identityByEmail: async () => null,
      identitiesInGroup: async () => [],
      listIdentities: async () => [],
      provision: () => Promise.reject(new StoreError({ kind: "unexpected", message: "down" })),
    };
    await expect(
      handleScimRequest(
        {
          method: "DELETE",
          path: "/Users/okta-1",
          query: new URLSearchParams(),
          authorization: "Bearer t",
          body: null,
        },
        { store, admin: { findOrCreateUser: async () => "u" } },
      ),
    ).rejects.toBeInstanceOf(StoreError);
  });

  it("reads identities and provisions through the SCIM RPCs", async () => {
    const row = {
      external_id: "okta-1",
      user_name: "nina@northwind.example.com",
      active: true,
      groups: ["g"],
      people: { user_id: "u", full_name: "Nina" },
    };
    const { db, calls } = recordingDb({
      "rpc:scim_provider_for_token": [okData("idp")],
      "from:scim_identities": [
        okData([row]),
        okData([]),
        okData([row, { ...row, external_id: "x", people: null }]),
        okData([row]),
      ],
      "rpc:scim_provision": [okData("m")],
      "rpc:scim_email_blocked": [okData(true), okData(null)],
    });
    const s = supabaseScimStore(db);
    expect(await s.emailBlocked("idp", "rogue@crew.example.com")).toBe(true);
    expect(await s.emailBlocked("idp", "nina@northwind.example.com")).toBe(false);
    expect(await s.providerForToken("t")).toBe("idp");
    expect(await s.identity("idp", "okta-1")).toEqual({
      externalId: "okta-1",
      userId: "u",
      email: "nina@northwind.example.com",
      displayName: "Nina",
      active: true,
      groups: ["g"],
    });
    expect(await s.identity("idp", "missing")).toBeNull();
    expect(await s.identitiesInGroup("idp", "g")).toHaveLength(1);
    expect((await s.identityByEmail("idp", "nina@northwind.example.com"))?.externalId).toBe(
      "okta-1",
    );
    expect(await s.provision("idp", "okta-1", "nina@northwind.example.com", "u", true, ["g"])).toBe(
      "m",
    );
    expect(calls.at(-1)?.steps[0]?.[1]).toEqual([
      {
        p_identity_provider_id: "idp",
        p_external_id: "okta-1",
        p_user_name: "nina@northwind.example.com",
        p_user_id: "u",
        p_active: true,
        p_groups: ["g"],
      },
    ]);
  });
});
