"use server";

import { adoptStandardLibrary } from "@xos/data/standard-library";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { getOrgContext } from "@/lib/shell/context";
import { failed, type ActionState } from "@/lib/operations/state";

/**
 * WP18's settings action: "Adopt Standard Library" (Settings, Canon Extensions). It runs as the viewer, so
 * app.adopt_standard_library (migration 1612) checks canon.extension.write and copies only the rows the org
 * never held. The result carries how many rows this run copied.
 */
export async function adoptStandardLibraryAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const slug = form.get("org");
  const ctx = typeof slug === "string" ? await getOrgContext(slug) : null;
  if (!ctx) notFound();
  const result = await adoptStandardLibrary(ctx.viewer.db, ctx.org.id);
  if (!result.ok) return failed(result.error);
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return { ok: true, result: { count: String(result.data.total) } };
}
