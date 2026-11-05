"use server";

import { ROLE_LENS_COOKIE, roleLensCookie } from "@xos/data/role-lens";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { env } from "@/lib/env";
import { getOrgContext } from "./context";

/**
 * Sets the role lens of the org switcher (A128, ADR 0107) for the browser session: an httpOnly cookie with no
 * expiry, naming the org and one role the person holds there. An empty role returns to All roles. A role the
 * person does not hold is ignored; the lens only narrows what the shell shows, so nothing here grants access.
 * A plain form action, so the switcher works before hydration and adds no JavaScript to the page.
 */
export async function setRoleLensAction(form: FormData): Promise<void> {
  const slug = String(form.get("org") ?? "");
  const role = String(form.get("role") ?? "");
  const ctx = slug === "" ? null : await getOrgContext(slug);
  if (!ctx) return;
  const store = await cookies();
  if (role === "") {
    store.delete(ROLE_LENS_COOKIE);
  } else {
    if (ctx.lens.roles.length < 2 || !ctx.lens.roles.some((r) => r.id === role)) return;
    store.set(ROLE_LENS_COOKIE, roleLensCookie(ctx.org.slug, role), {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: env().ATLAS_SITE_URL.startsWith("https:"),
    });
  }
  revalidatePath(`/${ctx.org.slug}`, "layout");
}
