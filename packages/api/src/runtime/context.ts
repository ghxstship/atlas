/**
 * The request context every handler receives: who is calling, for which organization, in which
 * locale, and a typed Supabase client that acts as the caller so RLS decides access (ADR 0003,
 * ADR 0007 item 1). The service role is never used for user requests.
 */
import type { XosClient } from "@xos/data";

export type CredentialKind = "session" | "api_key";

export interface RequestUser {
  /** `auth.users.id` of the caller. */
  readonly id: string;
  readonly email: string | null;
}

export interface RequestOrg {
  /** The active organization bound to the credential. */
  readonly id: string;
}

export interface RequestContext {
  readonly user: RequestUser;
  /** Null when the credential carries no active organization (a person with no membership yet). */
  readonly org: RequestOrg | null;
  /** BCP 47 locale for user-facing text, from `Accept-Language` or the default. */
  readonly locale: string;
  /** Supabase client acting as the caller, with `db.schema` set to `app`. */
  readonly db: XosClient;
  readonly credential: CredentialKind;
  /** Correlation id echoed as `X-Request-Id`. */
  readonly requestId: string;
}

/**
 * Resolves the caller from the request. Returns null when no credential is present or the
 * credential is invalid; the runtime answers 401.
 */
export type Authenticate = (request: Request, requestId: string) => Promise<RequestContext | null>;
