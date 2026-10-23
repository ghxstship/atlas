import { requireSecondFactor } from "@xos/data/auth-assurance";
import type { XosClient } from "@xos/data/client";
import { can, getOperator, type ConsolePermission, type Operator } from "@xos/data/console";
import type { Route } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Who may use the console (A90, ADR 0046). Every console page and action goes through here:
 *   1. a signed-in session, or the sign-in page;
 *   2. a live operator grant (app.console_whoami), or the refusal route, which signs the person out;
 *   3. a second factor in this session (A77's requireSecondFactor, the rule of private.require_second_factor), or
 *      the second factor page.
 * The database repeats the operator, permission and second-factor checks in every console RPC
 * (private.require_platform_operator), so these checks are a convenience, never the guard.
 */
export interface ConsoleContext {
  readonly db: XosClient;
  readonly operator: Operator;
}

/** The path this request asked for, set by the proxy, for returning after sign-in. */
async function requestedPath(): Promise<string> {
  return (await headers()).get("x-console-path") ?? "/tenants";
}

export const getConsoleContext = cache(async (): Promise<ConsoleContext> => {
  const db = await createServerSupabase();
  const { data } = await db.auth.getUser();
  const next = encodeURIComponent(await requestedPath());
  if (!data.user) redirect(`/auth/sign-in?next=${next}` as Route);
  const operator = await getOperator(db);
  if (!operator.ok) throw new Error(`Cannot read the operator: ${operator.error.kind}`);
  if (!operator.data) redirect("/auth/refused" as Route);
  const stepUp = await requireSecondFactor(db, { recent: false });
  if (!stepUp.ok) redirect(`/auth/second-factor?next=${next}` as Route);
  return { db, operator: operator.data };
});

/** The console context for a page that needs one permission; 404 for a role without it (ADR 0003). */
export async function requirePermission(permission: ConsolePermission): Promise<ConsoleContext> {
  const ctx = await getConsoleContext();
  if (!can(ctx.operator, permission)) notFound();
  return ctx;
}

export type ActionContext =
  | { readonly ok: true; readonly db: XosClient; readonly operator: Operator }
  | { readonly ok: false; readonly key: string };

/**
 * The context of a server action: the same three checks, answered as an error state instead of a redirect so the
 * form can say what to do. A missing second factor names step_up_required, as the database would.
 */
export async function actionContext(permission: ConsolePermission): Promise<ActionContext> {
  const db = await createServerSupabase();
  const operator = await getOperator(db);
  if (!operator.ok || !operator.data || !can(operator.data, permission)) {
    return { ok: false, key: "errors.notFound" };
  }
  const stepUp = await requireSecondFactor(db, { recent: false });
  if (!stepUp.ok) return { ok: false, key: "errors.step_up_required" };
  return { ok: true, db, operator: operator.data };
}
