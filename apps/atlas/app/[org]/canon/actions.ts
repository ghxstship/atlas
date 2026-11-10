"use server";

import {
  canonExtensionProblems,
  decideCanonExtension,
  proposeCanonExtension,
  updateCanonExtension,
  type CanonExtensionLevel,
  type CanonExtensionState,
} from "@xos/data/canon";
import { actionContext, finish } from "@/lib/collection-kit/actions";
import {
  FieldErrors,
  requiredText,
  text,
  uuid,
  type ActionState,
} from "@/lib/collection-kit/forms";
import * as enums from "@xos/data/enums";

/**
 * Canon extension actions (Section 7.2): an org proposes disciplines and categories in .50 to .99
 * (canon.extension.write); someone other than the proposer approves or rejects them through
 * app.decide_canon_extension. Nothing here writes canon.
 */

const MODULE = "canon";
const STATES: readonly CanonExtensionState[] = enums.canonExtensionState;
const EM_DASH = String.fromCharCode(0x2014);

function labelAndRationale(form: FormData, errors: FieldErrors) {
  const label = errors.need("label", requiredText(form, "label", 200));
  const rationale = errors.need("rationale", requiredText(form, "rationale", 1000));
  if (label?.includes(EM_DASH)) errors.add("label", "emDash");
  if (rationale?.includes(EM_DASH)) errors.add("rationale", "emDash");
  return { label: label ?? "", rationale: rationale ?? "" };
}

export async function proposeExtensionAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const errors = new FieldErrors();
  const level = text(form, "level") as CanonExtensionLevel | null;
  if (level !== "Discipline" && level !== "Category") errors.add("level", "required");
  const parentCode = errors.need("parentCode", text(form, "parentCode"));
  const proposedCode = errors.need("proposedCode", text(form, "proposedCode"));
  const rest = labelAndRationale(form, errors);
  if (level && parentCode && proposedCode) {
    for (const problem of canonExtensionProblems({ level, parentCode, proposedCode, ...rest })) {
      errors.add(problem === "parent" ? "parentCode" : "proposedCode", problem);
    }
  }
  if (errors.any || !level || !parentCode || !proposedCode) return errors.state;
  return finish(
    await proposeCanonExtension(ctx.viewer.db, ctx.org.id, {
      level,
      parentCode,
      proposedCode,
      ...rest,
    }),
    ctx,
    MODULE,
  );
}

export async function updateExtensionAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  const errors = new FieldErrors();
  const rest = labelAndRationale(form, errors);
  if (id === null) return { error: "notFound" };
  if (errors.any) return errors.state;
  return finish(await updateCanonExtension(ctx.viewer.db, id, rest), ctx, MODULE);
}

export async function decideExtensionAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  const expected = text(form, "expected") as CanonExtensionState | null;
  const next = text(form, "next") as CanonExtensionState | null;
  const reason = requiredText(form, "reason", 500);
  if (reason === null) return { fieldErrors: { reason: "required" } };
  if (!id || !expected || !next || !STATES.includes(expected) || !STATES.includes(next)) {
    return { error: "invalid" };
  }
  return finish(
    await decideCanonExtension(ctx.viewer.db, { id, expected, next, reason }),
    ctx,
    MODULE,
  );
}
