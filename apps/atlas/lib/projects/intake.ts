"use server";

import type { DataError } from "@xos/data";
import { listEventTypes, type EventType } from "@xos/data/event-types";
import {
  commitProjectCopy,
  listCopySourceProjects,
  previewProjectCopy,
  PROJECT_COPY_PARTS,
  type CopySourceProject,
  type ProjectCopyItem,
  type ProjectCopyPart,
} from "@xos/data/project-copy";
import { listTemplates } from "@xos/data/workflow";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getProjectContextFor } from "./context";
import { getOrgContext } from "@/lib/shell/context";

/**
 * Server actions for the staged intake (B14, G-250, G-252) and for copying a past project into an existing one from
 * project Settings. The intake's options load when the New project drawer opens, never with the Projects page; the
 * copy preview runs before the project exists (no target) and again from Settings against the project. Row level
 * security and the RPCs decide every read and write; a refusal comes back as its rule, explained under
 * `projects.errors` (or `projects.copy.reasons` for skips).
 */

export interface IntakeTemplate {
  readonly id: string;
  readonly name: string;
  /** False while no version is published; such a template is never applied. */
  readonly published: boolean;
}

export interface IntakeOptions {
  readonly eventTypes: readonly EventType[];
  readonly templates: readonly IntakeTemplate[];
  readonly pastProjects: readonly CopySourceProject[];
}

const EMPTY: IntakeOptions = { eventTypes: [], templates: [], pastProjects: [] };

/** The org's live event types, templates and past projects for the wizard; empty lists on any read failure. */
export async function loadIntakeOptionsAction(org: string): Promise<IntakeOptions> {
  const ctx = await getOrgContext(org);
  if (!ctx) return EMPTY;
  const db = ctx.viewer.db;
  const [types, templates, projects] = await Promise.all([
    listEventTypes(db, ctx.org.id),
    listTemplates(db, ctx.org.id),
    listCopySourceProjects(db, ctx.org.id),
  ]);
  return {
    eventTypes: types.ok ? types.data : [],
    templates: templates.ok
      ? templates.data.map((t) => ({
          id: t.id,
          name: t.name,
          published: t.currentVersionId !== null,
        }))
      : [],
    pastProjects: projects.ok ? projects.data : [],
  };
}

export type CopyPreviewState =
  | { readonly ok: true; readonly items: readonly ProjectCopyItem[] }
  | {
      readonly ok: false;
      readonly error: string;
      readonly values?: Readonly<Record<string, string>>;
    };

function copyError(error: DataError): CopyPreviewState {
  if (error.kind === "refusal") return { ok: false, error: error.rule };
  if (error.kind === "not-found") return { ok: false, error: "copy_forbidden" };
  return { ok: false, error: error.kind };
}

const request = z.object({
  sourceProjectId: z.uuid(),
  parts: z.array(z.enum(PROJECT_COPY_PARTS as [ProjectCopyPart, ...ProjectCopyPart[]])).min(1),
  offsetDays: z.number().int().min(-3660).max(3660).nullable(),
});

/** The intake's Copy step: a preview against the project about to be created, at its venue and zone. */
export async function previewIntakeCopyAction(
  org: string,
  input: {
    readonly sourceProjectId: string;
    readonly parts: readonly string[];
    readonly offsetDays: number | null;
    readonly venueId: string | null;
    readonly timeZone: string | null;
  },
): Promise<CopyPreviewState> {
  const ctx = await getOrgContext(org);
  if (!ctx) return { ok: false, error: "not-found" };
  const parsed = request.safeParse(input);
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues[0]?.path[0] === "parts" ? "copy_nothing" : "invalid",
    };
  if (parsed.data.offsetDays === null) return { ok: false, error: "copy_offset_unknown" };
  const result = await previewProjectCopy(ctx.viewer.db, {
    ...parsed.data,
    targetProjectId: null,
    targetVenueId:
      input.venueId && z.uuid().safeParse(input.venueId).success ? input.venueId : null,
    targetTimeZone: input.timeZone,
  });
  return result.ok ? { ok: true, items: result.data } : copyError(result.error);
}

/** Settings, Copy from another project: the preview against this project, or with `commit` the copy itself. */
export async function copyIntoProjectAction(
  org: string,
  projectKey: string,
  input: {
    readonly sourceProjectId: string;
    readonly parts: readonly string[];
    readonly offsetDays: number | null;
  },
  commit: boolean,
): Promise<CopyPreviewState> {
  const ctx = await getProjectContextFor({ org, projectKey });
  if (!ctx) return { ok: false, error: "not-found" };
  const parsed = request.safeParse(input);
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues[0]?.path[0] === "parts" ? "copy_nothing" : "invalid",
    };
  const db = ctx.org.viewer.db;
  const body = { ...parsed.data, targetProjectId: ctx.project.id };
  const result = commit ? await commitProjectCopy(db, body) : await previewProjectCopy(db, body);
  if (!result.ok) return copyError(result.error);
  if (commit) revalidatePath(`/${ctx.org.org.slug}/p/${ctx.project.key}`, "layout");
  return { ok: true, items: result.data };
}

/** The projects setup can be copied from into this one (archived ones included), for the Settings dialog. */
export async function listCopySourcesAction(
  org: string,
  projectKey: string,
): Promise<readonly CopySourceProject[]> {
  const ctx = await getProjectContextFor({ org, projectKey });
  if (!ctx) return [];
  const result = await listCopySourceProjects(ctx.org.viewer.db, ctx.org.org.id, ctx.project.id);
  return result.ok ? result.data : [];
}
