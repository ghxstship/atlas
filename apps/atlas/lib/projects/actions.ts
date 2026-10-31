"use server";

import type { DataError } from "@xos/data";
import {
  addProjectMember,
  attestEvidence,
  createProject,
  createScopeNode,
  endProjectMember,
  listGateCriteria,
  passGate,
  removeScopeNode,
  setProjectArchived,
  transitionProduction,
  transitionProject,
  updateProject,
  updateScopeNode,
  withdrawEvidence,
  PROJECT_ROLE_ORDER,
  PROJECT_STATES,
  SCOPE_KINDS,
  type ProductionState,
} from "@xos/data/projects";
import { Constants } from "@xos/data/database.types";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { getProjectContextFor, type ProjectContext } from "./context";
import { getOrgContext } from "@/lib/shell/context";
import { customFieldsOf } from "@/lib/custom-fields/form";
import { withEcho } from "./echo";

/**
 * Server actions for Projects (Section 4.2). Each resolves the viewer's org or project context
 * again (404 when it is gone), validates input, and calls the repository. Row level security, the
 * 0301 and 0400 guards and the RPCs decide every write; their refusals come back as catalog keys
 * under `projects.errors`, with the values a message needs.
 */

export interface ActionState {
  /** The submitted text fields, returned on failure so the form can show them again. */
  readonly echo?: Readonly<Record<string, string>>;
  readonly ok?: boolean;
  /** A key under `projects.errors`. */
  readonly error?: string;
  readonly values?: Readonly<Record<string, string | number>>;
  /** Field name to a key under `projects.errors`. */
  readonly fieldErrors?: Readonly<Record<string, string>>;
}

const KNOWN_REFUSALS = new Set([
  "plan_limit_exceeded",
  "plan_limit_read_only",
  "project_currency_required",
  "time_zone_unknown",
  "gate_criteria_unmet",
  "gate_phase_conflict",
  "gate_already_passed",
  "project_canceled",
  "transition_reason_required",
  "project_transition_not_allowed",
  "project_state_conflict",
  "production_transition_not_allowed",
  "production_state_conflict",
  "scope_root_retained",
  "scope_node_has_children",
  "scope_node_parent_deleted",
  "scope_node_parent_project",
  "gate_evidence_reference",
  "gate_evidence_immutable",
  "sod_self_grant",
  "project_member_immutable",
]);

/** A repository error as action state; a refusal names its rule and the values its copy needs. */
function errorState(error: DataError): ActionState {
  switch (error.kind) {
    case "refusal": {
      if (error.rule === "gate_criteria_unmet") {
        const gate = /Gate (\d+)/.exec(error.message)?.[1] ?? "";
        const criteria = /missing: (.+?)\.?$/.exec(error.message)?.[1] ?? "";
        return { error: error.rule, values: { gate, criteria } };
      }
      return KNOWN_REFUSALS.has(error.rule)
        ? { error: error.rule }
        : { error: "refused", values: { rule: error.rule } };
    }
    case "conflict":
    case "invalid":
    case "not-found":
      return { error: error.kind };
    case "unexpected":
      return { error: "unexpected" };
  }
}

const text = (max: number) => z.string().trim().min(1).max(max);
const optional = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : v))
  .nullable();
const optionalDate = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : v))
  .pipe(z.iso.date().nullable());
const reason = text(500);

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

async function projectFor(form: FormData): Promise<ProjectContext> {
  const ctx = await getProjectContextFor({
    org: field(form, "org"),
    projectKey: field(form, "projectKey"),
  });
  if (!ctx) notFound();
  return ctx;
}

function refresh(ctx: ProjectContext) {
  revalidatePath(`/${ctx.org.org.slug}`, "layout");
}

// Projects -----------------------------------------------------------------------------------------

const projectFields = z
  .object({
    key: z
      .string()
      .trim()
      .transform((v) => v.toUpperCase())
      .pipe(z.string().regex(/^[A-Z]{2,5}$/)),
    name: text(200),
    timeZone: text(64),
    jurisdictionId: optional,
    regionCode: optional,
    tierCode: optional,
    venueId: optional.pipe(z.uuid().nullable()),
    startsOn: optionalDate,
    endsOn: optionalDate,
    currencyCode: optional.pipe(
      z
        .string()
        .regex(/^[A-Z]{3}$/)
        .nullable(),
    ),
    description: z
      .string()
      .trim()
      .max(20000)
      .transform((v) => (v === "" ? null : v)),
  })
  .refine((v) => v.startsOn === null || v.endsOn === null || v.endsOn >= v.startsOn, {
    path: ["endsOn"],
  });

const FIELD_ERRORS: Record<string, string> = {
  key: "keyFormat",
  name: "name",
  timeZone: "timeZone",
  endsOn: "dates",
  startsOn: "dates",
  venueId: "invalid",
  currencyCode: "currency",
  description: "description",
};

function parseProject(form: FormData) {
  return projectFields.safeParse({
    key: field(form, "key"),
    name: field(form, "name"),
    timeZone: field(form, "timeZone"),
    jurisdictionId: field(form, "jurisdictionId"),
    regionCode: field(form, "regionCode"),
    tierCode: field(form, "tierCode"),
    venueId: field(form, "venueId"),
    startsOn: field(form, "startsOn"),
    endsOn: field(form, "endsOn"),
    currencyCode: field(form, "currencyCode"),
    description: field(form, "description"),
  });
}

function fieldErrors(issues: readonly z.core.$ZodIssue[]): ActionState {
  const errors: Record<string, string> = {};
  for (const issue of issues) {
    const name = String(issue.path[0] ?? "");
    errors[name] = FIELD_ERRORS[name] ?? "invalid";
  }
  return { fieldErrors: errors };
}

async function createProjectActionImpl(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await getOrgContext(field(form, "org"));
  if (!ctx) notFound();
  const parsed = parseProject(form);
  if (!parsed.success) return fieldErrors(parsed.error.issues);
  const custom = await customFieldsOf(ctx, "app.projects", form);
  if (custom.fieldErrors) return { error: "invalid", fieldErrors: custom.fieldErrors };
  const result = await createProject(ctx.viewer.db, { orgId: ctx.org.id, ...parsed.data });
  if (!result.ok) return errorState(result.error);
  await custom.save(result.data.id);
  revalidatePath(`/${ctx.org.slug}`, "layout");
  redirect(`/${ctx.org.slug}/p/${parsed.data.key}/overview`);
}

async function updateProjectActionImpl(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await projectFor(form);
  const parsed = parseProject(form);
  if (!parsed.success) return fieldErrors(parsed.error.issues);
  const result = await updateProject(ctx.org.viewer.db, ctx.project.id, parsed.data);
  if (!result.ok) return errorState(result.error);
  refresh(ctx);
  if (parsed.data.key !== ctx.project.key) {
    redirect(`/${ctx.org.org.slug}/p/${parsed.data.key}/settings`);
  }
  return { ok: true };
}

async function archiveProjectActionImpl(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await projectFor(form);
  const result = await setProjectArchived(
    ctx.org.viewer.db,
    ctx.project.id,
    field(form, "archived") === "true",
  );
  if (!result.ok) return errorState(result.error);
  refresh(ctx);
  return { ok: true };
}

async function transitionActionImpl(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await projectFor(form);
  const why = reason.safeParse(field(form, "reason"));
  if (!why.success) return { fieldErrors: { reason: "reason" } };
  const lifecycle = field(form, "lifecycle");
  const next = field(form, "next");
  const db = ctx.org.viewer.db;
  let result;
  if (lifecycle === "project") {
    const state = z.enum(PROJECT_STATES).safeParse(next);
    if (!state.success) return { error: "project_transition_not_allowed" };
    result = await transitionProject(db, {
      projectId: ctx.project.id,
      expected: ctx.project.projectState,
      next: state.data,
      reason: why.data,
    });
  } else {
    const state = z.enum(Constants.app.Enums.production_state).safeParse(next);
    if (!state.success) return { error: "production_transition_not_allowed" };
    result = await transitionProduction(db, {
      projectId: ctx.project.id,
      expected: ctx.project.productionState,
      next: state.data as ProductionState,
      reason: why.data,
    });
  }
  if (!result.ok) return errorState(result.error);
  refresh(ctx);
  return { ok: true };
}

// Scope tree ---------------------------------------------------------------------------------------

async function createScopeNodeActionImpl(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await projectFor(form);
  const parsed = z
    .object({
      parentId: z.uuid(),
      kind: z.enum(SCOPE_KINDS).exclude(["Engagement Root"]),
      code: z
        .string()
        .trim()
        .transform((v) => v.toUpperCase())
        .pipe(z.string().regex(/^[A-Z0-9][A-Z0-9-]{0,31}$/)),
      name: text(200),
      venueId: optional.pipe(z.uuid().nullable()),
    })
    .safeParse({
      parentId: field(form, "parentId"),
      kind: field(form, "kind"),
      code: field(form, "code"),
      name: field(form, "name"),
      venueId: field(form, "venueId"),
    });
  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const name = String(issue.path[0] ?? "");
      errors[name] = name === "code" ? "scopeCode" : name === "name" ? "scopeName" : "invalid";
    }
    return { fieldErrors: errors };
  }
  const result = await createScopeNode(ctx.org.viewer.db, {
    projectId: ctx.project.id,
    ...parsed.data,
  });
  if (!result.ok) return errorState(result.error);
  refresh(ctx);
  return { ok: true };
}

async function updateScopeNodeActionImpl(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await projectFor(form);
  const parsed = z
    .object({ nodeId: z.uuid(), name: text(200), venueId: optional.pipe(z.uuid().nullable()) })
    .safeParse({
      nodeId: field(form, "nodeId"),
      name: field(form, "name"),
      venueId: field(form, "venueId"),
    });
  if (!parsed.success) return { fieldErrors: { name: "scopeName" } };
  const result = await updateScopeNode(ctx.org.viewer.db, parsed.data.nodeId, {
    name: parsed.data.name,
    venueId: parsed.data.venueId,
  });
  if (!result.ok) return errorState(result.error);
  refresh(ctx);
  return { ok: true };
}

async function removeScopeNodeActionImpl(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await projectFor(form);
  const id = z.uuid().safeParse(field(form, "nodeId"));
  if (!id.success) return { error: "not-found" };
  const result = await removeScopeNode(ctx.org.viewer.db, id.data);
  if (!result.ok) return errorState(result.error);
  refresh(ctx);
  return { ok: true };
}

// Gates ----------------------------------------------------------------------------------------------

/** Evidence names a document link or a record key (`gate_evidence_reference`). */
const EVIDENCE_URI = /^(https:\/\/\S{3,1990}|[A-Z]{2,5}-\d{1,9})$/;

async function attestEvidenceActionImpl(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await projectFor(form);
  const parsed = z
    .object({
      criterionId: z.string().regex(/^G\d\.[A-Z_]+$/),
      uri: z.string().trim().regex(EVIDENCE_URI),
      note: z.string().trim().max(2000),
      rank: z.coerce.number().int().min(0).max(4),
    })
    .safeParse({
      criterionId: field(form, "criterionId"),
      uri: field(form, "uri"),
      note: field(form, "note"),
      rank: field(form, "rank"),
    });
  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const name = String(issue.path[0] ?? "");
      errors[name] = name === "uri" ? "evidenceUri" : name === "note" ? "note" : "invalid";
    }
    return { fieldErrors: errors };
  }
  const result = await attestEvidence(ctx.org.viewer.db, {
    projectId: ctx.project.id,
    ...parsed.data,
  });
  if (!result.ok) return errorState(result.error);
  refresh(ctx);
  return { ok: true };
}

async function withdrawEvidenceActionImpl(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await projectFor(form);
  const id = z.uuid().safeParse(field(form, "evidenceId"));
  if (!id.success) return { error: "not-found" };
  const result = await withdrawEvidence(ctx.org.viewer.db, id.data);
  if (!result.ok) return errorState(result.error);
  refresh(ctx);
  return { ok: true };
}

async function passGateActionImpl(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await projectFor(form);
  const why = reason.safeParse(field(form, "reason"));
  if (!why.success) return { fieldErrors: { reason: "reason" } };
  const result = await passGate(ctx.org.viewer.db, {
    projectId: ctx.project.id,
    expectedPhase: field(form, "expectedPhase"),
    reason: why.data,
  });
  if (!result.ok) {
    const state = errorState(result.error);
    return state.error === "gate_criteria_unmet" ? await namedCriteria(ctx, state) : state;
  }
  refresh(ctx);
  return { ok: true };
}

/**
 * The refusal names each missing criterion by its plain sentence, the code after it (Section 11.10
 * item 2, A59-017): "Go or no-go decision recorded (G1.GONOGO)", never the code alone.
 */
async function namedCriteria(ctx: ProjectContext, state: ActionState): Promise<ActionState> {
  const codes = String(state.values?.["criteria"] ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  if (codes.length === 0) return state;
  const criteria = await listGateCriteria(ctx.org.viewer.db);
  const statement = new Map(criteria.ok ? criteria.data.map((c) => [c.id, c.statement]) : []);
  const named = codes.map((code) => {
    const sentence = statement.get(code);
    return sentence ? `${sentence.replace(/\.$/, "")} (${code})` : code;
  });
  return { ...state, values: { ...state.values, criteria: named.join("; ") } };
}

// Members ----------------------------------------------------------------------------------------------

async function addMemberActionImpl(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await projectFor(form);
  const parsed = z
    .object({ membershipId: z.uuid(), role: z.enum(PROJECT_ROLE_ORDER) })
    .safeParse({ membershipId: field(form, "membershipId"), role: field(form, "role") });
  if (!parsed.success) return { fieldErrors: { membershipId: "invalid" } };
  const result = await addProjectMember(ctx.org.viewer.db, {
    projectId: ctx.project.id,
    ...parsed.data,
  });
  if (!result.ok) return errorState(result.error);
  refresh(ctx);
  return { ok: true };
}

async function endMemberActionImpl(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await projectFor(form);
  const id = z.uuid().safeParse(field(form, "projectMemberId"));
  if (!id.success) return { error: "not-found" };
  const result = await endProjectMember(ctx.org.viewer.db, id.data);
  if (!result.ok) return errorState(result.error);
  refresh(ctx);
  return { ok: true };
}

// Exported actions: each echoes the submitted text back on failure, so a refused form keeps
// what the person typed (React resets uncontrolled fields after an action).

export async function createProjectAction(
  state: ActionState,
  form: FormData,
): Promise<ActionState> {
  return withEcho(form, await createProjectActionImpl(state, form));
}

export async function updateProjectAction(
  state: ActionState,
  form: FormData,
): Promise<ActionState> {
  return withEcho(form, await updateProjectActionImpl(state, form));
}

export async function archiveProjectAction(
  state: ActionState,
  form: FormData,
): Promise<ActionState> {
  return withEcho(form, await archiveProjectActionImpl(state, form));
}

export async function transitionAction(state: ActionState, form: FormData): Promise<ActionState> {
  return withEcho(form, await transitionActionImpl(state, form));
}

export async function createScopeNodeAction(
  state: ActionState,
  form: FormData,
): Promise<ActionState> {
  return withEcho(form, await createScopeNodeActionImpl(state, form));
}

export async function updateScopeNodeAction(
  state: ActionState,
  form: FormData,
): Promise<ActionState> {
  return withEcho(form, await updateScopeNodeActionImpl(state, form));
}

export async function removeScopeNodeAction(
  state: ActionState,
  form: FormData,
): Promise<ActionState> {
  return withEcho(form, await removeScopeNodeActionImpl(state, form));
}

export async function attestEvidenceAction(
  state: ActionState,
  form: FormData,
): Promise<ActionState> {
  return withEcho(form, await attestEvidenceActionImpl(state, form));
}

export async function withdrawEvidenceAction(
  state: ActionState,
  form: FormData,
): Promise<ActionState> {
  return withEcho(form, await withdrawEvidenceActionImpl(state, form));
}

export async function passGateAction(state: ActionState, form: FormData): Promise<ActionState> {
  return withEcho(form, await passGateActionImpl(state, form));
}

export async function addMemberAction(state: ActionState, form: FormData): Promise<ActionState> {
  return withEcho(form, await addMemberActionImpl(state, form));
}

export async function endMemberAction(state: ActionState, form: FormData): Promise<ActionState> {
  return withEcho(form, await endMemberActionImpl(state, form));
}
