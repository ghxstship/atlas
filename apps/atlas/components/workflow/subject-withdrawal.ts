import { myModuleCapabilities } from "@xos/data/credentials";
import { getOperationsAccess } from "@xos/data/logistics";
import type { SubjectApproval } from "@xos/data/workflow";
import type { OrgContext } from "@/lib/shell/context";

/**
 * Who sees Withdraw on a subject approval in review, as app.cancel_subject_approval allows: its requester, a rule
 * writer (org.approval_policies.write, or projects.settings.write at organization reach) on every row, and the
 * subject's writer on the rows of projects where they issue or revoke passes, book dock slots or write advance
 * requests. A row whose requester is gone (C10) or whose step no one may decide (C11) is withdrawn by a rule writer.
 * It only shapes the control: the function decides, and a failed capability read hides Withdraw rather than the page.
 * The tabs still choose the rows, so a subject's writer meets Withdraw here on a row they decide or asked for, and on
 * any other row from the subject's own page.
 */
export async function subjectWithdrawal(
  ctx: OrgContext,
  subjects: readonly SubjectApproval[],
  personId: string,
): Promise<(s: SubjectApproval) => boolean> {
  const inReview = (s: SubjectApproval) => s.state === "In Review";
  if (
    ctx.capabilities.has("org.approval_policies.write") ||
    ctx.capabilities.has("projects.settings.write")
  ) {
    return inReview;
  }
  const others = subjects.filter((s) => inReview(s) && s.requestedBy !== personId);
  const moduleProjects = [
    ...new Set(
      others
        .filter((s) => s.credentialId !== null || s.advanceAllocationId !== null)
        .map((s) => s.projectId),
    ),
  ];
  const db = ctx.viewer.db;
  const [held, operations] = await Promise.all([
    Promise.all(moduleProjects.map(async (id) => [id, await myModuleCapabilities(db, id)] as const)),
    others.some((s) => s.dockSlotId !== null) ? getOperationsAccess(db, ctx.org.id) : null,
  ]);
  const passWriter = new Set(
    held
      .filter(
        ([, caps]) =>
          caps.ok &&
          (caps.data.has("credentials.credential.issue") ||
            caps.data.has("credentials.credential.revoke")),
      )
      .map(([id]) => id),
  );
  const allocationWriter = new Set(
    held.filter(([, caps]) => caps.ok && caps.data.has("advancing.packet.write")).map(([id]) => id),
  );
  return (s) =>
    inReview(s) &&
    (s.requestedBy === personId ||
      (s.credentialId !== null && passWriter.has(s.projectId)) ||
      (s.advanceAllocationId !== null && allocationWriter.has(s.projectId)) ||
      (s.dockSlotId !== null &&
        operations?.ok === true &&
        operations.data.can(s.projectId, "logistics.dock_slot.write")));
}
