"use server";

import { listMessages, sendMessage, type ChatMessage } from "@xos/data/workforce-chat";
import {
  getLibrarySegment,
  insertLibrarySegment,
  listLibrarySegments,
  listSegmentCopies,
  publishLibrarySegment,
  removeLibraryCue,
  removeLibrarySegment,
  saveLibraryCue,
  saveLibraryCueCalls,
  saveLibrarySegment,
  type LibrarySegment,
  type LibrarySegmentDetail,
  type PublishResult,
  type SegmentCopy,
} from "@xos/data/segment-library";
import { CUE_CALL_KINDS, isSegmentColor, setSegmentColor, type SegmentColor } from "@xos/data/show";
import {
  joinShowChannel,
  openShowChannel,
  showChannelStatus,
  unreadInConversation,
  type ShowChannelStatus,
} from "@xos/data/show-channel";
import {
  createShowcallerLink,
  listShowcallerLinks,
  regenerateShowcallerLink,
  revokeShowcallerLink,
  showcallerPath,
  signOutShowcallerDevices,
  type ShowcallerLink,
} from "@xos/data/showcaller-links";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { done, failed, invalid, type ActionResult } from "@/components/work/action-result";
import { env } from "@/lib/env";
import { showcallerExpiryFor } from "@/lib/showcaller/expiry";
import { getOrgContext } from "@/lib/shell/context";

/**
 * Run-of-show depth actions (B3, ADR 0142): segment colours, the segment library, the show channel and showcaller
 * links. Each runs as the signed-in person in the org named by the slug; the database applies every rule (who may,
 * placement, the 300-cue cap, Clients kept out of the channel, link limits and expiry) and the actions report its
 * refusals by rule under `work.errors`. A new showcaller link's address and code come back once.
 */

async function context(org: string) {
  const ctx = await getOrgContext(org);
  if (!ctx) notFound();
  return ctx;
}

function refresh(org: string) {
  revalidatePath(`/${org}`, "layout");
}

const id = z.uuid();
const instant = z.iso.datetime({ offset: true });
const color = z.enum(["cat-1", "cat-2", "cat-3", "cat-4", "cat-5", "cat-6", "cat-7"]).nullable();

// Segment colours ---------------------------------------------------------------------------------

export async function setSegmentColorAction(
  org: string,
  runId: string,
  segment: string,
  colorKey: string | null,
): Promise<ActionResult> {
  const ctx = await context(org);
  const parsed = z
    .object({ runId: id, segment: z.string().trim().min(1).max(200), colorKey: color })
    .safeParse({ runId, segment, colorKey });
  if (!parsed.success) return invalid();
  const result = await setSegmentColor(
    ctx.viewer.db,
    parsed.data.runId,
    parsed.data.segment,
    parsed.data.colorKey as SegmentColor | null,
  );
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

// The segment library -----------------------------------------------------------------------------

export async function listLibrarySegmentsAction(
  org: string,
): Promise<ActionResult<LibrarySegment[]>> {
  const ctx = await context(org);
  const result = await listLibrarySegments(ctx.viewer.db, ctx.org.id);
  return result.ok ? done(result.data) : failed(result.error);
}

export async function loadLibrarySegmentAction(
  org: string,
  segmentId: string,
): Promise<ActionResult<{ segment: LibrarySegmentDetail; copies: SegmentCopy[] }>> {
  const ctx = await context(org);
  if (!id.safeParse(segmentId).success) return invalid();
  const [segment, copies] = await Promise.all([
    getLibrarySegment(ctx.viewer.db, segmentId),
    listSegmentCopies(ctx.viewer.db, segmentId),
  ]);
  if (!segment.ok) return failed(segment.error);
  if (!copies.ok) return failed(copies.error);
  return done({ segment: segment.data, copies: copies.data });
}

export async function saveLibrarySegmentAction(
  org: string,
  input: { id?: string; name: string; description: string; colorKey: string | null },
): Promise<ActionResult<{ id: string }>> {
  const ctx = await context(org);
  const parsed = z
    .object({
      id: id.optional(),
      name: z.string().trim().min(1).max(200),
      description: z.string().max(2000),
      colorKey: color,
    })
    .safeParse(input);
  if (!parsed.success) return invalid("segmentName");
  const result = await saveLibrarySegment(ctx.viewer.db, {
    orgId: ctx.org.id,
    ...(parsed.data.id ? { id: parsed.data.id } : {}),
    name: parsed.data.name,
    description: parsed.data.description,
    colorKey: isSegmentColor(parsed.data.colorKey) ? parsed.data.colorKey : null,
  });
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(result.data);
}

export async function removeLibrarySegmentAction(
  org: string,
  segmentId: string,
): Promise<ActionResult> {
  const ctx = await context(org);
  if (!id.safeParse(segmentId).success) return invalid();
  const result = await removeLibrarySegment(ctx.viewer.db, segmentId);
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

export async function saveLibraryCueAction(
  org: string,
  input: {
    segmentId: string;
    id?: string;
    label: string;
    durationSeconds: number | null;
    description: string;
    script: string;
    calls: Partial<Record<string, string>>;
  },
): Promise<ActionResult<{ id: string }>> {
  const ctx = await context(org);
  const parsed = z
    .object({
      segmentId: id,
      id: id.optional(),
      label: z.string().trim().min(1).max(200),
      durationSeconds: z.number().int().min(0).max(86_400).nullable(),
      description: z.string().max(2000),
      script: z.string().max(20_000),
      calls: z.record(z.enum(CUE_CALL_KINDS), z.string().max(2000)),
    })
    .safeParse(input);
  if (!parsed.success) return invalid("cueLabel");
  const saved = await saveLibraryCue(ctx.viewer.db, {
    segmentId: parsed.data.segmentId,
    ...(parsed.data.id ? { id: parsed.data.id } : {}),
    label: parsed.data.label,
    durationSeconds: parsed.data.durationSeconds,
    description: parsed.data.description,
    script: parsed.data.script,
  });
  if (!saved.ok) return failed(saved.error);
  const calls = await saveLibraryCueCalls(ctx.viewer.db, saved.data.id, parsed.data.calls);
  if (!calls.ok) return failed(calls.error);
  refresh(org);
  return done(saved.data);
}

export async function removeLibraryCueAction(org: string, cueId: string): Promise<ActionResult> {
  const ctx = await context(org);
  if (!id.safeParse(cueId).success) return invalid();
  const result = await removeLibraryCue(ctx.viewer.db, cueId);
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(null);
}

export async function insertLibrarySegmentAction(
  org: string,
  input: {
    runId: string;
    segmentId: string;
    beforePosition: number | null;
    startsAt: string | null;
  },
): Promise<ActionResult<{ instanceId: string }>> {
  const ctx = await context(org);
  const parsed = z
    .object({
      runId: id,
      segmentId: id,
      beforePosition: z.number().int().min(1).max(301).nullable(),
      startsAt: instant.nullable(),
    })
    .safeParse(input);
  if (!parsed.success) return invalid();
  const result = await insertLibrarySegment(ctx.viewer.db, {
    runOfShowId: parsed.data.runId,
    segmentId: parsed.data.segmentId,
    beforePosition: parsed.data.beforePosition,
    startsAt: parsed.data.startsAt,
  });
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(result.data);
}

export async function publishLibrarySegmentAction(
  org: string,
  segmentId: string,
  runIds: readonly string[],
): Promise<ActionResult<PublishResult[]>> {
  const ctx = await context(org);
  const parsed = z
    .object({ segmentId: id, runIds: z.array(id).min(1).max(50) })
    .safeParse({ segmentId, runIds });
  if (!parsed.success) return invalid();
  const result = await publishLibrarySegment(
    ctx.viewer.db,
    parsed.data.segmentId,
    parsed.data.runIds,
  );
  if (!result.ok) return failed(result.error);
  refresh(org);
  return done(result.data);
}

// The show channel --------------------------------------------------------------------------------

export interface ShowChannelView {
  readonly status: ShowChannelStatus;
  readonly messages: readonly ChatMessage[];
  readonly unread: number;
}

/** The panel's state and, for a member, the channel's last 50 messages and unread count. */
export async function loadShowChannelAction(
  org: string,
  projectId: string,
): Promise<ActionResult<ShowChannelView>> {
  const ctx = await context(org);
  if (!id.safeParse(projectId).success) return invalid();
  const status = await showChannelStatus(ctx.viewer.db, projectId);
  if (!status.ok) return failed(status.error);
  const conversation = status.data.conversationId;
  if (!conversation) return done({ status: status.data, messages: [], unread: 0 });
  const [messages, unread] = await Promise.all([
    listMessages(ctx.viewer.db, conversation, 50),
    unreadInConversation(ctx.viewer.db, ctx.org.id, conversation),
  ]);
  if (!messages.ok) return failed(messages.error);
  return done({
    status: status.data,
    messages: messages.data,
    unread: unread.ok ? unread.data : 0,
  });
}

export async function openShowChannelAction(
  org: string,
  projectId: string,
): Promise<ActionResult<{ conversationId: string }>> {
  const ctx = await context(org);
  if (!id.safeParse(projectId).success) return invalid();
  const result = await openShowChannel(ctx.viewer.db, projectId);
  return result.ok ? done(result.data) : failed(result.error);
}

export async function joinShowChannelAction(
  org: string,
  projectId: string,
): Promise<ActionResult<{ conversationId: string }>> {
  const ctx = await context(org);
  if (!id.safeParse(projectId).success) return invalid();
  const result = await joinShowChannel(ctx.viewer.db, projectId);
  return result.ok ? done(result.data) : failed(result.error);
}

export async function sendShowChannelMessageAction(
  org: string,
  conversationId: string,
  body: string,
): Promise<ActionResult<{ id: string }>> {
  const ctx = await context(org);
  const parsed = z
    .object({ conversationId: id, body: z.string().trim().min(1).max(4000) })
    .safeParse({ conversationId, body });
  if (!parsed.success) return invalid("messageBody");
  const result = await sendMessage(ctx.viewer.db, parsed.data.conversationId, {
    body: parsed.data.body,
  });
  return result.ok ? done(result.data) : failed(result.error);
}

// Showcaller links --------------------------------------------------------------------------------

/** A new link's address and code, shown once. */
export interface CreatedShowcallerLinkView {
  readonly url: string;
  readonly accessCode: string;
  readonly expiresAt: string;
}

function portalUrl(token: string): string {
  return new URL(showcallerPath(token), env().ATLAS_SITE_URL).toString();
}

export async function loadShowcallerLinksAction(
  org: string,
  runId: string,
): Promise<ActionResult<ShowcallerLink[]>> {
  const ctx = await context(org);
  if (!id.safeParse(runId).success) return invalid();
  const result = await listShowcallerLinks(ctx.viewer.db, runId);
  return result.ok ? done(result.data) : failed(result.error);
}

export async function createShowcallerLinkAction(
  org: string,
  input: { runId: string; callerName: string; expiresOn: string; note: string },
): Promise<ActionResult<CreatedShowcallerLinkView>> {
  const ctx = await context(org);
  const parsed = z
    .object({
      runId: id,
      callerName: z.string().trim().min(1).max(120),
      expiresOn: z.union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]),
      note: z.string().trim().max(200),
    })
    .safeParse(input);
  if (!parsed.success) return invalid("callerName");
  const result = await createShowcallerLink(ctx.viewer.db, {
    runOfShowId: parsed.data.runId,
    callerName: parsed.data.callerName,
    expiresAt: parsed.data.expiresOn === "" ? null : showcallerExpiryFor(parsed.data.expiresOn),
    note: parsed.data.note === "" ? null : parsed.data.note,
  });
  if (!result.ok) return failed(result.error);
  return done({
    url: portalUrl(result.data.token),
    accessCode: result.data.accessCode,
    expiresAt: result.data.expiresAt,
  });
}

export async function regenerateShowcallerLinkAction(
  org: string,
  linkId: string,
): Promise<ActionResult<CreatedShowcallerLinkView>> {
  const ctx = await context(org);
  if (!id.safeParse(linkId).success) return invalid();
  const result = await regenerateShowcallerLink(ctx.viewer.db, linkId);
  if (!result.ok) return failed(result.error);
  return done({
    url: portalUrl(result.data.token),
    accessCode: result.data.accessCode,
    expiresAt: result.data.expiresAt,
  });
}

export async function revokeShowcallerLinkAction(
  org: string,
  linkId: string,
): Promise<ActionResult> {
  const ctx = await context(org);
  if (!id.safeParse(linkId).success) return invalid();
  const result = await revokeShowcallerLink(ctx.viewer.db, linkId);
  return result.ok ? done(null) : failed(result.error);
}

export async function signOutShowcallerDevicesAction(
  org: string,
  linkId: string,
): Promise<ActionResult<number>> {
  const ctx = await context(org);
  if (!id.safeParse(linkId).success) return invalid();
  const result = await signOutShowcallerDevices(ctx.viewer.db, linkId);
  return result.ok ? done(result.data) : failed(result.error);
}
