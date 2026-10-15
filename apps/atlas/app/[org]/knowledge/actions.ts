"use server";

import {
  acknowledgeSop,
  addDocumentVersion,
  createDocument,
  createSop,
  createVerbiageTerm,
  deleteDocument,
  deleteSop,
  deleteVerbiageTerm,
  publishSop,
  renameDocument,
  updateSop,
  updateVerbiageTerm,
  verbiageProblems,
} from "@xos/data/knowledge";
import { actionContext, finish } from "@/lib/collection-kit/actions";
import {
  FieldErrors,
  requiredText,
  text,
  uuid,
  type ActionState,
} from "@/lib/collection-kit/forms";

/**
 * Knowledge actions (Section 4.2 Knowledge). Row level security and the 0353 guards decide every
 * write: knowledge.sop.write to draft and edit, knowledge.sop.publish to publish (which raises the
 * version and asks everyone to acknowledge again), acknowledgments only for oneself,
 * knowledge.document.write for documents and their append-only versions, knowledge.verbiage.write
 * for the controlled vocabulary, which refuses em dashes (invariant 24).
 */

const MODULE = "knowledge";
const SHA256 = /^[0-9a-f]{64}$/;

// SOPs -----------------------------------------------------------------------------------------------

export async function createSopAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const errors = new FieldErrors();
  const code = text(form, "code")?.toUpperCase() ?? null;
  if (code === null || !/^SOP-[0-9]{3,5}$/.test(code)) errors.add("code", "sopCode");
  const title = errors.need("title", requiredText(form, "title", 200));
  const body = errors.need("body", requiredText(form, "body", 100_000));
  if (errors.any || !code || !title || !body) return errors.state;
  return finish(await createSop(ctx.viewer.db, ctx.org.id, { code, title, body }), ctx, MODULE);
}

export async function updateSopAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  const errors = new FieldErrors();
  const title = errors.need("title", requiredText(form, "title", 200));
  const body = errors.need("body", requiredText(form, "body", 100_000));
  const expectedUpdatedAt = text(form, "expectedUpdatedAt");
  if (id === null || expectedUpdatedAt === null) return { error: "notFound" };
  if (errors.any || !title || !body) return errors.state;
  return finish(
    await updateSop(ctx.viewer.db, id, { title, body, expectedUpdatedAt }),
    ctx,
    MODULE,
  );
}

export async function publishSopAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  if (id === null) return { error: "notFound" };
  return finish(await publishSop(ctx.viewer.db, id), ctx, MODULE);
}

export async function acknowledgeSopAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  const person = ctx.viewer.person?.id;
  if (id === null || !person) return { error: "notFound" };
  return finish(await acknowledgeSop(ctx.viewer.db, id, person), ctx, MODULE);
}

export async function deleteSopAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  if (id === null) return { error: "notFound" };
  return finish(await deleteSop(ctx.viewer.db, id), ctx, MODULE);
}

// Documents ------------------------------------------------------------------------------------------------

function versionInput(form: FormData, errors: FieldErrors) {
  const storageUri = errors.need("storageUri", requiredText(form, "storageUri", 2000));
  const checksum = text(form, "checksum")?.toLowerCase() ?? null;
  if (checksum === null || !SHA256.test(checksum)) errors.add("checksum", "checksum");
  return { storageUri: storageUri ?? "", checksumSha256: checksum ?? "" };
}

export async function createDocumentAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const errors = new FieldErrors();
  const title = errors.need("title", requiredText(form, "title", 200));
  const version = versionInput(form, errors);
  if (errors.any || !title) return errors.state;
  return finish(
    await createDocument(ctx.viewer.db, ctx.org.id, {
      title,
      projectId: uuid(form, "projectId"),
      ...version,
    }),
    ctx,
    MODULE,
  );
}

export async function addVersionAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "documentId");
  const errors = new FieldErrors();
  const version = versionInput(form, errors);
  if (id === null) return { error: "notFound" };
  if (errors.any) return errors.state;
  return finish(await addDocumentVersion(ctx.viewer.db, id, version), ctx, MODULE);
}

export async function renameDocumentAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  const title = requiredText(form, "title", 200);
  if (id === null) return { error: "notFound" };
  if (title === null) return { fieldErrors: { title: "required" } };
  return finish(await renameDocument(ctx.viewer.db, id, title), ctx, MODULE);
}

export async function deleteDocumentAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  if (id === null) return { error: "notFound" };
  return finish(await deleteDocument(ctx.viewer.db, id), ctx, MODULE);
}

// Verbiage -------------------------------------------------------------------------------------------------

function verbiageInput(form: FormData, errors: FieldErrors) {
  const input = {
    term: text(form, "term") ?? "",
    casingRule: text(form, "casingRule") ?? "",
    definition: text(form, "definition") ?? "",
  };
  if (input.casingRule === "") errors.add("casingRule", "required");
  if (input.definition === "") errors.add("definition", "required");
  for (const problem of verbiageProblems(input)) {
    if (problem === "term_length") errors.add("term", "required");
    if (problem === "definition_sentence") errors.add("definition", "definitionSentence");
    if (problem === "em_dash") {
      for (const field of ["term", "casingRule", "definition"] as const) {
        if (input[field].includes(String.fromCharCode(0x2014))) errors.add(field, "emDash");
      }
    }
  }
  return input;
}

export async function createTermAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const errors = new FieldErrors();
  const input = verbiageInput(form, errors);
  if (errors.any) return errors.state;
  return finish(await createVerbiageTerm(ctx.viewer.db, ctx.org.id, input), ctx, MODULE);
}

export async function updateTermAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  const errors = new FieldErrors();
  const input = verbiageInput(form, errors);
  if (id === null) return { error: "notFound" };
  if (errors.any) return errors.state;
  return finish(await updateVerbiageTerm(ctx.viewer.db, id, input), ctx, MODULE);
}

export async function deleteTermAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  if (id === null) return { error: "notFound" };
  return finish(await deleteVerbiageTerm(ctx.viewer.db, id), ctx, MODULE);
}
