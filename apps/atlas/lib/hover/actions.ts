"use server";

import { getPersonCard, type PersonCard } from "@xos/data/person-card";
import { z } from "zod";
import { getOrgContext } from "@/lib/shell/context";

const input = z.object({ org: z.string().min(1).max(80), personId: z.uuid() });

/**
 * A person's hover card (Section 11.7), read as the viewer: row level security decides who shows.
 * Null when the person is not visible to the viewer or the org is gone.
 */
export async function personCardAction(org: string, personId: string): Promise<PersonCard | null> {
  const parsed = input.safeParse({ org, personId });
  if (!parsed.success) return null;
  const ctx = await getOrgContext(parsed.data.org);
  if (!ctx) return null;
  const card = await getPersonCard(ctx.viewer.db, ctx.org.id, parsed.data.personId);
  return card.ok ? card.data : null;
}
