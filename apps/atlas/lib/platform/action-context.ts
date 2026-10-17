import { notFound } from "next/navigation";
import { getOrgContext, type OrgContext } from "@/lib/shell/context";

/** The org context named by a form's `org` field, or 404. */
export async function contextFor(form: FormData): Promise<OrgContext> {
  const slug = form.get("org");
  const ctx = typeof slug === "string" ? await getOrgContext(slug) : null;
  if (!ctx) notFound();
  return ctx;
}
