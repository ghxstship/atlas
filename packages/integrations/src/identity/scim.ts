import { StoreError, unwrap, type DbClient, type DbResponse } from "../framework/db.ts";

/**
 * A SCIM 2.0 service provider (RFC 7643, RFC 7644) for the Users and Groups an identity provider pushes.
 * The Edge Function hands each request here with a service-role store; the bearer token is checked
 * against its SHA-256 in the database, and joins, roles, teams and offboarding run in SQL
 * (app.scim_provision, migration 0638). Users are provisioned by email; the auth user is found or
 * created through the injected admin port, so no password or invite is ever sent from here.
 */

export interface ScimIdentity {
  readonly externalId: string;
  readonly userId: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly active: boolean;
  readonly groups: readonly string[];
}

export interface ScimStore {
  providerForToken(token: string): Promise<string | null>;
  identity(providerId: string, externalId: string): Promise<ScimIdentity | null>;
  identityByEmail(providerId: string, email: string): Promise<ScimIdentity | null>;
  identitiesInGroup(providerId: string, group: string): Promise<readonly ScimIdentity[]>;
  /** Every identity the provider provisioned, by userName. */
  listIdentities(providerId: string): Promise<readonly ScimIdentity[]>;
  provision(
    providerId: string,
    externalId: string,
    userName: string,
    userId: string,
    active: boolean,
    groups: readonly string[],
  ): Promise<string | null>;
}

/** Finds the auth user with an email or creates it (Supabase Auth admin API in production). */
export interface AuthAdmin {
  findOrCreateUser(email: string, fullName: string | null): Promise<string>;
}

export interface ScimRequest {
  readonly method: string;
  /** Path below the SCIM base, for example /Users or /Groups/abc. */
  readonly path: string;
  readonly query: URLSearchParams;
  readonly authorization: string | null;
  readonly body: unknown;
}

export interface ScimResponse {
  readonly status: number;
  readonly body: unknown;
}

const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
const LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
const PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

function scimError(status: number, detail: string, scimType?: string): ScimResponse {
  return {
    status,
    body: {
      schemas: [ERROR_SCHEMA],
      status: String(status),
      detail,
      ...(scimType ? { scimType } : {}),
    },
  };
}

function userResource(identity: ScimIdentity): Record<string, unknown> {
  return {
    schemas: [USER_SCHEMA],
    id: identity.externalId,
    userName: identity.email,
    ...(identity.displayName ? { displayName: identity.displayName } : {}),
    emails: [{ value: identity.email, primary: true }],
    active: identity.active,
    groups: identity.groups.map((g) => ({ value: groupId(g), display: g })),
    meta: { resourceType: "User" },
  };
}

/*
 * base64url without Node's Buffer, so the handler also runs in the Edge Function (Deno). Invalid input decodes to
 * null rather than throwing.
 */
function toBase64Url(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): string | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "="));
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(binary, (c) => c.charCodeAt(0)),
    );
  } catch (error) {
    if (
      error instanceof TypeError ||
      (error instanceof Error && error.name === "InvalidCharacterError")
    ) {
      return null;
    }
    throw error;
  }
}

/** Groups have no table of their own; a group's SCIM id is its display name, base64url encoded. */
export function groupId(display: string): string {
  return toBase64Url(display);
}

export function groupDisplay(id: string): string | null {
  const display = fromBase64Url(id);
  return display !== null && display.length > 0 && groupId(display) === id ? display : null;
}

function groupResource(display: string, members: readonly ScimIdentity[]): Record<string, unknown> {
  return {
    schemas: [GROUP_SCHEMA],
    id: groupId(display),
    displayName: display,
    members: members.map((m) => ({ value: m.externalId, display: m.email })),
    meta: { resourceType: "Group" },
  };
}

function listResponse(
  resources: readonly Record<string, unknown>[],
  query: URLSearchParams,
): ScimResponse {
  // RFC 7644 3.4.2.4: 1-based startIndex, count capped by the service provider.
  const startIndex = Math.max(1, Number.parseInt(query.get("startIndex") ?? "1", 10) || 1);
  const requested = Number.parseInt(query.get("count") ?? String(MAX_RESULTS), 10);
  const count = Math.min(
    MAX_RESULTS,
    Math.max(0, Number.isNaN(requested) ? MAX_RESULTS : requested),
  );
  const page = resources.slice(startIndex - 1, startIndex - 1 + count);
  return {
    status: 200,
    body: {
      schemas: [LIST_SCHEMA],
      totalResults: resources.length,
      startIndex,
      itemsPerPage: page.length,
      Resources: page,
    },
  };
}

/** `attribute eq "value"` filters, the form identity providers send (RFC 7644 3.4.2.2). */
function equalityFilter(filter: string | null, attribute: string): string | null | undefined {
  if (filter === null || filter.trim() === "") return undefined;
  const match = new RegExp(`^${attribute} eq "((?:[^"\\\\]|\\\\.)*)"$`, "i").exec(filter.trim());
  return match?.[1] === undefined ? null : match[1].replace(/\\(.)/g, "$1");
}

const MAX_RESULTS = 200;

/** The discovery resources (RFC 7644 section 4): what this service provider supports. */
const SERVICE_PROVIDER_CONFIG = {
  schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
  documentationUri: "https://docs.ghxstship.tech/guides/scim",
  patch: { supported: true },
  bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
  filter: { supported: true, maxResults: MAX_RESULTS },
  changePassword: { supported: false },
  sort: { supported: false },
  etag: { supported: false },
  authenticationSchemes: [
    {
      type: "oauthbearertoken",
      name: "Bearer token",
      description:
        "The SCIM token an Admin issues on Settings, Security, sent as Authorization: Bearer.",
      primary: true,
    },
  ],
  meta: { resourceType: "ServiceProviderConfig" },
};

const RESOURCE_TYPES = [
  {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
    id: "User",
    name: "User",
    endpoint: "/Users",
    schema: USER_SCHEMA,
    meta: { resourceType: "ResourceType" },
  },
  {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
    id: "Group",
    name: "Group",
    endpoint: "/Groups",
    schema: GROUP_SCHEMA,
    meta: { resourceType: "ResourceType" },
  },
];

const attribute = (name: string, type: string, extra: Record<string, unknown> = {}) => ({
  name,
  type,
  multiValued: false,
  required: false,
  caseExact: false,
  mutability: "readWrite",
  returned: "default",
  uniqueness: "none",
  ...extra,
});

const SCHEMAS = [
  {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:Schema"],
    id: USER_SCHEMA,
    name: "User",
    attributes: [
      attribute("userName", "string", {
        required: true,
        uniqueness: "server",
        mutability: "immutable",
      }),
      attribute("displayName", "string"),
      attribute("emails", "complex", { multiValued: true, mutability: "immutable" }),
      attribute("active", "boolean"),
      attribute("groups", "complex", { multiValued: true, mutability: "readOnly" }),
    ],
    meta: { resourceType: "Schema" },
  },
  {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:Schema"],
    id: GROUP_SCHEMA,
    name: "Group",
    attributes: [
      attribute("displayName", "string", { required: true, mutability: "immutable" }),
      attribute("members", "complex", { multiValued: true }),
    ],
    meta: { resourceType: "Schema" },
  },
];

interface UserBody {
  userName?: unknown;
  externalId?: unknown;
  displayName?: unknown;
  name?: { formatted?: unknown; givenName?: unknown; familyName?: unknown };
  emails?: { value?: unknown; primary?: unknown }[];
  active?: unknown;
  groups?: { display?: unknown; value?: unknown }[];
}

function readUser(
  body: unknown,
): { email: string; fullName: string | null; active: boolean; groups: string[] | null } | string {
  const user = (body ?? {}) as UserBody;
  const primary = user.emails?.find((e) => e.primary === true) ?? user.emails?.[0];
  const email = (
    typeof primary?.value === "string"
      ? primary.value
      : typeof user.userName === "string"
        ? user.userName
        : ""
  )
    .trim()
    .toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return "userName or a primary email must be an email address.";
  const formatted = typeof user.name?.formatted === "string" ? user.name.formatted : null;
  const parts = [user.name?.givenName, user.name?.familyName].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  const fullName =
    (typeof user.displayName === "string" ? user.displayName : null) ??
    formatted ??
    (parts.length > 0 ? parts.join(" ") : null);
  const groups = Array.isArray(user.groups)
    ? user.groups
        .map((g) =>
          typeof g.display === "string"
            ? g.display
            : typeof g.value === "string"
              ? groupDisplay(g.value)
              : null,
        )
        .filter((g): g is string => g !== null)
    : null;
  return { email, fullName, active: user.active !== false, groups };
}

function storeFailure(error: unknown): ScimResponse {
  if (error instanceof StoreError && error.error.kind === "refusal")
    return scimError(400, error.error.message, "invalidValue");
  throw error;
}

async function upsertUser(
  store: ScimStore,
  admin: AuthAdmin,
  providerId: string,
  externalId: string | null,
  body: unknown,
  existing: ScimIdentity | null,
): Promise<ScimResponse> {
  const parsed = readUser(body);
  if (typeof parsed === "string") return scimError(400, parsed, "invalidValue");
  if (existing && existing.email !== parsed.email)
    return scimError(
      400,
      "A provisioned user keeps its email address; deprovision it and provision the new address.",
      "mutability",
    );
  const userId = existing?.userId ?? (await admin.findOrCreateUser(parsed.email, parsed.fullName));
  const id =
    existing?.externalId ??
    externalId ??
    (typeof (body as UserBody).externalId === "string"
      ? ((body as UserBody).externalId as string)
      : parsed.email);
  const groups = parsed.groups ?? existing?.groups ?? [];
  try {
    await store.provision(providerId, id, parsed.email, userId, parsed.active, groups);
  } catch (error) {
    return storeFailure(error);
  }
  return {
    status: existing ? 200 : 201,
    body: userResource({
      externalId: id,
      userId,
      email: parsed.email,
      displayName: parsed.fullName,
      active: parsed.active,
      groups,
    }),
  };
}

interface PatchOperation {
  op?: unknown;
  path?: unknown;
  value?: unknown;
}

function operations(body: unknown): PatchOperation[] | null {
  const patch = (body ?? {}) as { schemas?: unknown; Operations?: unknown };
  if (
    !Array.isArray(patch.schemas) ||
    !patch.schemas.includes(PATCH_SCHEMA) ||
    !Array.isArray(patch.Operations)
  )
    return null;
  return patch.Operations as PatchOperation[];
}

/** Handles one SCIM request. Unknown routes answer 404 and unsupported operations 501, in SCIM error form. */
export async function handleScimRequest(
  request: ScimRequest,
  deps: { readonly store: ScimStore; readonly admin: AuthAdmin },
): Promise<ScimResponse> {
  const { store, admin } = deps;
  const token = /^Bearer (\S+)$/.exec(request.authorization ?? "")?.[1];
  const providerId = token === undefined ? null : await store.providerForToken(token);
  if (providerId === null)
    return scimError(401, "The bearer token is not valid for SCIM provisioning.");
  const [resource, id, extra] = request.path.replace(/^\/+|\/+$/g, "").split("/");
  if (extra !== undefined) return scimError(404, "No such SCIM resource.");
  const method = request.method.toUpperCase();

  // Discovery (RFC 7644 section 4): read-only, behind the same token.
  if (
    resource === "ServiceProviderConfig" ||
    resource === "ResourceTypes" ||
    resource === "Schemas"
  ) {
    if (method !== "GET") return scimError(405, "Discovery resources are read-only.");
    if (resource === "ServiceProviderConfig") {
      return id === undefined
        ? { status: 200, body: SERVICE_PROVIDER_CONFIG }
        : scimError(404, "No such SCIM resource.");
    }
    const all: readonly Record<string, unknown>[] =
      resource === "ResourceTypes" ? RESOURCE_TYPES : SCHEMAS;
    if (id === undefined) return listResponse(all, request.query);
    const one = all.find((r) => r["id"] === id);
    return one ? { status: 200, body: one } : scimError(404, "No such SCIM resource.");
  }

  if (resource === "Users") {
    if (id === undefined && method === "GET") {
      const userName = equalityFilter(request.query.get("filter"), "userName");
      if (userName === null)
        return scimError(400, 'Filter users by userName eq "address".', "invalidFilter");
      if (userName !== undefined) {
        const found = await store.identityByEmail(providerId, userName.toLowerCase());
        return listResponse(found ? [userResource(found)] : [], request.query);
      }
      const everyone = await store.listIdentities(providerId);
      return listResponse(everyone.map(userResource), request.query);
    }
    if (id === undefined && method === "POST") {
      const parsed = readUser(request.body);
      if (
        typeof parsed !== "string" &&
        (await store.identityByEmail(providerId, parsed.email)) !== null
      ) {
        return scimError(409, "A user with this userName is already provisioned.", "uniqueness");
      }
      return upsertUser(store, admin, providerId, null, request.body, null);
    }
    if (id === undefined) return scimError(405, "Use GET or POST on /Users.");
    const existing = await store.identity(providerId, id);
    if (existing === null) return scimError(404, "No such user.");
    if (method === "GET") return { status: 200, body: userResource(existing) };
    if (method === "PUT") return upsertUser(store, admin, providerId, id, request.body, existing);
    if (method === "DELETE") {
      try {
        await store.provision(
          providerId,
          id,
          existing.email,
          existing.userId,
          false,
          existing.groups,
        );
      } catch (error) {
        return storeFailure(error);
      }
      return { status: 204, body: null };
    }
    if (method === "PATCH") {
      const ops = operations(request.body);
      if (ops === null) return scimError(400, "Send a PatchOp with Operations.", "invalidSyntax");
      let active = existing.active;
      for (const op of ops) {
        const kind = String(op.op).toLowerCase();
        const value = op.value as Record<string, unknown> | boolean | string | undefined;
        const path = typeof op.path === "string" ? op.path : undefined;
        if (kind !== "replace" && kind !== "add") {
          return scimError(501, "Users take replace and add; manage groups through /Groups.");
        }
        // Identity providers send active as a boolean or the string "True"/"False" (Microsoft Entra).
        const asBoolean = (v: unknown) =>
          typeof v === "boolean" ? v : typeof v === "string" ? /^true$/i.test(v) : undefined;
        if (path?.toLowerCase() === "active") {
          const next = asBoolean(value);
          if (next === undefined) return scimError(400, "active is true or false.", "invalidValue");
          active = next;
        } else if (path === undefined && typeof value === "object" && value !== null) {
          if (Object.keys(value).some((k) => /^(userName|emails)/i.test(k))) {
            return scimError(400, "A provisioned user keeps its email address.", "mutability");
          }
          const next = asBoolean(value["active"]);
          if (next !== undefined) active = next;
        } else if (path !== undefined && /^(userName|emails)/i.test(path)) {
          return scimError(400, "A provisioned user keeps its email address.", "mutability");
        }
        // Names and other profile attributes belong to the person in XOS, not the directory: accepted, not stored.
      }
      try {
        await store.provision(
          providerId,
          id,
          existing.email,
          existing.userId,
          active,
          existing.groups,
        );
      } catch (error) {
        return storeFailure(error);
      }
      return { status: 200, body: userResource({ ...existing, active }) };
    }
    return scimError(405, "That method is not allowed on a user.");
  }

  if (resource === "Groups") {
    if (id === undefined && method === "GET") {
      // A group exists while a provisioned person is in it; creating one stores nothing until it has members.
      const wanted = equalityFilter(request.query.get("filter"), "displayName");
      if (wanted === null) {
        return scimError(400, 'Filter groups by displayName eq "name".', "invalidFilter");
      }
      const everyone = await store.listIdentities(providerId);
      const names = [...new Set(everyone.flatMap((i) => i.groups))]
        .filter((g) => wanted === undefined || g === wanted)
        .sort((a, b) => a.localeCompare(b));
      const excludeMembers = request.query.get("excludedAttributes") === "members";
      return listResponse(
        names.map((g) =>
          groupResource(g, excludeMembers ? [] : everyone.filter((i) => i.groups.includes(g))),
        ),
        request.query,
      );
    }
    if (id === undefined && method === "POST") {
      const display = (request.body as { displayName?: unknown } | null)?.displayName;
      if (typeof display !== "string" || display.trim().length === 0)
        return scimError(400, "A group needs a displayName.", "invalidValue");
      return { status: 201, body: groupResource(display.trim(), []) };
    }
    const display = id === undefined ? null : groupDisplay(id);
    if (display === null) return scimError(404, "No such group.");
    const members = await store.identitiesInGroup(providerId, display);
    if (method === "GET") {
      return {
        status: 200,
        body: {
          schemas: [GROUP_SCHEMA],
          id,
          displayName: display,
          members: members.map((m) => ({ value: m.externalId, display: m.email })),
        },
      };
    }
    if (method === "DELETE") {
      for (const member of members) {
        await store.provision(
          providerId,
          member.externalId,
          member.email,
          member.userId,
          member.active,
          member.groups.filter((g) => g !== display),
        );
      }
      return { status: 204, body: null };
    }
    if (method === "PATCH") {
      const ops = operations(request.body);
      if (ops === null) return scimError(400, "Send a PatchOp with Operations.", "invalidSyntax");
      for (const op of ops) {
        const kind = String(op.op).toLowerCase();
        const removeFilter =
          typeof op.path === "string"
            ? /^members\[value eq "([^"]+)"\]$/.exec(op.path)?.[1]
            : undefined;
        const values =
          removeFilter !== undefined
            ? [removeFilter]
            : op.path === "members" && Array.isArray(op.value)
              ? (op.value as { value?: unknown }[])
                  .map((v) => v.value)
                  .filter((v): v is string => typeof v === "string")
              : null;
        if (values === null || (kind !== "add" && kind !== "remove")) {
          return scimError(501, "Only adding and removing members is supported on groups.");
        }
        for (const memberId of values) {
          const member = await store.identity(providerId, memberId);
          if (member === null)
            return scimError(400, `No provisioned user ${memberId}.`, "invalidValue");
          const groups =
            kind === "add"
              ? [...new Set([...member.groups, display])]
              : member.groups.filter((g) => g !== display);
          try {
            await store.provision(
              providerId,
              member.externalId,
              member.email,
              member.userId,
              member.active,
              groups,
            );
          } catch (error) {
            return storeFailure(error);
          }
        }
      }
      return { status: 204, body: null };
    }
    return scimError(405, "That method is not allowed on a group.");
  }

  return scimError(404, "No such SCIM resource.");
}

interface IdentityRow {
  external_id: string;
  user_name: string;
  active: boolean;
  groups: string[];
  people: { user_id: string | null; full_name: string | null } | null;
}

function toIdentity(row: IdentityRow): ScimIdentity | null {
  if (row.people === null || row.people.user_id === null) return null;
  return {
    externalId: row.external_id,
    userId: row.people.user_id,
    email: row.user_name,
    displayName: row.people.full_name,
    active: row.active,
    groups: row.groups,
  };
}

const IDENTITY_COLUMNS =
  "external_id, user_name, active, groups, people:person_id (user_id, full_name)";

/** The SCIM store over the service-role client (the SCIM RPCs are service role only). */
export function supabaseScimStore(db: DbClient): ScimStore {
  const one = async (query: PromiseLike<DbResponse>) => {
    const rows = await unwrap<IdentityRow[]>(query);
    const first = rows[0];
    return first === undefined ? null : toIdentity(first);
  };
  return {
    async providerForToken(token) {
      return unwrap<string | null>(db.rpc("scim_provider_for_token", { p_token: token }));
    },
    async identity(providerId, externalId) {
      return one(
        db
          .from("scim_identities")
          .select(IDENTITY_COLUMNS)
          .eq("identity_provider_id", providerId)
          .eq("external_id", externalId)
          .is("deleted_at", null)
          .limit(1),
      );
    },
    async identityByEmail(providerId, email) {
      return one(
        db
          .from("scim_identities")
          .select(IDENTITY_COLUMNS)
          .eq("identity_provider_id", providerId)
          .eq("user_name", email)
          .is("deleted_at", null)
          .limit(1),
      );
    },
    async identitiesInGroup(providerId, group) {
      const rows = await unwrap<IdentityRow[]>(
        db
          .from("scim_identities")
          .select(IDENTITY_COLUMNS)
          .eq("identity_provider_id", providerId)
          .is("deleted_at", null),
      );
      return rows
        .map(toIdentity)
        .filter((i): i is ScimIdentity => i !== null && i.groups.includes(group));
    },
    async listIdentities(providerId) {
      const rows = await unwrap<IdentityRow[]>(
        db
          .from("scim_identities")
          .select(IDENTITY_COLUMNS)
          .eq("identity_provider_id", providerId)
          .is("deleted_at", null)
          .order("user_name"),
      );
      return rows.map(toIdentity).filter((i): i is ScimIdentity => i !== null);
    },
    async provision(providerId, externalId, userName, userId, active, groups) {
      return unwrap<string | null>(
        db.rpc("scim_provision", {
          p_identity_provider_id: providerId,
          p_external_id: externalId,
          p_user_name: userName,
          p_user_id: userId,
          p_active: active,
          p_groups: [...groups],
        }),
      );
    },
  };
}

/** The slice of a service-role Supabase client the Auth admin port needs. */
export interface AuthAdminClient {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<DbResponse>;
  readonly auth: {
    readonly admin: {
      createUser(attributes: {
        email: string;
        email_confirm: boolean;
        user_metadata?: Record<string, unknown>;
      }): PromiseLike<{
        data: { user: { id: string } | null };
        error: { message: string } | null;
      }>;
    };
  };
}

/**
 * Finds the sign-in for an email (`app.scim_user_for_email`, migration 1332) or creates it confirmed, with no
 * password: the person signs in through single sign-on, a magic link or a passkey. Never sends an invitation.
 */
export function supabaseAuthAdmin(client: AuthAdminClient): AuthAdmin {
  const existing = async (email: string) =>
    unwrap<string | null>(client.rpc("scim_user_for_email", { p_email: email }));
  return {
    async findOrCreateUser(email, fullName) {
      const found = await existing(email);
      if (found) return found;
      const { data, error } = await client.auth.admin.createUser({
        email,
        email_confirm: true,
        ...(fullName ? { user_metadata: { full_name: fullName } } : {}),
      });
      if (data.user) return data.user.id;
      // Another request created it a moment ago.
      const raced = await existing(email);
      if (raced) return raced;
      throw new Error(`Cannot create the sign-in for SCIM: ${error?.message ?? "no user"}`);
    },
  };
}

/**
 * SCIM over HTTP (RFC 7644): the Edge Function's request in, the SCIM response out as application/scim+json.
 * `basePath` is what precedes the SCIM resource in the URL path, for example /functions/v1/scim/v2.
 */
export async function serveScim(
  request: Request,
  deps: { readonly store: ScimStore; readonly admin: AuthAdmin; readonly basePath: string },
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.startsWith(deps.basePath)
    ? url.pathname.slice(deps.basePath.length)
    : url.pathname.replace(/^.*?\/scim(\/v2)?(?=\/|$)/, "");
  const method = request.method.toUpperCase();
  let body: unknown = null;
  if (method === "POST" || method === "PUT" || method === "PATCH") {
    try {
      body = await request.json();
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      const invalid = scimError(400, "The request body is not JSON.", "invalidSyntax");
      return new Response(JSON.stringify(invalid.body), {
        status: invalid.status,
        headers: { "content-type": "application/scim+json" },
      });
    }
  }
  const result = await handleScimRequest(
    {
      method,
      path,
      query: url.searchParams,
      authorization: request.headers.get("authorization"),
      body,
    },
    deps,
  );
  return new Response(result.body === null ? null : JSON.stringify(result.body), {
    status: result.status,
    headers: result.body === null ? {} : { "content-type": "application/scim+json" },
  });
}
