import { isAuthError } from "@supabase/supabase-js";
import {
  getCurrentPerson,
  listMyOrganizations,
  type MyOrganization,
  type Person,
  type XosClient,
} from "@xos/data";
import { headers } from "next/headers";
import { cache } from "react";
import { createServerSupabase } from "@/lib/supabase/server";
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
 */
export const getOrgContext = cache(async (slug: string): Promise<OrgContext | null> => {
  const viewer = await getViewer();
  if (!viewer?.person) return null;
  const membership = await resolveMembership(viewer.db, viewer.person.id, slug, await headers());
  return membership ? { ...membership, viewer } : null;
});
