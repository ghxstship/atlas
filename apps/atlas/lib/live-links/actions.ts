"use server";

import {
  createDisplayLink,
  createViewLink,
  isDisplayMode,
  listLiveLinks,
  liveLinkPath,
  MAX_LIVE_LINK_DAYS,
  regenerateLiveLink,
  revokeLiveLink,
  type LiveLink,
  type LiveLinkKind,
} from "@xos/data/live-links";
import { listProjectRefs, type ProjectRef } from "@xos/data/work";
import { z } from "zod";
import { env } from "@/lib/env";
import { getOrgContext } from "@/lib/shell/context";

/**
 * Live links from a saved view's menu and a running order's peek (P1, ADR 0130; migrations 2780 to
 * 2782), following lib/files/share-actions.ts. Each action runs as the signed-in person in the org
 * named by the slug; the database applies every rule (who may share, the collections and fields a
 * link shows, the expiry, the limit of 20, a read-only org), and the actions only report its
 * refusals by rule. A new link's address and code come back once.
 */

export type LiveLinkActionResult<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: string };

function refused(error: { kind: string; rule?: string }): { ok: false; error: string } {
  if (error.kind === "refusal" && error.rule) return { ok: false, error: error.rule };
  return { ok: false, error: error.kind === "not-found" ? "notFound" : "unexpected" };
}

/** The link's public address, on the Atlas origin. */
function linkUrl(kind: LiveLinkKind, token: string): string {
  return new URL(liveLinkPath(kind, token), env().ATLAS_SITE_URL).toString();
}

/**
 * The instant a link picked for a calendar day expires: the end of that day in UTC, kept inside the
 * 90 days the database allows, so the last day offered is never refused.
 */
export async function expiryFor(day: string, now: Date = new Date()): Promise<string> {
  const end = Date.parse(`${day}T23:59:59Z`);
  const ceiling = now.getTime() + MAX_LIVE_LINK_DAYS * 86_400_000 - 60_000;
  return new Date(Math.min(end, ceiling)).toISOString();
}

export interface CreatedLiveLinkView {
  readonly url: string;
  readonly accessCode: string;
  readonly expiresAt: string;
}

const id = z.uuid();

/** A saved view's live links, and the projects the dialog offers on an org page. */
export async function loadViewLinksAction(
  org: string,
  savedViewId: string,
): Promise<LiveLinkActionResult<{ links: readonly LiveLink[]; projects: readonly ProjectRef[] }>> {
  const ctx = await getOrgContext(org);
  const view = id.safeParse(savedViewId);
  if (!ctx || !view.success) return { ok: false, error: "notFound" };
  const [links, projects] = await Promise.all([
    listLiveLinks(ctx.viewer.db, { savedViewId: view.data }),
    listProjectRefs(ctx.viewer.db, ctx.org.id),
  ]);
  if (!links.ok) return refused(links.error);
  if (!projects.ok) return refused(projects.error);
  return { ok: true, data: { links: links.data, projects: projects.data } };
}

/** A running order's display screen links. */
export async function loadDisplayLinksAction(
  org: string,
  runOfShowId: string,
): Promise<LiveLinkActionResult<readonly LiveLink[]>> {
  const ctx = await getOrgContext(org);
  const run = id.safeParse(runOfShowId);
  if (!ctx || !run.success) return { ok: false, error: "notFound" };
  const links = await listLiveLinks(ctx.viewer.db, { runOfShowId: run.data });
  return links.ok ? { ok: true, data: links.data } : refused(links.error);
}

const viewSchema = z.object({
  savedViewId: z.uuid(),
  /** The project the link shows: the tab's on a project page, picked on an org page. */
  projectKey: z.string().trim().min(1).max(20),
  expiresOn: z.iso.date(),
  note: z.string().trim().max(200),
});

/** Makes a live link to a saved view and returns its address and code once. */
export async function createViewLinkAction(
  org: string,
  input: z.input<typeof viewSchema>,
): Promise<LiveLinkActionResult<CreatedLiveLinkView>> {
  const ctx = await getOrgContext(org);
  if (!ctx) return { ok: false, error: "notFound" };
  const parsed = viewSchema.safeParse(input);
  if (!parsed.success) {
    const field = String(parsed.error.issues[0]?.path[0] ?? "");
    return {
      ok: false,
      error: field === "projectKey" ? "projectRequired" : "live_link_expiry_range",
    };
  }
  const p = parsed.data;
  const projects = await listProjectRefs(ctx.viewer.db, ctx.org.id);
  if (!projects.ok) return refused(projects.error);
  const project = projects.data.find((x) => x.key === p.projectKey);
  if (!project) return { ok: false, error: "projectRequired" };
  const created = await createViewLink(ctx.viewer.db, {
    savedViewId: p.savedViewId,
    projectId: project.id,
    expiresAt: await expiryFor(p.expiresOn),
    note: p.note === "" ? null : p.note,
  });
  if (!created.ok) return refused(created.error);
  return {
    ok: true,
    data: {
      url: linkUrl("View", created.data.token),
      accessCode: created.data.accessCode,
      expiresAt: created.data.expiresAt,
    },
  };
}

const displaySchema = z.object({
  runOfShowId: z.uuid(),
  /** Empty for the default: the end of the day after the show, in the project's zone. */
  expiresOn: z.union([z.literal(""), z.iso.date()]),
  defaultMode: z.string().refine(isDisplayMode),
  note: z.string().trim().max(200),
});

/** Makes a display screen link to a running order and returns its address and code once. */
export async function createDisplayLinkAction(
  org: string,
  input: z.input<typeof displaySchema>,
): Promise<LiveLinkActionResult<CreatedLiveLinkView>> {
  const ctx = await getOrgContext(org);
  if (!ctx) return { ok: false, error: "notFound" };
  const parsed = displaySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "live_link_expiry_range" };
  const p = parsed.data;
  const created = await createDisplayLink(ctx.viewer.db, {
    runOfShowId: p.runOfShowId,
    expiresAt: p.expiresOn === "" ? null : await expiryFor(p.expiresOn),
    defaultMode: isDisplayMode(p.defaultMode) ? p.defaultMode : "Backstage",
    note: p.note === "" ? null : p.note,
  });
  if (!created.ok) return refused(created.error);
  return {
    ok: true,
    data: {
      url: linkUrl("Display", created.data.token),
      accessCode: created.data.accessCode,
      expiresAt: created.data.expiresAt,
    },
  };
}

/** A new address and code for a link; the old ones, and every device that opened it, stop at once. */
export async function regenerateLiveLinkAction(
  org: string,
  liveLinkId: string,
  kind: LiveLinkKind,
): Promise<LiveLinkActionResult<CreatedLiveLinkView>> {
  const ctx = await getOrgContext(org);
  const link = id.safeParse(liveLinkId);
  if (!ctx || !link.success || (kind !== "View" && kind !== "Display")) {
    return { ok: false, error: "notFound" };
  }
  const regenerated = await regenerateLiveLink(ctx.viewer.db, link.data);
  if (!regenerated.ok) return refused(regenerated.error);
  return {
    ok: true,
    data: {
      url: linkUrl(kind, regenerated.data.token),
      accessCode: regenerated.data.accessCode,
      expiresAt: regenerated.data.expiresAt,
    },
  };
}

/** Revokes a link. */
export async function revokeLiveLinkAction(
  org: string,
  liveLinkId: string,
): Promise<LiveLinkActionResult<string>> {
  const ctx = await getOrgContext(org);
  const link = id.safeParse(liveLinkId);
  if (!ctx || !link.success) return { ok: false, error: "notFound" };
  const revoked = await revokeLiveLink(ctx.viewer.db, link.data);
  return revoked.ok ? { ok: true, data: revoked.data } : refused(revoked.error);
}
