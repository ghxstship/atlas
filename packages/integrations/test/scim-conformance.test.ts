import { describe, expect, it, vi } from "vitest";
import {
  groupId,
  handleScimRequest,
  serveScim,
  supabaseAuthAdmin,
  type ScimIdentity,
  type ScimStore,
} from "../src/identity/scim.ts";

/**
 * SCIM 2.0 conformance (RFC 7643, RFC 7644) of the endpoint identity providers call (A77): discovery, list
 * responses with paging, equality filters, group listing, and the HTTP framing the Edge Function serves. The live
 * suite in scim.live.test.ts runs the same calls against the database.
 */

const token = `xos_scim_${crypto.randomUUID().replaceAll("-", "")}`;

function memoryStore(identities: ScimIdentity[]): ScimStore {
  return {
    emailBlocked: async () => false,
    providerForToken: async (t) => (t === token ? "idp-1" : null),
    identity: async (_p, id) => identities.find((i) => i.externalId === id) ?? null,
    identityByEmail: async (_p, email) => identities.find((i) => i.email === email) ?? null,
    identitiesInGroup: async (_p, g) => identities.filter((i) => i.groups.includes(g)),
    listIdentities: async () => [...identities].sort((a, b) => a.email.localeCompare(b.email)),
    provision: async () => "membership-1",
  };
}

const person = (n: number, groups: string[] = []): ScimIdentity => ({
  externalId: `ext-${n}`,
  userId: `user-${n}`,
  email: `person${String(n).padStart(2, "0")}@northwind.example.com`,
  displayName: `Person ${n}`,
  active: true,
  groups,
});

const admin = { findOrCreateUser: async (email: string) => `user-${email}` };

function call(store: ScimStore, method: string, path: string, query = "", body: unknown = null) {
  return handleScimRequest(
    { method, path, query: new URLSearchParams(query), authorization: `Bearer ${token}`, body },
    { store, admin },
  );
}

describe("SCIM discovery", () => {
  const store = memoryStore([]);

  it("describes the service provider: PATCH and filters, no bulk, sort or password change", async () => {
    const config = await call(store, "GET", "/ServiceProviderConfig");
    expect(config.status).toBe(200);
    expect(config.body).toMatchObject({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
      patch: { supported: true },
      bulk: { supported: false },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      authenticationSchemes: [{ type: "oauthbearertoken" }],
    });
    expect((await call(store, "POST", "/ServiceProviderConfig")).status).toBe(405);
  });

  it("lists the User and Group resource types and their schemas", async () => {
    expect((await call(store, "GET", "/ResourceTypes")).body).toMatchObject({
      totalResults: 2,
      Resources: [
        { id: "User", endpoint: "/Users" },
        { id: "Group", endpoint: "/Groups" },
      ],
    });
    expect((await call(store, "GET", "/ResourceTypes/User")).body).toMatchObject({ name: "User" });
    expect((await call(store, "GET", "/ResourceTypes/Device")).status).toBe(404);
    const schema = await call(store, "GET", "/Schemas/urn:ietf:params:scim:schemas:core:2.0:User");
    expect(schema.body).toMatchObject({ name: "User" });
  });

  it("still asks for the token", async () => {
    const anonymous = await handleScimRequest(
      {
        method: "GET",
        path: "/ServiceProviderConfig",
        query: new URLSearchParams(),
        authorization: null,
        body: null,
      },
      { store, admin },
    );
    expect(anonymous.status).toBe(401);
    expect(anonymous.body).toMatchObject({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      status: "401",
    });
  });
});

describe("SCIM lists", () => {
  const store = memoryStore(
    Array.from({ length: 5 }, (_, i) => person(i + 1, i < 3 ? ["crew"] : ["finance"])),
  );

  it("pages users with a 1-based startIndex and count", async () => {
    const page = await call(store, "GET", "/Users", "startIndex=2&count=2");
    expect(page.body).toMatchObject({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
      totalResults: 5,
      startIndex: 2,
      itemsPerPage: 2,
      Resources: [{ id: "ext-2" }, { id: "ext-3" }],
    });
    expect((await call(store, "GET", "/Users", "count=0")).body).toMatchObject({
      totalResults: 5,
      itemsPerPage: 0,
    });
    expect((await call(store, "GET", "/Users", "startIndex=-4")).body).toMatchObject({
      startIndex: 1,
      itemsPerPage: 5,
    });
  });

  it("filters users by userName, ignoring case and honoring escapes", async () => {
    const found = await call(
      store,
      "GET",
      "/Users",
      'filter=USERNAME eq "Person04@northwind.example.com"',
    );
    expect(found.body).toMatchObject({ totalResults: 1, Resources: [{ id: "ext-4" }] });
    expect((await call(store, "GET", "/Users", 'filter=userName sw "p"')).body).toMatchObject({
      scimType: "invalidFilter",
    });
  });

  it("lists groups from the people in them, filtered by displayName", async () => {
    const all = await call(store, "GET", "/Groups");
    expect(all.body).toMatchObject({
      totalResults: 2,
      Resources: [
        { displayName: "crew", id: groupId("crew") },
        { displayName: "finance", id: groupId("finance") },
      ],
    });
    const crew = await call(store, "GET", "/Groups", 'filter=displayName eq "crew"');
    expect(crew.body).toMatchObject({ totalResults: 1 });
    expect(
      (crew.body as { Resources: { members: unknown[] }[] }).Resources[0]?.members,
    ).toHaveLength(3);
    const lean = await call(
      store,
      "GET",
      "/Groups",
      'filter=displayName eq "crew"&excludedAttributes=members',
    );
    expect((lean.body as { Resources: { members: unknown[] }[] }).Resources[0]?.members).toEqual(
      [],
    );
    expect(
      (await call(store, "GET", "/Groups", 'filter=displayName eq "nobody"')).body,
    ).toMatchObject({ totalResults: 0 });
    expect((await call(store, "GET", "/Groups", "filter=members pr")).status).toBe(400);
  });
});

describe("SCIM over HTTP", () => {
  const store = memoryStore([person(1, ["crew"])]);
  const base = "https://project.example.com/functions/v1/scim/v2";

  it("serves application/scim+json below the base path", async () => {
    const response = await serveScim(
      new Request(`${base}/Users/ext-1`, { headers: { authorization: `Bearer ${token}` } }),
      { store, admin, basePath: "/functions/v1/scim/v2" },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/scim+json");
    expect(await response.json()).toMatchObject({
      id: "ext-1",
      userName: "person01@northwind.example.com",
    });
  });

  it("finds the resource after any /scim prefix and answers 204 with no body", async () => {
    const response = await serveScim(
      new Request("https://edge.example.com/scim/Users/ext-1", {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      }),
      { store, admin, basePath: "/functions/v1/scim/v2" },
    );
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  it("refuses a body that is not JSON", async () => {
    const response = await serveScim(
      new Request(`${base}/Users`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/scim+json" },
        body: "{not json",
      }),
      { store, admin, basePath: "/functions/v1/scim/v2" },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ scimType: "invalidSyntax" });
  });
});

describe("the Auth admin port", () => {
  it("reuses an existing sign-in and creates a confirmed one without a password otherwise", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ data: "user-existing", error: null })
      .mockResolvedValueOnce({ data: null, error: null });
    const createUser = vi.fn(async () => ({ data: { user: { id: "user-new" } }, error: null }));
    const port = supabaseAuthAdmin({ rpc, auth: { admin: { createUser } } });
    expect(await port.findOrCreateUser("a@northwind.example.com", "Ana")).toBe("user-existing");
    expect(createUser).not.toHaveBeenCalled();
    expect(await port.findOrCreateUser("b@northwind.example.com", "Ben")).toBe("user-new");
    expect(createUser).toHaveBeenCalledWith({
      email: "b@northwind.example.com",
      email_confirm: true,
      user_metadata: { full_name: "Ben" },
    });
    expect(rpc).toHaveBeenCalledWith("scim_user_for_email", { p_email: "a@northwind.example.com" });
  });

  it("takes the sign-in another request created first, and says so when there is none", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: "user-raced", error: null })
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: null, error: null });
    const createUser = vi.fn(async () => ({
      data: { user: null },
      error: { message: "A user with this email address has already been registered" },
    }));
    const port = supabaseAuthAdmin({ rpc, auth: { admin: { createUser } } });
    expect(await port.findOrCreateUser("c@northwind.example.com", null)).toBe("user-raced");
    await expect(port.findOrCreateUser("d@northwind.example.com", null)).rejects.toThrow(
      /already been registered/,
    );
  });
});
