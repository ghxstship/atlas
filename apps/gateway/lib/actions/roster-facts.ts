"use server";

import type { Parsed } from "@xos/data/work-details-forms";
import {
  clearRosterProjectFact,
  getMyPreviousRosterFacts,
  getRosterProjectFacts,
  searchAirports,
  saveRosterTravelRequest,
  saveRosterUniformSizes,
  saveRosterVehicle,
  type Airport,
  type PreviousRosterFacts,
  type ProjectFactKind,
  type RosterProjectFacts,
} from "@xos/data/roster-facts";
import {
  parseRosterTravelForm,
  parseRosterUniformForm,
  parseRosterVehicleForm,
  rosterFactErrorKey,
} from "@xos/data/roster-facts-forms";
import type { Result } from "@xos/data/result";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getGatewayContext } from "@/lib/shell/context";

/**
 * Gateway server actions for project facts (R5, migrations 2654 and 2655): the person enters travel, uniform sizes and
 * a vehicle on their own roster entry, and a roster manager may enter them for the person when the producing org
 * allows it. The parsers are shared with Compass (@xos/data/roster-facts-forms); every write runs as the signed-in
 * person, so the RPCs decide standing and refuse with a named rule, which comes back as a `workDetails.errors.*` key.
 */

export interface RosterFactStepState {
  readonly ok?: boolean;
  /** A `workDetails.errors.*` key for a refusal. */
  readonly error?: string;
  /** Fields to fix, each with a `workDetails.errors.*` key. */
  readonly fieldErrors?: Readonly<Record<string, string>>;
}

async function db() {
  const ctx = await getGatewayContext();
  if (!ctx) redirect("/auth/sign-in");
  return ctx.db;
}

const entryId = z.uuid();
const kinds = z.enum(["Travel", "Uniform", "Vehicle"]);

function rejected(parsed: Extract<Parsed<unknown>, { ok: false }>): RosterFactStepState {
  return { fieldErrors: Object.fromEntries(parsed.fields.map((f) => [f, parsed.code])) };
}

function done(result: Result<unknown>): RosterFactStepState {
  if (!result.ok) return { error: rosterFactErrorKey(result.error) };
  revalidatePath("/work/engagements", "layout");
  revalidatePath("/home");
  return { ok: true };
}

async function save<T>(
  rosterEntryId: string,
  parsed: Parsed<T>,
  write: (client: Awaited<ReturnType<typeof db>>, id: string, value: T) => Promise<Result<unknown>>,
): Promise<RosterFactStepState> {
  if (!entryId.safeParse(rosterEntryId).success) return { error: "denied" };
  if (!parsed.ok) return rejected(parsed);
  return done(await write(await db(), rosterEntryId, parsed.value));
}

export async function saveRosterTravelAction(
  rosterEntryId: string,
  form: FormData,
): Promise<RosterFactStepState> {
  return save(rosterEntryId, parseRosterTravelForm(form), saveRosterTravelRequest);
}

export async function saveRosterUniformAction(
  rosterEntryId: string,
  form: FormData,
): Promise<RosterFactStepState> {
  return save(rosterEntryId, parseRosterUniformForm(form), saveRosterUniformSizes);
}

export async function saveRosterVehicleAction(
  rosterEntryId: string,
  form: FormData,
): Promise<RosterFactStepState> {
  return save(rosterEntryId, parseRosterVehicleForm(form), saveRosterVehicle);
}

export async function clearRosterFactAction(
  rosterEntryId: string,
  kind: ProjectFactKind,
): Promise<RosterFactStepState> {
  if (!entryId.safeParse(rosterEntryId).success || !kinds.safeParse(kind).success) {
    return { error: "denied" };
  }
  return done(await clearRosterProjectFact(await db(), rosterEntryId, kind));
}

/** Airports for the typed query: an exact code first, then names and cities; empty for a blank query. */
export async function searchAirportsAction(query: string): Promise<readonly Airport[]> {
  const q = String(query ?? "").slice(0, 80);
  const result = await searchAirports(await db(), q);
  return result.ok ? result.data : [];
}

/** The person's last values of a kind, as an unsaved pre-fill ('Use my last details'). */
export async function previousRosterFactsAction(
  kind: ProjectFactKind,
): Promise<PreviousRosterFacts | null> {
  if (!kinds.safeParse(kind).success) return null;
  const result = await getMyPreviousRosterFacts(await db(), kind);
  return result.ok ? result.data : null;
}

/**
 * The project facts of one entry as the caller reads them. A company reader's call is logged in the person's access
 * log, so the crew drawer calls this when it opens, never when the list loads.
 */
export async function viewRosterFactsAction(
  rosterEntryId: string,
): Promise<
  | { readonly ok: true; readonly facts: RosterProjectFacts }
  | { readonly ok: false; readonly error: string }
> {
  if (!entryId.safeParse(rosterEntryId).success) return { ok: false, error: "denied" };
  const result = await getRosterProjectFacts(await db(), rosterEntryId);
  return result.ok
    ? { ok: true, facts: result.data }
    : { ok: false, error: rosterFactErrorKey(result.error) };
}
