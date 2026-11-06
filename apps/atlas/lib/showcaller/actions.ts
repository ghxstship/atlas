"use server";

import { CUE_CALL_KINDS } from "@xos/data/show";
import {
  SHOWCALLER_TOKEN,
  showcallerWrite,
  type ShowcallerRefusal,
  type ShowcallerWrite,
} from "@xos/data/showcaller-links";
import { cookies, headers } from "next/headers";
import { z } from "zod";
import { observability } from "@/lib/observability";
import { publicDb, SHOWCALLER_GRANT_COOKIE, visitorAddress } from "./public";

/**
 * The showcaller portal's writes (B3, ADR 0142): call, standby, nudge, move, add, edit, remove and department
 * calls, each one of the api_public.showcaller_* token RPCs through the session-less client. The token comes from
 * the portal's route and the device grant only from its HttpOnly cookie, never from the browser's arguments; Next's
 * Origin check refuses a server action posted from another site. The database checks the link, the grant, the
 * creator's access and that the cue is in the link's running order, and attributes the write to the link.
 */

export type PortalWriteResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: ShowcallerRefusal | "unexpected" };

const id = z.uuid();
const text = (max: number) => z.string().max(max);

const fields = z
  .object({
    label: z.string().trim().min(1).max(200).optional(),
    segment: text(200).nullable().optional(),
    description: text(2000).nullable().optional(),
    script: text(20_000).nullable().optional(),
    plannedAt: z.iso.datetime({ offset: true }).nullable().optional(),
    startTbc: z.boolean().optional(),
    durationSeconds: z.number().int().min(0).max(86_400).nullable().optional(),
  })
  .strict();

const write = z.discriminatedUnion("op", [
  z.object({ op: z.literal("call"), cueId: id }),
  z.object({ op: z.literal("standby"), cueId: id.nullable() }),
  z.object({ op: z.literal("shift"), seconds: z.number().int().min(-3600).max(3600) }),
  z.object({ op: z.literal("move"), cueId: id, toPosition: z.number().int().min(1).max(300) }),
  z.object({
    op: z.literal("save"),
    cueId: id.nullable(),
    fields,
    expectedUpdatedAt: z.string().max(64).nullable(),
  }),
  z.object({ op: z.literal("remove"), cueId: id }),
  z.object({
    op: z.literal("calls"),
    cueId: id,
    calls: z.partialRecord(z.enum(CUE_CALL_KINDS), text(2000).nullable()),
  }),
]);

export async function portalWriteAction(
  token: string,
  input: ShowcallerWrite,
): Promise<PortalWriteResult> {
  if (!SHOWCALLER_TOKEN.test(token)) return { ok: false, reason: "showcaller_link_invalid" };
  const parsed = write.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "showcaller_cue_field" };
  const grant = (await cookies()).get(SHOWCALLER_GRANT_COOKIE)?.value ?? "";
  const result = await showcallerWrite(publicDb(), {
    token,
    grant,
    clientAddress: visitorAddress(await headers()),
    write: parsed.data as ShowcallerWrite,
  });
  if (!result.ok) {
    observability.logger.error("showcaller portal write failed", {
      route: "/share/showcaller/[token]",
      operation: parsed.data.op,
      error: result.error,
    });
    return { ok: false, reason: "unexpected" };
  }
  return result.data.refused ? { ok: false, reason: result.data.reason } : { ok: true };
}
