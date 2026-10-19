"use server";

import { getMyOrganization } from "@xos/data";
import { startBreakGlass } from "@xos/data/access-controls";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getViewer } from "@/lib/shell/context";

/**
 * Emergency access from outside an org's allowed networks (Section 8.4, migrations 1201 and 1203):
 * an Owner the IP allow-list refused takes one hour of break-glass, which lets them past the list,
 * and lands on the org's Home. The database checks the Owner's capability, the second factor and
 * the reason, and notifies every other Owner and Admin.
 */

export interface EmergencyAccessState {
  readonly error?: string;
}

const schema = z.object({
  org: z.string().min(1).max(80),
  reason: z.string().min(20).max(2000),
});

export async function takeEmergencyAccessAction(
  _: EmergencyAccessState,
  form: FormData,
): Promise<EmergencyAccessState> {
  const parsed = schema.safeParse({
    org: form.get("org"),
    reason: typeof form.get("reason") === "string" ? String(form.get("reason")).trim() : "",
  });
  if (!parsed.success) return { error: "break_glass_reason" };
  const viewer = await getViewer();
  if (!viewer?.person) redirect("/auth/sign-in");
  const org = await getMyOrganization(viewer.db, viewer.person.id, parsed.data.org);
  if (!org.ok) return { error: "denied" };
  const started = await startBreakGlass(viewer.db, org.data.id, parsed.data.reason);
  if (!started.ok) {
    const error = started.error;
    if (error.kind === "refusal") {
      return {
        error: ["step_up_required", "break_glass_open", "break_glass_reason"].includes(error.rule)
          ? error.rule
          : "unexpected",
      };
    }
    return { error: error.kind === "not-found" ? "denied" : "unexpected" };
  }
  redirect(`/${org.data.slug}/home`);
}
