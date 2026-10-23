/**
 * The request context every handler receives: who is calling, for which organization, in which
 * locale, and a typed Supabase client that acts as the caller so RLS decides access (ADR 0003,
 * ADR 0007 item 1). The service role is never used for user requests.
 */
import type { XosClient } from "@xos/data";
import { refused } from "../problem.ts";

/** A person's session, an org API key, or an OAuth app acting for a person (A99, ADR 0055). */
export type CredentialKind = "session" | "api_key" | "oauth";

export interface RequestUser {
  /** `auth.users.id` of the caller. */
  readonly id: string;
  readonly email: string | null;
}

export interface RequestOrg {
  /** The active organization bound to the credential. */
  readonly id: string;
  readonly slug: string;
}

export interface RequestContext {
  readonly user: RequestUser;
  /** `app.people.id` of the caller; null before the sign-in has a person row. */
  readonly personId: string | null;
  /** Null when the credential carries no active organization (a person with no membership yet). */
  readonly org: RequestOrg | null;
  /** BCP 47 locale for user-facing text, from `Accept-Language` or the default. */
  readonly locale: string;
  /** Supabase client acting as the caller, with `db.schema` set to `app`. */
  readonly db: XosClient;
  readonly credential: CredentialKind;
  /** Capability groups an API key or OAuth app may use; absent for session credentials (the role decides). */
  readonly scopes?: readonly string[];
  /** Correlation id echoed as `X-Request-Id`. */
  readonly requestId: string;
}

/**
 * Resolves the caller from the request. Returns null when no credential is present or the
 * credential is invalid; the runtime answers 401. May throw an `ApiProblem` for a malformed
 * credential.
 */
export type Authenticate = (request: Request, requestId: string) => Promise<RequestContext | null>;

/** The active organization, or a refusal naming the next step when the caller has none. */
export function requireOrg(context: RequestContext): RequestOrg {
  if (context.org !== null) return context.org;
  throw refused(
    "REFUSE",
    "Choose an organization in the context switcher before using this operation.",
    "api.active_org_required",
  );
}

/** The caller's person id, or a refusal when the sign-in has no person yet. */
export function requirePerson(context: RequestContext): string {
  if (context.personId !== null) return context.personId;
  throw refused(
    "REFUSE",
    "Finish setting up your account before using this operation.",
    "api.person_required",
  );
}
