import { describe, expect, it } from "vitest";
import {
  addIdentityProvider,
  issueScimToken,
  joinBySsoSession,
  listIdentityProviders,
  updateIdentityProvider,
} from "../src/identity-providers.ts";
import { errorResponse, fakeClient, okResponse } from "./fake-client.ts";

const ROW = {
  id: "p1",
  protocol: "SAML",
  name: "Northwind Okta",
  auth_provider_id: "prov-1",
  default_role_id: "r1",
  jit_enabled: true,
  scim_enabled: false,
  scim_token_prefix: null,
};

describe("identity providers (A77)", () => {
  it("lists an org's providers without the token hash", async () => {
    const { db, calls } = fakeClient({ "from:identity_providers": [okResponse([ROW])] });
    const result = await listIdentityProviders(db, "org-1");
    expect(result).toEqual({
      ok: true,
      data: [
        {
          id: "p1",
          protocol: "SAML",
          name: "Northwind Okta",
          authProviderId: "prov-1",
          defaultRoleId: "r1",
          jitEnabled: true,
          scimEnabled: false,
          scimTokenPrefix: null,
        },
      ],
    });
    const select = calls[0]?.steps.find(([name]) => name === "select")?.[1][0] as string;
    expect(select).not.toContain("scim_token_hash");
  });

  it("adds a provider with trimmed names and reports the plan refusal", async () => {
    const { db, calls } = fakeClient({
      "from:identity_providers": [
        okResponse({ id: "p2" }),
        errorResponse(
          "XR001",
          "integration_plan_feature: Enterprise single sign-on needs a plan with the saml_sso feature.",
          "integration_plan_feature",
        ),
      ],
    });
    const input = {
      orgId: "org-1",
      name: " Okta ",
      protocol: "SAML" as const,
      authProviderId: " prov-2 ",
      defaultRoleId: "r1",
      jitEnabled: true,
      scimEnabled: true,
    };
    expect(await addIdentityProvider(db, input)).toEqual({ ok: true, data: "p2" });
    expect(calls[0]?.steps[0]).toEqual([
      "insert",
      [
        {
          org_id: "org-1",
          name: "Okta",
          protocol: "SAML",
          auth_provider_id: "prov-2",
          default_role_id: "r1",
          jit_enabled: true,
          scim_enabled: true,
        },
      ],
    ]);
    expect(await addIdentityProvider(db, input)).toMatchObject({
      ok: false,
      error: { kind: "refusal", rule: "integration_plan_feature" },
    });
  });

  it("updates a provider and treats a row it cannot change as not found", async () => {
    const { db } = fakeClient({
      "from:identity_providers": [okResponse([{ id: "p1" }]), okResponse([])],
    });
    const input = { defaultRoleId: "r2", jitEnabled: false, scimEnabled: true };
    expect(await updateIdentityProvider(db, "p1", input)).toEqual({ ok: true, data: null });
    expect(await updateIdentityProvider(db, "p1", input)).toEqual({
      ok: false,
      error: { kind: "not-found" },
    });
  });

  it("issues a SCIM token once and passes the step-up refusal through", async () => {
    // Generated per run: no token-shaped value is stored in the repository.
    const token = `xos_scim_${crypto.randomUUID().replaceAll("-", "")}`;
    const { db } = fakeClient({
      "rpc:issue_scim_token": [
        okResponse(token),
        errorResponse(
          "XR001",
          "step_up_required: Issuing a SCIM token needs step-up authentication.",
          "step_up_required",
        ),
      ],
    });
    expect(await issueScimToken(db, "p1")).toEqual({ ok: true, data: token });
    expect(await issueScimToken(db, "p1")).toMatchObject({
      ok: false,
      error: { rule: "step_up_required" },
    });
  });

  it("joins the org of the session's identity provider, or nothing", async () => {
    const { db } = fakeClient({
      "rpc:join_by_sso_session": [
        okResponse([{ org_id: "org-1", slug: "northwind-live", joined: true }]),
        okResponse([]),
      ],
    });
    expect(await joinBySsoSession(db)).toEqual({
      ok: true,
      data: { orgId: "org-1", slug: "northwind-live", joined: true },
    });
    expect(await joinBySsoSession(db)).toEqual({ ok: true, data: null });
  });
});
