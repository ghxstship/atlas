"use server";

import { leaveOrganization } from "@xos/data";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getMyOrganizations, getViewer } from "@/lib/shell/context";

export interface LeaveState {
  readonly error?: "sole_owner" | "unexpected";
}

/** Leaves an org now (app.leave_organization, Section 4.8.1); access ends at once. */
export async function leaveOrganizationAction(_: LeaveState, form: FormData): Promise<LeaveState> {
  const viewer = await getViewer();
  if (!viewer) redirect("/auth/sign-in");
  const orgId = z.uuid().safeParse(form.get("orgId"));
  const orgs = await getMyOrganizations();
  const org = orgId.success ? orgs.find((o) => o.id === orgId.data) : undefined;
  if (!org) return { error: "unexpected" };
  const result = await leaveOrganization(viewer.db, org.id);
  if (!result.ok) {
    return {
      error:
        result.error.kind === "refusal" && result.error.rule === "sole_owner"
          ? "sole_owner"
          : "unexpected",
    };
  }
  const remaining = orgs.filter((o) => o.id !== org.id);
  redirect(remaining[0] ? `/${remaining[0].slug}/home` : "/auth/organization");
}
