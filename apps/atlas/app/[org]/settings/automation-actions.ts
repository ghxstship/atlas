"use server";

import { listProjects } from "@xos/data/finance";
import {
  deleteAutomation,
  getAutomationDefinition,
  listAutomationEventTypes,
  listAutomationRuns,
  listAutomationRunSteps,
  listWebhookEndpointOptions,
  retryAutomationRun,
  sampleAutomationEvent,
  saveAutomation,
  setAutomationEnabled,
  type AutomationRunRow,
  type AutomationStepRow,
  type EventTypeOption,
  type WebhookEndpointOption,
} from "@xos/data/automations";
import type { DataError } from "@xos/data/result";
import { listPeopleRefs, listPhaseOptions } from "@xos/data/work";
import { AutomationDefinition } from "@xos/schemas/automations";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { getOrgContext } from "@/lib/shell/context";
import { getTranslate } from "@/lib/shell/translate";

/**
 * Settings, Automations actions (A91, migrations 1480 and 1481, ADR 0047). Every call reads and writes with the
 * viewer's client, so the RPCs decide: org.automations.write, the automations plan feature, and the fit of actions to
 * the trigger. Refusals come back translated from `settings.automations.errors.*`. The editor's options and the run
 * details load here on demand, never with the page.
 */

export interface ActionResult {
  readonly ok?: boolean;
  readonly error?: string;
  readonly id?: string;
}

export interface EditorOptions {
  readonly eventTypes: readonly EventTypeOption[];
  readonly people: readonly { readonly value: string; readonly label: string }[];
  readonly projects: readonly { readonly value: string; readonly label: string }[];
  readonly phases: readonly { readonly value: string; readonly label: string }[];
  readonly webhooks: readonly WebhookEndpointOption[];
}

export interface EditorAutomation {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly triggerEventType: string;
  readonly enabled: boolean;
  readonly updatedAt: string;
  readonly conditions: unknown;
  readonly actions: unknown;
}

export interface EditorData {
  readonly options: EditorOptions;
  readonly automation: EditorAutomation | null;
}

export interface EditorInput {
  readonly id: string | null;
  readonly name: string;
  readonly description: string;
  readonly triggerEventType: string;
  readonly conditions: unknown;
  readonly actions: unknown;
  readonly enabled: boolean;
  readonly expectedUpdatedAt: string | null;
}

const KNOWN_RULES = new Set([
  "automation_conditions_invalid",
  "automation_actions_invalid",
  "automation_action_needs_record",
  "automation_action_needs_commentable_subject",
  "automation_person_not_member",
  "automation_webhook_unknown",
  "automation_project_unknown",
  "automation_trigger_unknown",
  "automation_name_length",
  "automation_changed",
  "plan_feature_required",
  "automation_off",
  "automation_run_not_failed",
]);

async function errorText(error: DataError): Promise<string> {
  const t = await getTranslate();
  if (error.kind === "refusal" && KNOWN_RULES.has(error.rule)) {
    return t(`settings.automations.errors.${error.rule}`, { detail: error.message });
  }
  if (error.kind === "not-found") return t("settings.automations.errors.denied");
  return t("settings.automations.errors.unexpected");
}

async function contextFor(org: string) {
  const ctx = await getOrgContext(org);
  if (!ctx) notFound();
  return ctx;
}

function refresh(org: string) {
  revalidatePath(`/${org}/settings/automations`);
}

/** The editor's pickers and, for an existing automation, its definition. */
export async function loadAutomationEditorAction(
  org: string,
  automationId: string | null,
): Promise<EditorData | null> {
  const ctx = await contextFor(org);
  const db = ctx.viewer.db;
  const [eventTypes, people, projects, phases, webhooks, list, definition] = await Promise.all([
    listAutomationEventTypes(db),
    listPeopleRefs(db, ctx.org.id),
    listProjects(db, ctx.org.id),
    listPhaseOptions(db),
    listWebhookEndpointOptions(db, ctx.org.id),
    automationId
      ? db
          .from("automations")
          .select("id, name, description, trigger_event_type, enabled, updated_at")
          .eq("id", automationId)
          .is("deleted_at", null)
          .maybeSingle()
      : Promise.resolve(null),
    automationId ? getAutomationDefinition(db, automationId) : Promise.resolve(null),
  ]);
  if (!eventTypes.ok || !people.ok || !projects.ok || !phases.ok) return null;
  const row = list && !list.error ? list.data : null;
  if (automationId && (!row || !definition?.ok)) return null;
  return {
    options: {
      eventTypes: eventTypes.data,
      people: people.data.map((p) => ({ value: p.personId, label: p.name ?? p.personId })),
      projects: projects.data.map((p) => ({ value: p.id, label: `${p.key} ${p.name}` })),
      phases: phases.data.map((p) => ({ value: p.value, label: `${p.code} ${p.label}` })),
      // Webhook endpoints are readable with org.webhooks.manage; without it the list is empty.
      webhooks: webhooks.ok ? webhooks.data : [],
    },
    automation:
      row && definition?.ok
        ? {
            id: row.id,
            name: row.name,
            description: row.description,
            triggerEventType: row.trigger_event_type,
            enabled: row.enabled,
            updatedAt: row.updated_at,
            conditions: definition.data.conditions,
            actions: definition.data.actions,
          }
        : null,
  };
}

/** Saves the editor's automation through app.save_automation. */
export async function saveAutomationAction(org: string, input: EditorInput): Promise<ActionResult> {
  const ctx = await contextFor(org);
  const parsed = AutomationDefinition.safeParse({
    name: input.name.trim(),
    description: input.description.trim() === "" ? null : input.description.trim(),
    trigger_event_type: input.triggerEventType,
    conditions: input.conditions,
    actions: input.actions,
    enabled: input.enabled,
  });
  if (!parsed.success) {
    const t = await getTranslate();
    const issue = parsed.error.issues[0];
    return {
      error: t("settings.automations.errors.invalid", {
        detail: `${issue?.path.join(".") ?? ""} ${issue?.message ?? ""}`.trim(),
      }),
    };
  }
  const result = await saveAutomation(ctx.viewer.db, {
    orgId: ctx.org.id,
    id: input.id,
    name: parsed.data.name,
    description: parsed.data.description ?? null,
    triggerEventType: parsed.data.trigger_event_type,
    conditions: parsed.data.conditions,
    actions: parsed.data.actions,
    enabled: input.enabled,
    expectedUpdatedAt: input.expectedUpdatedAt,
  });
  if (!result.ok) return { error: await errorText(result.error) };
  refresh(org);
  return { ok: true, id: result.data };
}

/** Turns an automation on (the viewer becomes its owner) or off. */
export async function setAutomationEnabledAction(
  org: string,
  automationId: string,
  enabled: boolean,
): Promise<ActionResult> {
  const ctx = await contextFor(org);
  const result = await setAutomationEnabled(ctx.viewer.db, automationId, enabled);
  if (!result.ok) return { error: await errorText(result.error) };
  refresh(org);
  return { ok: true };
}

/** Deletes an automation; its run history stays. */
export async function deleteAutomationAction(
  org: string,
  automationId: string,
): Promise<ActionResult> {
  const ctx = await contextFor(org);
  const result = await deleteAutomation(ctx.viewer.db, automationId);
  if (!result.ok) return { error: await errorText(result.error) };
  refresh(org);
  return { ok: true };
}

/** The org's latest event of a type, to test conditions against. */
export async function sampleEventAction(org: string, eventType: string): Promise<unknown> {
  const ctx = await contextFor(org);
  const result = await sampleAutomationEvent(ctx.viewer.db, ctx.org.id, eventType);
  return result.ok ? result.data : null;
}

/** Runs of one automation (or one run), newest first, paged back by `before`. */
export async function automationRunsAction(
  org: string,
  automationId: string | null,
  before: string | null,
  runId: string | null = null,
): Promise<AutomationRunRow[] | null> {
  const ctx = await contextFor(org);
  const result = await listAutomationRuns(ctx.viewer.db, ctx.org.id, {
    automationId: automationId ?? undefined,
    runId: runId ?? undefined,
    before: before ?? undefined,
    limit: 20,
  });
  return result.ok ? result.data : null;
}

/** The steps of one run. */
export async function automationRunStepsAction(
  org: string,
  runId: string,
): Promise<AutomationStepRow[] | null> {
  const ctx = await contextFor(org);
  const result = await listAutomationRunSteps(ctx.viewer.db, runId);
  return result.ok ? result.data : null;
}

/** Queues a failed run again from its failed step. */
export async function retryAutomationRunAction(org: string, runId: string): Promise<ActionResult> {
  const ctx = await contextFor(org);
  const result = await retryAutomationRun(ctx.viewer.db, runId);
  if (!result.ok) return { error: await errorText(result.error) };
  refresh(org);
  return { ok: true };
}
