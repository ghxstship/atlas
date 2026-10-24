"use server";

import {
  CONTENT_SUBJECT_KINDS,
  decideContentReport,
  type ContentDecision,
  type ContentSubjectKind,
} from "@xos/data/content-safety";
import { actionContext, finish } from "@/lib/collection-kit/actions";
import {
  FieldErrors,
  requiredText,
  text,
  uuid,
  type ActionState,
} from "@/lib/collection-kit/forms";

/**
 * Reported content (owner decision 19): a moderator's decision with its statement of reasons. The database decides
 * who may decide (org.communication.write, never about one's own content) and what each decision does.
 */

/** The decision choices the form offers, each an action with the ground it fits. */
const CHOICES: Readonly<Record<string, Pick<ContentDecision, "action" | "ground">>> = {
  removeTerms: { action: "Removed", ground: "Terms Violation" },
  removeIllegal: { action: "Removed", ground: "Illegal Content" },
  noAction: { action: "No Action", ground: "No Violation" },
};

export async function decideContentReportAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  const kind = text(form, "kind");
  if (id === null || kind === null || !(CONTENT_SUBJECT_KINDS as readonly string[]).includes(kind))
    return { error: "notFound" };
  const errors = new FieldErrors();
  const choice = errors.need("decision", CHOICES[text(form, "decision") ?? ""]);
  const ruleReference = errors.need("ruleReference", requiredText(form, "ruleReference", 300));
  const facts = errors.need("facts", requiredText(form, "facts", 4000));
  const statement = errors.need("statement", requiredText(form, "statement", 4000));
  if (choice === null || ruleReference === null || facts === null || statement === null)
    return errors.state;
  return finish(
    await decideContentReport(
      ctx.viewer.db,
      ctx.org.id,
      { kind: kind as ContentSubjectKind, id },
      { ...choice, ruleReference, facts, statement },
    ),
    ctx,
    "people/moderation",
  );
}
