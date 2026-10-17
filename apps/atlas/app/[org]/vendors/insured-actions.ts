"use server";

import {
  addCertificateInsured,
  addRequiredInsured,
  removeCertificateInsured,
  removeRequiredInsured,
  ENDORSEMENT_KINDS,
  type EndorsementKind,
} from "@xos/data/insureds";
import { actionContext, finish } from "@/lib/collection-kit/actions";
import { FieldErrors, requiredText, uuid, type ActionState } from "@/lib/collection-kit/forms";

/**
 * Additional insureds (migration 1130, finding A38-001): the parties a certificate names
 * (vendors.coi.write) and the parties the org requires its vendors to name (vendors.coi.write).
 * Row level security decides every write.
 */

const MODULE = "vendors";

function endorsement(form: FormData, errors: FieldErrors): EndorsementKind | null {
  const value = form.get("endorsementKind");
  const kind = ENDORSEMENT_KINDS.find((k) => k === value) ?? null;
  return errors.need("endorsementKind", kind);
}

export async function addCertificateInsuredAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await actionContext(form);
  const errors = new FieldErrors();
  const certificateId = errors.need("certificateId", uuid(form, "certificateId"));
  const insuredName = errors.need("insuredName", requiredText(form, "insuredName", 200));
  const kind = endorsement(form, errors);
  if (certificateId === null || insuredName === null || kind === null) return errors.state;
  return finish(
    await addCertificateInsured(ctx.viewer.db, {
      certificateId,
      insuredName,
      endorsementKind: kind,
    }),
    ctx,
    MODULE,
  );
}

export async function removeCertificateInsuredAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  if (id === null) return { error: "notFound" };
  return finish(await removeCertificateInsured(ctx.viewer.db, id), ctx, MODULE);
}

export async function addRequiredInsuredAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await actionContext(form);
  const errors = new FieldErrors();
  const insuredName = errors.need("insuredName", requiredText(form, "insuredName", 200));
  const kind = endorsement(form, errors);
  const raw = form.get("projectId");
  const everyProject = raw === null || raw === "";
  const projectId = everyProject ? null : uuid(form, "projectId");
  if (!everyProject && projectId === null) errors.add("projectId", "required");
  if (insuredName === null || kind === null || (!everyProject && projectId === null)) {
    return errors.state;
  }
  return finish(
    await addRequiredInsured(ctx.viewer.db, {
      orgId: ctx.org.id,
      projectId,
      insuredName,
      endorsementKind: kind,
    }),
    ctx,
    MODULE,
  );
}

export async function removeRequiredInsuredAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  if (id === null) return { error: "notFound" };
  return finish(await removeRequiredInsured(ctx.viewer.db, id), ctx, MODULE);
}
