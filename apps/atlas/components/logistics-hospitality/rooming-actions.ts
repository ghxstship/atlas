"use server";

import { getAllocation } from "@xos/data/allocations";
import { listAccommodationBlocks, listCurrencies } from "@xos/data/hospitality";
import { listRoomingList, type RoomingEntry } from "@xos/data/lodging";
import { notFound } from "next/navigation";
import { z } from "zod";
import type { AllocationRowProps } from "@/components/advancing/allocation-dialogs";
import { getOrgContext } from "@/lib/shell/context";

/**
 * The rooming list (B5, app.rooming_list), read only when asked for: every call logs one project_facts.viewed row per
 * person returned, so the page never reads it on its own. Returns the project's live blocks with it for Assign room.
 */
export interface RoomingRead {
  readonly entries: readonly RoomingEntry[];
  readonly blocks: readonly {
    id: string;
    key: string;
    title: string;
    checkInOn: string;
    checkOutOn: string;
  }[];
  /** Minor unit exponent of each currency, for the cost column. */
  readonly exponents: Readonly<Record<string, number>>;
}

export async function roomingListAction(
  org: string,
  projectId: string,
): Promise<RoomingRead | null> {
  const ctx = await getOrgContext(org);
  if (!ctx) notFound();
  if (!z.uuid().safeParse(projectId).success) return null;
  const [entries, blocks, currencies] = await Promise.all([
    listRoomingList(ctx.viewer.db, projectId),
    listAccommodationBlocks(ctx.viewer.db, { orgId: ctx.org.id, projectId }),
    listCurrencies(ctx.viewer.db),
  ]);
  if (!entries.ok) return null;
  return {
    entries: entries.data,
    blocks: blocks.ok
      ? blocks.data.map((b) => ({
          id: b.id,
          key: b.key,
          title: b.title,
          checkInOn: b.checkInOn,
          checkOutOn: b.checkOutOn,
        }))
      : [],
    exponents: currencies.ok
      ? Object.fromEntries(currencies.data.map((c) => [c.code, c.exponent]))
      : {},
  };
}

function localIn(iso: string | null, timeZone: string): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
    .format(new Date(iso))
    .replace(" ", "T");
}

/** What R7's Issue dialog needs about an Approved allocation, for Assign room and Add pickup (R5 correction 8). */
export async function issueRowAction(
  org: string,
  allocationId: string,
  labels: { item: string; holder: string },
): Promise<AllocationRowProps | null> {
  const ctx = await getOrgContext(org);
  if (!ctx) notFound();
  if (!z.uuid().safeParse(allocationId).success) return null;
  const a = await getAllocation(ctx.viewer.db, allocationId);
  if (!a.ok) return null;
  return {
    id: a.data.id,
    kind: a.data.kind,
    quantity: a.data.quantity,
    issued: a.data.issuedQuantity,
    item: a.data.itemName ?? labels.item,
    holder: labels.holder,
    window: "",
    offering: a.data.offering,
    rosterEntryId: a.data.rosterEntryId,
    engagementId: a.data.holderEngagementId,
    projectId: a.data.projectId,
    assetClassId: null,
    fromLocal: localIn(a.data.neededFrom, a.data.timeZone),
    toLocal: localIn(a.data.neededTo, a.data.timeZone),
    timeZone: a.data.timeZone,
  };
}
