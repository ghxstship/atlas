import { isAuthError } from "@supabase/supabase-js";
import {
  getCurrentPerson,
  listMyOrganizations,
  type MyOrganization,
  type Person,
  type XosClient,
} from "@xos/data";
import type { OrgAuthDecision } from "@xos/data/auth-assurance";
import type { Route } from "next";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { orgAuthRedirect, PATH_HEADER } from "@/lib/auth/assurance";
import { createServerSupabase } from "@/lib/supabase/server";
import { VIEW_AS_COOKIE } from "@xos/data/access";
import { applyViewAs, type ViewAsPreview } from "@/lib/access/view-as";
import { resolveMembership, type Membership } from "./membership";

/**
 * Who is looking, resolved once per request (React cache) for layouts, pages and actions.
 * Row level security still decides every read and write; this context only shapes navigation and
 * hides controls a person cannot use (Section 5, rule 1).
 */

export interface Viewer {
  readonly db: XosClient;
  readonly userId: string;
  readonly email: string | null;
  readonly emailConfirmed: boolean;
  /** Null only in the moment between sign-up and the person trigger; treated as no orgs. */
  readonly person: Person | null;
}

export interface OrgContext extends Membership {
  readonly viewer: Viewer;
  /** The role the viewer previews with View as role (A36, Section 8.4), or null. */
  readonly preview: ViewAsPreview | null;
}

/** The signed-in viewer, or null when there is no valid session. */
export const getViewer = cache(async (): Promise<Viewer | null> => {
  const db = await createServerSupabase();
  const { data, error } = await db.auth.getUser();
  if (error) {
    if (isAuthError(error) && (error.status ?? 400) < 500) return null;
    throw error;
  }
  const user = data.user;
  const person = await getCurrentPerson(db, user.id);
  if (!person.ok && person.error.kind !== "not-found") {
    throw new Error(`Cannot read the signed-in person: ${JSON.stringify(person.error)}`);
  }
  return {
    db,
    userId: user.id,
    email: user.email ?? null,
    emailConfirmed: Boolean(user.email_confirmed_at),
    person: person.ok ? person.data : null,
  };
});

/** Every org the viewer belongs to, for the org switcher and the entry redirect. */
export const getMyOrganizations = cache(async (): Promise<MyOrganization[]> => {
  const viewer = await getViewer();
  if (!viewer?.person) return [];
  const result = await listMyOrganizations(viewer.db, viewer.person.id);
  if (!result.ok) throw new Error(`Cannot list organizations: ${JSON.stringify(result.error)}`);
  return result.data;
});

/**
 * The viewer's context in an org by slug, or null when the org does not exist, the viewer is not
 * signed in, or holds no active membership there. Callers answer 404 for null (ADR 0003).
 *
 * When the org's security settings ask more of the session (A77: a second factor its MFA policy
 * requires, or a sign-in its session lifetime or idle timeout ended), this redirects to verify or
 * to sign in again, as the proxy does; that covers a page that re-renders after an action changed
 * the policy, and a server action that names another org than its page.
 */
export const getOrgContext = cache(async (slug: string): Promise<OrgContext | null> => {
  const viewer = await getViewer();
  if (!viewer?.person) return null;
  const requestHeaders = await headers();
  const owed: { decision: OrgAuthDecision | null } = { decision: null };
  const membership = await resolveMembership(
    viewer.db,
    viewer.person.id,
    slug,
    requestHeaders,
    undefined,
    {
      onRequired: (decision) => {
        owed.decision = decision;
      },
    },
  );
  if (!membership && owed.decision !== null) {
    const here = requestHeaders.get(PATH_HEADER) ?? `/${slug}/home`;
    const to = orgAuthRedirect(owed.decision, slug, here, "");
    if (to !== null) redirect(to as Route);
  }
  if (!membership) return null;
  const previewed = await applyViewAs(
    viewer.db,
    membership,
    (await cookies()).get(VIEW_AS_COOKIE)?.value,
  );
  return { ...previewed, viewer };
});
