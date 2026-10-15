import type { Result } from "@xos/data";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { getOrgContext, type OrgContext } from "@/lib/shell/context";
import { fromDataError, type ActionState } from "./forms";

/**
 * Server action plumbing for the A16 modules. Each action resolves the viewer's org context from
 * the form's `org` field (404 when it is gone), calls one repository function, revalidates the
 * module's pages and reports the outcome as an ActionState.
 */

export async function actionContext(form: FormData): Promise<OrgContext> {
  const slug = form.get("org");
  const ctx = typeof slug === "string" ? await getOrgContext(slug) : null;
  if (!ctx) notFound();
  return ctx;
}

/** Turns a repository result into an ActionState and revalidates the module on success. */
export function finish<T>(result: Result<T>, ctx: OrgContext, module: string): ActionState {
  if (!result.ok) return fromDataError(result.error);
  revalidatePath(`/${ctx.org.slug}/${module}`, "layout");
  const data = result.data as unknown;
  const id =
    typeof data === "object" && data !== null && "id" in data
      ? String((data as { id: unknown }).id)
      : undefined;
  return id === undefined ? { ok: true } : { ok: true, id };
}
