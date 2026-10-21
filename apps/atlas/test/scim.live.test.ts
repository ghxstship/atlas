import { createHmac, randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import {
  asDbClient,
  groupId,
  handleScimRequest,
  supabaseAuthAdmin,
  supabaseScimStore,
} from "@xos/integrations";

/**
 * SCIM 2.0 conformance against a running local Supabase stack (A77): an Enterprise org's Owner registers an identity
 * provider and issues its SCIM token with step-up (a TOTP factor enrolled for the run), then the endpoint's handler,
 * with the service-role store and the Auth admin port the Edge Function uses, creates, finds, lists, groups,
 * deactivates and deletes a person. Skipped unless XOS_AUTH_LIVE_URL, XOS_AUTH_LIVE_ANON_KEY and
 * XOS_STACK_SERVICE_ROLE_KEY name the stack. Every account, secret and token is generated for the run.
 */
const url = process.env["XOS_AUTH_LIVE_URL"];
const anonKey = process.env["XOS_AUTH_LIVE_ANON_KEY"];
const serviceKey = process.env["XOS_STACK_SERVICE_ROLE_KEY"];

function totp(secret: string, windows = 0): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of secret.toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  const key = Buffer.from(
    Array.from({ length: Math.floor(bits.length / 8) }, (_, i) =>
      parseInt(bits.slice(i * 8, i * 8 + 8), 2),
    ),
  );
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + windows));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = (digest[digest.length - 1] as number) & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

function memoryClient(key: string) {
  const store = new Map<string, string>();
  return createClient(url as string, key, {
    db: { schema: "app" },
    auth: {
      persistSession: true,
      autoRefreshToken: false,
      storage: {
        getItem: (k) => store.get(k) ?? null,
        setItem: (k, v) => void store.set(k, v),
        removeItem: (k) => void store.delete(k),
      },
    },
  });
}

const must = <T>(result: { data: T; error: { message: string } | null }): T => {
  if (result.error) throw new Error(result.error.message);
  return result.data;
};

describe.skipIf(!url || !anonKey || !serviceKey)("SCIM 2.0 on the local stack", () => {
  it("provisions, groups, deactivates and deletes a person for an Enterprise org", async () => {
    const run = randomBytes(4).toString("hex");
    const service = createClient(url as string, serviceKey as string, {
      db: { schema: "app" },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // An Owner and an Enterprise org.
    const owner = memoryClient(anonKey as string);
    must(
      await owner.auth.signUp({
        email: `scim-owner-${run}@atlas-e2e.test`,
        password: `Live-${randomBytes(12).toString("base64url")}`,
      }),
    );
    const orgId = must(
      await owner.rpc("create_organization", { p_name: `SCIM ${run}`, p_slug: `scim-${run}` }),
    ) as string;
    must(
      await service.from("subscriptions").update({ plan_code: "enterprise" }).eq("org_id", orgId),
    );
    const roles = must(
      await service
        .from("roles")
        .select("id, code")
        .is("org_id", null)
        .in("code", ["member", "manager"]),
    ) as { id: string; code: string }[];
    const role = (code: string) => roles.find((r) => r.code === code)?.id as string;
    const provider = must(
      await owner
        .from("identity_providers")
        .insert({
          org_id: orgId,
          protocol: "SAML",
          name: "Live Okta",
          auth_provider_id: `live-${run}`,
          default_role_id: role("member"),
          jit_enabled: true,
          scim_enabled: true,
        })
        .select("id")
        .single(),
    ) as { id: string };
    must(
      await owner.from("scim_group_mappings").insert({
        identity_provider_id: provider.id,
        idp_group: "event-managers",
        role_id: role("manager"),
      }),
    );

    // The token needs step-up: enroll a TOTP factor for the run and verify it.
    const enrolled = await owner.auth.mfa.enroll({ factorType: "totp", friendlyName: "Run" });
    if (enrolled.error) throw enrolled.error;
    const factor = enrolled.data;
    must(
      await owner.auth.mfa.challengeAndVerify({
        factorId: factor.id,
        code: totp(factor.totp.secret),
      }),
    );
    const token = must(
      await owner.rpc("issue_scim_token", { p_identity_provider_id: provider.id }),
    ) as string;

    const deps = {
      store: supabaseScimStore(asDbClient(service)),
      admin: supabaseAuthAdmin(service),
    };
    const scim = (method: string, path: string, body: unknown = null, query = "", bearer = token) =>
      handleScimRequest(
        {
          method,
          path,
          query: new URLSearchParams(query),
          authorization: `Bearer ${bearer}`,
          body,
        },
        deps,
      );

    expect((await scim("GET", "/Users", null, "", "xos_scim_wrong")).status).toBe(401);

    const email = `scim-person-${run}@atlas-e2e.test`;
    const created = await scim("POST", "/Users", {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: email,
      externalId: `ext-${run}`,
      name: { givenName: "Sky", familyName: "Provisioned" },
      active: true,
    });
    expect(created).toMatchObject({ status: 201, body: { id: `ext-${run}`, userName: email } });
    expect((await scim("POST", "/Users", { userName: email })).status).toBe(409);
    expect((await scim("GET", "/Users", null, `filter=userName eq "${email}"`)).body).toMatchObject(
      {
        totalResults: 1,
      },
    );
    expect((await scim("GET", "/Users")).body).toMatchObject({ totalResults: 1 });

    const membership = async () =>
      must(
        await service
          .from("memberships")
          .select(
            "id, valid_to, membership_roles(deleted_at, role_id), person:people!memberships_person_id_fkey(user_id)",
          )
          .eq("org_id", orgId),
      ) as unknown as {
        id: string;
        valid_to: string | null;
        membership_roles: { deleted_at: string | null; role_id: string }[];
        person: { user_id: string };
      }[];
    const userId = must(await service.rpc("scim_user_for_email", { p_email: email })) as string;
    const mine = async () => (await membership()).find((m) => m.person.user_id === userId);
    expect(
      (await mine())?.membership_roles.filter((r) => !r.deleted_at).map((r) => r.role_id),
    ).toEqual([role("member")]);

    // A group mapped to a role grants it; leaving the group takes it back.
    const group = groupId("event-managers");
    expect(
      (
        await scim("PATCH", `/Groups/${group}`, {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "add", path: "members", value: [{ value: `ext-${run}` }] }],
        })
      ).status,
    ).toBe(204);
    expect(
      (await mine())?.membership_roles
        .filter((r) => !r.deleted_at)
        .map((r) => r.role_id)
        .sort(),
    ).toEqual([role("member"), role("manager")].sort());
    expect(
      (await scim("GET", "/Groups", null, 'filter=displayName eq "event-managers"')).body,
    ).toMatchObject({
      totalResults: 1,
      Resources: [{ displayName: "event-managers", members: [{ value: `ext-${run}` }] }],
    });

    // Deactivating ends the membership; deleting keeps it ended.
    expect(
      (
        await scim("PATCH", `/Users/ext-${run}`, {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          Operations: [{ op: "replace", path: "active", value: false }],
        })
      ).body,
    ).toMatchObject({ active: false });
    expect((await mine())?.valid_to).not.toBeNull();
    expect((await scim("DELETE", `/Users/ext-${run}`)).status).toBe(204);
    expect((await scim("GET", `/Users/ext-${run}`)).body).toMatchObject({ active: false });
  }, 60_000);
});
