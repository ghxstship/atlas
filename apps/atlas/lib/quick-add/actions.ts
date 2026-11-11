"use server";

import type { DataError } from "@xos/data";
import { listCategories } from "@xos/data/canon";
import { createShift, listCanonRoles, listCrewMembers } from "@xos/data/crew";
import { listScopeNodes, type ScopeNodeRef } from "@xos/data/finance";
import {
  createRecord,
  formatRecordKey,
  getProjectRef,
  getRecord,
  listPeopleRefs,
  listProjectRefs,
  listRecordKinds,
  type ProjectRef,
} from "@xos/data/work";
import { quickAddKey, type QuickAddResolution } from "@xos/ui/quick-add";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { toActionError } from "@/components/work/action-result";
import { getCanonLabels } from "@/lib/canon/labels";
import { getOrgContext, type OrgContext } from "@/lib/shell/context";
import { getTranslate } from "@/lib/shell/translate";
import { recordWhen, shiftWhen } from "./fields";
import { matchNamed, type Named } from "./match";

/**
 * Quick add (Section 11.7, ADR 0073): resolving the people, tags, kinds and scopes a line names, and
 * creating the record or shift it describes. Every list is read with the caller's own client, so row
 * level security limits it to what they may see: a person or scope they cannot read is never offered,
 * and its token stays in the title as text. The caller must also hold the capability that creates
 * what the line describes. The database still decides every write.
 */

/** A refusal or failure, named by a full catalog key, with the database's correction when it has one. */
export type QuickAddActionResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: { readonly key: string; readonly detail?: string } };

const CAPABILITY = { record: "work.record.write", shift: "crew.shift.write" } as const;

const id = z.uuid();
const target = z.enum(["record", "shift"]);
const where = z.object({
  /** The project a project tab is about. */
  projectId: id.nullable().optional(),
  /** The project of the page the Create menu opened on, by key. */
  projectKey: z
    .string()
    .regex(/^[A-Z]{2,5}$/)
    .nullable()
    .optional(),
});
const when = z.object({
  iso: z.iso.date(),
  time: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .optional(),
  endIso: z.iso.date().optional(),
  endTime: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .optional(),
});

async function context(org: string): Promise<OrgContext> {
  const ctx = await getOrgContext(org);
  if (!ctx) notFound();
  return ctx;
}

function refused<T>(key: string): QuickAddActionResult<T> {
  return { ok: false, error: { key } };
}

function failed<T>(error: DataError): QuickAddActionResult<T> {
  const { key, detail } = toActionError(error);
  return { ok: false, error: { key: `work.errors.${key}`, ...(detail ? { detail } : {}) } };
}

function must<T>(result: { ok: true; data: T } | { ok: false; error: unknown }, what: string): T {
  if (!result.ok) throw new Error(`Cannot read ${what}: ${JSON.stringify(result.error)}`);
  return result.data;
}

/** The project a page or the Create menu fixes, by id or key; null when none is fixed. */
async function pageProject(
  ctx: OrgContext,
  input: z.infer<typeof where>,
  projects: readonly ProjectRef[],
): Promise<ProjectRef | null> {
  if (input.projectId) return projects.find((p) => p.id === input.projectId) ?? null;
  if (input.projectKey) {
    const found = await getProjectRef(ctx.viewer.db, ctx.org.id, input.projectKey);
    return found.ok ? found.data : null;
  }
  return null;
}

/** Scope nodes the caller may read, in the page's project only when the page fixes one. */
async function scopes(
  ctx: OrgContext,
  project: ProjectRef | null,
  projects: readonly ProjectRef[],
): Promise<Named[]> {
  const nodes = must(await listScopeNodes(ctx.viewer.db, ctx.org.id), "scope nodes");
  const keys = new Map(projects.map((p) => [p.id, p.key]));
  return nodes
    .filter((n: ScopeNodeRef) => keys.has(n.projectId) && (!project || n.projectId === project.id))
    .map((n) => {
      const key = keys.get(n.projectId) ?? "";
      // An engagement root is the project itself: ~NWS names it as well as ~NWS-E01.
      const root = n.code === `${key}-E01`;
      return {
        id: n.id,
        label: n.name,
        detail: `${key} · ${n.code}`,
        codes: root ? [n.code, key] : [n.code],
        names: [n.name],
      };
    });
}

const resolveSchema = z.object({
  target,
  where,
  /** The kinds the page creates; every kind when absent. */
  kinds: z.array(z.string().min(1).max(40)).max(26).nullable().optional(),
  tokens: z
    .array(
      z.object({
        type: z.enum(["person", "tag", "kind", "scope"]),
        value: z.string().trim().min(1).max(120),
      }),
    )
    .max(8),
});

export type ResolveQuickAddInput = z.input<typeof resolveSchema>;

/**
 * Resolves the tokens of a line against what the caller may see, keyed by token. People are the org's
 * active members the caller can read (memberships for a shift, people for a record owner, `@me` the
 * caller); tags are canon categories for a record and canon roles for a shift; kinds are the page's
 * record kinds; scopes are the scope nodes of projects the caller can read.
 */
export async function resolveQuickAddAction(
  org: string,
  input: ResolveQuickAddInput,
): Promise<QuickAddActionResult<Record<string, QuickAddResolution>>> {
  const ctx = await context(org);
  const parsed = resolveSchema.safeParse(input);
  if (!parsed.success) return refused("work.errors.invalid");
  const { target: kind, tokens } = parsed.data;
  if (!ctx.capabilities.has(CAPABILITY[kind])) return refused("work.errors.quickAdd.capability");
  const db = ctx.viewer.db;
  const types = new Set(tokens.map((t) => t.type));
  const t = await getTranslate();
  const projects = must(await listProjectRefs(db, ctx.org.id), "projects");
  const project = await pageProject(ctx, parsed.data.where, projects);
  const me = ctx.viewer.person?.id ?? null;

  const lists: Partial<Record<"person" | "tag" | "kind" | "scope", Named[]>> = {};
  if (types.has("person")) {
    if (kind === "shift") {
      lists.person = must(await listCrewMembers(db, ctx.org.id), "members").map((m) => ({
        id: m.membershipId,
        label: m.name ?? t("work.values.unnamed"),
        names: m.name ? [m.name] : [],
        codes: m.membershipId === ctx.org.membershipId ? ["me", "yo"] : [],
      }));
    } else {
      lists.person = must(await listPeopleRefs(db, ctx.org.id), "people").map((p) => ({
        id: p.personId,
        label: p.name ?? t("work.values.unnamed"),
        names: p.name ? [p.name] : [],
        codes: p.personId === me ? ["me", "yo"] : [],
      }));
    }
  }
  if (types.has("tag")) {
    if (kind === "shift") {
      const [roles, titles] = await Promise.all([
        listCanonRoles(db),
        getCanonLabels(ctx, "jobTitle"),
      ]);
      lists.tag = must(roles, "roles").map((r) => {
        const title = titles.get(r.code) ?? r.title;
        return {
          id: r.code,
          label: title,
          detail: r.code,
          codes: [r.code],
          names: [title, r.title],
        };
      });
    } else {
      const [categories, names] = await Promise.all([
        listCategories(db),
        getCanonLabels(ctx, "category"),
      ]);
      lists.tag = must(categories, "categories").map((c) => {
        const name = names.get(c.urid) ?? c.name;
        return { id: c.urid, label: name, detail: c.urid, codes: [c.urid], names: [name, c.name] };
      });
    }
  }
  if (types.has("kind") && kind === "record") {
    const allowed = parsed.data.kinds ? new Set(parsed.data.kinds) : null;
    lists.kind = must(await listRecordKinds(db), "record kinds")
      .filter((k) => allowed === null || allowed.has(k.kind))
      .map((k) => ({
        id: k.kind,
        label: t(`work.kinds.${k.kind}`),
        codes: [k.kind],
        names: [t(`work.kinds.${k.kind}`)],
      }));
  }
  if (types.has("scope")) lists.scope = await scopes(ctx, project, projects);

  const answer: Record<string, QuickAddResolution> = {};
  for (const token of tokens) {
    const list = lists[token.type];
    answer[quickAddKey(token)] = list ? matchNamed(token.value, list) : { status: "unresolved" };
  }
  return { ok: true, data: answer };
}

/**
 * The project a line lands in: its scope node's, else the page's, else the caller's only project.
 * A scope in another project than the page's is refused rather than moved.
 */
async function landing(
  ctx: OrgContext,
  input: { readonly scopeNodeId?: string | null | undefined } & z.infer<typeof where>,
): Promise<QuickAddActionResult<{ project: ProjectRef; scopeNodeId: string | null }>> {
  const projects = must(await listProjectRefs(ctx.viewer.db, ctx.org.id), "projects");
  const fixed = await pageProject(ctx, input, projects);
  if (input.scopeNodeId) {
    const node = must(await listScopeNodes(ctx.viewer.db, ctx.org.id), "scope nodes").find(
      (n) => n.id === input.scopeNodeId,
    );
    const project = node ? projects.find((p) => p.id === node.projectId) : undefined;
    if (!node || !project) return refused("work.errors.quickAdd.scope");
    if (fixed && fixed.id !== project.id) return refused("work.errors.quickAdd.scopeProject");
    return { ok: true, data: { project, scopeNodeId: node.id } };
  }
  const only = projects.length === 1 ? projects[0] : undefined;
  const project = fixed ?? only;
  if (!project) return refused("work.errors.quickAdd.project");
  return { ok: true, data: { project, scopeNodeId: null } };
}

const recordSchema = where.extend({
  title: z.string().trim().max(200),
  kind: z.string().min(1).max(40).nullable(),
  /** The page's kind when the line names none. */
  defaultKind: z.string().min(1).max(40),
  kinds: z.array(z.string().min(1).max(40)).max(26).nullable().optional(),
  personId: id.nullable(),
  tagId: z
    .string()
    .regex(/^\d{4}\.\d{2}\.\d{2}$/)
    .nullable(),
  scopeNodeId: id.nullable(),
  when: when.nullable(),
});

export type QuickAddRecordInput = z.input<typeof recordSchema>;

/**
 * Creates the record a line describes, in Proposed: its title and kind, the owner (`@`), the canon
 * category (`#`, which also gives the XYZ tag), the scope node (`~`) and its project, and its date.
 * One date is when it is due, a range when it starts and ends, read in the project's zone.
 */
export async function quickAddRecordAction(
  org: string,
  input: QuickAddRecordInput,
): Promise<QuickAddActionResult<{ key: string }>> {
  const ctx = await context(org);
  const parsed = recordSchema.safeParse(input);
  if (!parsed.success) return refused("work.errors.invalid");
  if (!ctx.capabilities.has(CAPABILITY.record)) return refused("work.errors.quickAdd.capability");
  const p = parsed.data;
  if (p.title === "") return refused("work.errors.quickAdd.title");
  const db = ctx.viewer.db;
  const kindName = p.kind ?? p.defaultKind;
  const kinds = must(await listRecordKinds(db), "record kinds");
  const kind = kinds.find((k) => k.kind === kindName);
  if (!kind || (p.kinds && !p.kinds.includes(kind.kind))) {
    return refused("work.errors.quickAdd.kind");
  }
  if (p.personId) {
    const people = must(await listPeopleRefs(db, ctx.org.id), "people");
    if (!people.some((person) => person.personId === p.personId)) {
      return refused("work.errors.quickAdd.person");
    }
  }
  let xyz = kind.recordClass === "Time" ? "Z" : "Y";
  if (p.tagId) {
    const category = must(await listCategories(db), "categories").find((c) => c.urid === p.tagId);
    if (!category) return refused("work.errors.quickAdd.category");
    // A category with a schema family gives the record its tag (basis Category).
    if (category.xyz) xyz = category.xyz;
  }
  const lands = await landing(ctx, p);
  if (!lands.ok) return lands;
  const { project, scopeNodeId } = lands.data;
  const created = await createRecord(db, {
    orgId: ctx.org.id,
    projectId: project.id,
    kind: kind.kind,
    title: p.title,
    scopeNodeId,
    urid: p.tagId,
    xyz,
    ownerId: p.personId,
    ...recordWhen(p.when, project.timeZone),
  });
  if (!created.ok) return failed(created.error);
  const record = await getRecord(db, created.data.id);
  revalidatePath(`/${org}`, "layout");
  return {
    ok: true,
    data: { key: record.ok ? record.data.key : formatRecordKey(project.key, created.data.number) },
  };
}

const shiftSchema = where.extend({
  /** Words of the line that are not tokens; a shift has no title to put them in. */
  rest: z.string().trim().max(200),
  personId: id.nullable(),
  tagId: z.string().min(1).max(40).nullable(),
  scopeNodeId: id.nullable(),
  when: when.nullable(),
});

export type QuickAddShiftInput = z.input<typeof shiftSchema>;

/**
 * Plans the Draft shift a line describes: the role (`#`), the person (`@`, an open shift without
 * one), the scope node (`~`) and its project, and its call and end, read in the project's zone.
 */
export async function quickAddShiftAction(
  org: string,
  input: QuickAddShiftInput,
): Promise<QuickAddActionResult<{ id: string }>> {
  const ctx = await context(org);
  const parsed = shiftSchema.safeParse(input);
  if (!parsed.success) return refused("work.errors.invalid");
  if (!ctx.capabilities.has(CAPABILITY.shift)) return refused("work.errors.quickAdd.capability");
  const p = parsed.data;
  if (p.rest !== "") return refused("crew.shifts.quickAdd.errors.text");
  if (p.when === null) return refused("crew.shifts.quickAdd.errors.when");
  const db = ctx.viewer.db;
  if (p.personId) {
    const members = must(await listCrewMembers(db, ctx.org.id), "members");
    if (!members.some((m) => m.membershipId === p.personId)) {
      return refused("work.errors.quickAdd.person");
    }
  }
  if (p.tagId) {
    const roles = must(await listCanonRoles(db), "roles");
    if (!roles.some((r) => r.code === p.tagId)) return refused("crew.shifts.quickAdd.errors.role");
  }
  const lands = await landing(ctx, p);
  if (!lands.ok) return lands;
  const { project, scopeNodeId } = lands.data;
  const times = shiftWhen(p.when, project.timeZone);
  if (!times) return refused("crew.shifts.quickAdd.errors.when");
  const created = await createShift(db, {
    orgId: ctx.org.id,
    projectId: project.id,
    roleCode: p.tagId,
    membershipId: p.personId,
    scopeNodeId,
    timeZone: project.timeZone,
    ...times,
  });
  if (!created.ok) return failed(created.error);
  revalidatePath(`/${org}`, "layout");
  return { ok: true, data: { id: created.data.id } };
}
