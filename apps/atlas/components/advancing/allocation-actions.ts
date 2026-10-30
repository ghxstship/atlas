"use server";

import type { DataError } from "@xos/data";
import {
  assignAllocation,
  decideAllocation,
  getAssetClassAvailability,
  issueAllocation,
  listAllocationAllowances,
  listAllocationHolders,
  listProjectRadioChannels,
  releaseReservation,
  requestAllocation,
  setAllocationRadioChannels,
  splitAllocation,
  unsplitAllocation,
  withdrawAllocation,
  type AllocationAllowance,
  type AllocationHolder,
  type AllocationInput,
  type AssetClassAvailability,
  type IssueItem,
  type ProjectRadioChannel,
  type ReservationSource,
} from "@xos/data/allocations";
import { instantOfLocalIn } from "@xos/data/calendar";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getOrgContext } from "@/lib/shell/context";
import type { AdvancingState } from "./actions";
import { KNOWN_ERRORS } from "./errors";

/**
 * Advance allocations in Atlas (R7, migrations 2690 to 2697). Each action resolves the viewer's org context again
 * (404 when it is gone), validates the form with Zod and calls @xos/data/allocations; the RPCs decide every write and
 * their refusals come back as catalog keys under `advancing.errors`. The dialog loaders read what a dialog offers
 * when it opens, so the page carries none of it: holders and items, the project's radio channels with each role's
 * default, a class's availability for the dates being typed, an engagement's remaining allowances, and the person's
 * vehicles through R5's logged read.
 */

function errorKey(error: DataError): string {
  if (error.kind === "refusal") return KNOWN_ERRORS.has(error.rule) ? error.rule : "refused";
  return error.kind;
}

async function contextFor(org: unknown) {
  const ctx = typeof org === "string" ? await getOrgContext(org) : null;
  if (!ctx) notFound();
  return ctx;
}

const SourceRow = z.object({
  source: z.enum(["Class Stock", "Unit", "Lot", "Order Line"]),
  quantity: z.coerce.number().positive(),
  id: z.string().trim().max(64),
});

/** The sources editor's rows (JSON in one hidden field), or null for the default. */
function parseSources(raw: FormDataEntryValue | null): ReservationSource[] | null | "invalid" {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  let rows: unknown;
  try {
    rows = JSON.parse(raw);
  } catch {
    return "invalid";
  }
  const parsed = z.array(SourceRow).safeParse(rows);
  if (!parsed.success) return "invalid";
  if (parsed.data.length === 0) return null;
  return parsed.data.map((s) => {
    switch (s.source) {
      case "Unit":
        return { source: "Unit", quantity: 1, assetUnitId: s.id };
      case "Lot":
        return { source: "Lot", quantity: s.quantity, assetLotId: s.id };
      case "Order Line":
        return { source: "Order Line", quantity: s.quantity, poLineId: s.id };
      default:
        return { source: "Class Stock", quantity: s.quantity };
    }
  });
}

const channelIds = (form: FormData) =>
  form
    .getAll("channel")
    .filter((v): v is string => typeof v === "string" && v !== "")
    .slice(0, 17);

// Assign or request ------------------------------------------------------------------------------------------------

const AssignForm = z.object({
  intent: z.enum(["assign", "request"]),
  projectId: z.uuid(),
  holder: z.string().regex(/^(pool|entry):[0-9a-f-]{36}$/),
  target: z.string().regex(/^(credential|asset|catering|lodging|service):.+$/),
  quantity: z.coerce.number().positive(),
  from: z.string().trim().min(1),
  to: z.string().trim().min(1),
  timeZone: z.string().trim().min(1).max(64),
  note: z.string().trim().max(1000),
});

export async function assignAllocationAction(
  _: AdvancingState,
  form: FormData,
): Promise<AdvancingState> {
  const ctx = await contextFor(form.get("org"));
  const parsed = AssignForm.safeParse({
    intent: form.get("intent"),
    projectId: form.get("projectId"),
    holder: form.get("holder"),
    target: form.get("target"),
    quantity: form.get("quantity"),
    from: form.get("from"),
    to: form.get("to"),
    timeZone: form.get("timeZone"),
    note: form.get("note") ?? "",
  });
  if (!parsed.success) return { error: "invalid" };
  const d = parsed.data;
  const neededFrom = instantOfLocalIn(d.from, d.timeZone);
  const neededTo = instantOfLocalIn(d.to, d.timeZone);
  if (!neededFrom) return { fieldErrors: { from: "required" } };
  if (!neededTo) return { fieldErrors: { to: "required" } };
  const [holderKind, holderId] = d.holder.split(":") as ["pool" | "entry", string];
  const [targetKind, targetId] = d.target.split(/:(.*)/s) as [string, string];
  const target: AllocationInput["target"] =
    targetKind === "credential"
      ? { kind: "credential", credentialCategoryId: targetId }
      : targetKind === "asset"
        ? { kind: "asset", assetClassId: targetId }
        : targetKind === "catering"
          ? { kind: "catering", fulfillmentId: targetId }
          : targetKind === "lodging"
            ? { kind: "lodging", accommodationBlockId: targetId }
            : { kind: "service", serviceKind: targetId === "Per Diem" ? "Per Diem" : "Travel" };
  const sources = parseSources(form.get("sources"));
  if (sources === "invalid") return { error: "allocation_sources_invalid" };
  // Channels are set once the allocation exists, so the count rule (2697) is checked first: a refusal after the
  // allocation is created would leave it without channels.
  const channels = target.kind === "asset" ? channelIds(form) : [];
  if (channels.length > 16) return { error: "allocation_channel_count" };
  const input: AllocationInput = {
    projectId: d.projectId,
    holder: holderKind === "pool" ? { engagementId: holderId } : { rosterEntryId: holderId },
    target,
    quantity: d.quantity,
    neededFrom,
    neededTo,
    timeZone: d.timeZone,
    note: d.note === "" ? null : d.note,
  };
  const result =
    d.intent === "request"
      ? await requestAllocation(ctx.viewer.db, input)
      : await assignAllocation(ctx.viewer.db, { ...input, sources });
  if (!result.ok) return { error: errorKey(result.error) };
  if (channels.length > 0) {
    const set = await setAllocationRadioChannels(ctx.viewer.db, result.data, channels);
    if (!set.ok) {
      revalidatePath(`/${ctx.org.slug}`, "layout");
      return { error: errorKey(set.error), id: result.data };
    }
  }
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return { ok: true, id: result.data };
}

// Review -----------------------------------------------------------------------------------------------------------

export async function decideAllocationAction(
  _: AdvancingState,
  form: FormData,
): Promise<AdvancingState> {
  const ctx = await contextFor(form.get("org"));
  const parsed = z
    .object({
      id: z.uuid(),
      decision: z.enum(["Approved", "Rejected"]),
      reason: z.string().trim().max(1000),
    })
    .safeParse({
      id: form.get("id"),
      decision: form.get("decision"),
      reason: form.get("reason") ?? "",
    });
  if (!parsed.success) return { error: "invalid" };
  if (parsed.data.decision === "Rejected" && parsed.data.reason === "") {
    return { fieldErrors: { reason: "required" } };
  }
  const sources = parseSources(form.get("sources"));
  if (sources === "invalid") return { error: "allocation_sources_invalid" };
  const result = await decideAllocation(ctx.viewer.db, {
    allocationId: parsed.data.id,
    decision: parsed.data.decision,
    reason: parsed.data.reason === "" ? null : parsed.data.reason,
    sources,
  });
  if (!result.ok) return { error: errorKey(result.error) };
  const channels = channelIds(form);
  if (parsed.data.decision === "Approved" && form.get("channelsSent") === "1") {
    const set = await setAllocationRadioChannels(ctx.viewer.db, parsed.data.id, channels);
    if (!set.ok) return { error: errorKey(set.error) };
  }
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return { ok: true };
}

// Split, unsplit, withdraw, release ------------------------------------------------------------------------------------

export async function splitAllocationAction(
  _: AdvancingState,
  form: FormData,
): Promise<AdvancingState> {
  const ctx = await contextFor(form.get("org"));
  const id = z.uuid().safeParse(form.get("id"));
  if (!id.success) return { error: "invalid" };
  const entries = form.getAll("entry").map(String);
  const quantities = form.getAll("quantity").map((q) => Number(q));
  // The Asset tags field takes tags as people read them off the radio; the RPC takes unit ids.
  const tagsOf = form.getAll("units").map((v) =>
    String(v)
      .split(/[,\s]+/)
      .map((t) => t.trim().toUpperCase())
      .filter(Boolean),
  );
  const allTags = [...new Set(tagsOf.flat())];
  const units =
    allTags.length > 0
      ? await ctx.viewer.db
          .from("asset_units")
          .select("id, asset_tag")
          .eq("org_id", ctx.org.id)
          .in("asset_tag", allTags)
          .is("deleted_at", null)
      : { data: [] as { id: string; asset_tag: string }[] };
  const unitOf = new Map((units.data ?? []).map((u) => [u.asset_tag, u.id]));
  if (allTags.some((t) => !unitOf.has(t))) return { error: "issue_unit_unknown" };
  const parts = entries
    .map((rosterEntryId, i) => ({
      rosterEntryId,
      quantity: quantities[i] ?? 0,
      assetUnitIds: (tagsOf[i] ?? []).map((t) => unitOf.get(t) as string),
    }))
    .filter((p) => p.rosterEntryId !== "" && p.quantity > 0);
  if (parts.length === 0) return { fieldErrors: { quantity: "required" } };
  const channels = channelIds(form);
  if (channels.length > 16) return { error: "allocation_channel_count" };
  const result = await splitAllocation(ctx.viewer.db, id.data, parts);
  if (!result.ok) return { error: errorKey(result.error) };
  // A radio pool's shares are programmed with the channels the dialog names (G-91), each set as a whole.
  if (form.get("channelsSent") === "1" && channels.length > 0) {
    for (const share of result.data) {
      const set = await setAllocationRadioChannels(ctx.viewer.db, share, channels);
      if (!set.ok) {
        revalidatePath(`/${ctx.org.slug}`, "layout");
        return { error: errorKey(set.error) };
      }
    }
  }
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return { ok: true };
}

export async function unsplitAllocationAction(
  _: AdvancingState,
  form: FormData,
): Promise<AdvancingState> {
  const ctx = await contextFor(form.get("org"));
  const id = z.uuid().safeParse(form.get("id"));
  if (!id.success) return { error: "invalid" };
  const result = await unsplitAllocation(ctx.viewer.db, id.data);
  if (!result.ok) return { error: errorKey(result.error) };
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return { ok: true };
}

export async function withdrawAllocationAction(
  _: AdvancingState,
  form: FormData,
): Promise<AdvancingState> {
  const ctx = await contextFor(form.get("org"));
  const parsed = z
    .object({ id: z.uuid(), reason: z.string().trim().max(1000) })
    .safeParse({ id: form.get("id"), reason: form.get("reason") ?? "" });
  if (!parsed.success) return { error: "invalid" };
  const result = await withdrawAllocation(
    ctx.viewer.db,
    parsed.data.id,
    parsed.data.reason === "" ? null : parsed.data.reason,
  );
  if (!result.ok) return { error: errorKey(result.error) };
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return { ok: true };
}

export async function releaseReservationAction(
  _: AdvancingState,
  form: FormData,
): Promise<AdvancingState> {
  const ctx = await contextFor(form.get("org"));
  const parsed = z
    .object({ id: z.uuid(), reason: z.string().trim().max(1000) })
    .safeParse({ id: form.get("id"), reason: form.get("reason") ?? "" });
  if (!parsed.success) return { error: "invalid" };
  const result = await releaseReservation(
    ctx.viewer.db,
    parsed.data.id,
    parsed.data.reason === "" ? null : parsed.data.reason,
  );
  if (!result.ok) return { error: errorKey(result.error) };
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return { ok: true };
}

// Issue -----------------------------------------------------------------------------------------------------------------

export async function issueAllocationAction(
  _: AdvancingState,
  form: FormData,
): Promise<AdvancingState> {
  const ctx = await contextFor(form.get("org"));
  const parsed = z
    .object({
      id: z.uuid(),
      eventId: z.uuid(),
      kind: z.enum([
        "Credential",
        "Parking Pass",
        "Asset",
        "Catering",
        "Lodging",
        "Travel",
        "Per Diem",
      ]),
      timeZone: z.string().trim().min(1).max(64),
    })
    .safeParse({
      id: form.get("id"),
      eventId: form.get("eventId"),
      kind: form.get("kind"),
      timeZone: form.get("timeZone"),
    });
  if (!parsed.success) return { error: "invalid" };
  const text = (name: string) => {
    const v = form.get(name);
    return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
  };
  const local = (name: string) => {
    const v = text(name);
    return v ? instantOfLocalIn(v, parsed.data.timeZone) : null;
  };
  let items: IssueItem[];
  switch (parsed.data.kind) {
    case "Credential":
    case "Parking Pass":
      items = [
        {
          kind: "credential",
          validFrom: local("validFrom"),
          validTo: local("validTo"),
          rosterVehicleId: text("vehicle"),
        },
      ];
      break;
    case "Asset": {
      const lot = text("lot");
      const tags = (text("tags") ?? "")
        .split(/[\n,]+/)
        .map((t) => t.trim())
        .filter(Boolean);
      items = lot
        ? [{ kind: "lot", assetLotId: lot, quantity: Number(text("lotQuantity") ?? "0") }]
        : tags.map((assetTag) => ({ kind: "unit", assetTag }));
      break;
    }
    case "Catering":
      items = [
        {
          kind: "catering",
          description: text("description"),
          quantity: Number(text("quantity") ?? "1"),
        },
      ];
      break;
    case "Lodging":
      items = [{ kind: "lodging", checkInOn: text("checkIn"), checkOutOn: text("checkOut") }];
      break;
    case "Travel":
      items = [
        {
          kind: "travel",
          travelMode: text("travelMode") === "Ground" ? "Ground" : "Flight",
          departsFrom: text("departsFrom") ?? "",
          departsAt: local("departsAt") ?? "",
          departsTimeZone: parsed.data.timeZone,
          arrivesAtPlace: text("arrivesAtPlace") ?? "",
          arrivesAt: local("arrivesAt"),
          arrivesTimeZone: parsed.data.timeZone,
        },
      ];
      break;
    default:
      items = [
        {
          kind: "per_diem",
          day: text("day") ?? "",
          amountMinor: Math.round(Number(text("amount") ?? "0") * 100),
          currencyCode: (text("currency") ?? "USD").toUpperCase(),
        },
      ];
  }
  if (items.length === 0) return { error: "issue_items_required" };
  const result = await issueAllocation(ctx.viewer.db, {
    eventId: parsed.data.eventId,
    allocationId: parsed.data.id,
    items,
  });
  if (!result.ok) return { error: errorKey(result.error) };
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return { ok: true };
}

// Loaders ---------------------------------------------------------------------------------------------------------------

export interface AssignOptions {
  readonly holders: readonly AllocationHolder[];
  readonly items: readonly {
    readonly kind: string;
    readonly value: string;
    readonly label: string;
    /** The offering whose allowance applies; null for a badge or a site asset. */
    readonly offering: string | null;
    readonly radios: boolean;
  }[];
  readonly channels: readonly ProjectRadioChannel[];
  /** The Roles Library's default radio channel text by role code, for the hint. */
  readonly roleChannels: Readonly<Record<string, string>>;
}

/** What the Assign dialog offers on a project, read when it opens. */
export async function loadAssignOptions(
  org: string,
  projectId: string,
): Promise<AssignOptions | null> {
  const ctx = await contextFor(org);
  if (!z.uuid().safeParse(projectId).success) return null;
  const db = ctx.viewer.db;
  const [holders, categories, classes, fulfillments, blocks, channels] = await Promise.all([
    listAllocationHolders(db, projectId),
    db
      .from("credential_categories")
      .select("id, code, name, category_kind")
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .order("code"),
    db
      .from("asset_classes")
      .select("id, name, offering")
      .eq("org_id", ctx.org.id)
      .is("deleted_at", null)
      .order("name"),
    db
      .from("fulfillments")
      .select("id, title")
      .eq("project_id", projectId)
      .eq("fulfillment_kind", "Catering")
      .is("deleted_at", null)
      .order("title"),
    db
      .from("accommodation_blocks")
      .select("id, title")
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .order("title"),
    listProjectRadioChannels(db, projectId),
  ]);
  if (!holders.ok) return null;
  const roleCodes = [...new Set(holders.data.flatMap((h) => (h.roleCode ? [h.roleCode] : [])))];
  const roles =
    roleCodes.length > 0
      ? await db
          .schema("xpms")
          .from("role")
          .select("role_code, default_radio_channel")
          .in("role_code", roleCodes)
      : { data: [] as { role_code: string; default_radio_channel: string | null }[] };
  const roleChannels: Record<string, string> = {};
  for (const r of roles.data ?? [])
    if (r.default_radio_channel) roleChannels[r.role_code] = r.default_radio_channel;
  return {
    holders: holders.data,
    items: [
      ...(categories.data ?? []).map((c) => ({
        kind: c.category_kind === "Parking" ? "parking_pass" : "credential",
        value: `credential:${c.id}`,
        label: `${c.code} · ${c.name}`,
        offering: c.category_kind === "Parking" ? "Parking" : null,
        radios: false,
      })),
      ...(classes.data ?? []).map((c) => ({
        kind: "asset",
        value: `asset:${c.id}`,
        label: c.name,
        offering: c.offering,
        radios: c.offering === "Radios",
      })),
      ...(fulfillments.data ?? []).map((f) => ({
        kind: "catering",
        value: `catering:${f.id}`,
        label: f.title,
        offering: "Catering",
        radios: false,
      })),
      ...(blocks.data ?? []).map((b) => ({
        kind: "lodging",
        value: `lodging:${b.id}`,
        label: b.title,
        offering: "Lodging",
        radios: false,
      })),
      // Labelled from the kind's copy in the dialog.
      { kind: "travel", value: "service:Travel", label: "", offering: "Travel", radios: false },
      {
        kind: "per_diem",
        value: "service:Per Diem",
        label: "",
        offering: "Per Diem",
        radios: false,
      },
    ],
    channels: channels.ok ? channels.data : [],
    roleChannels,
  };
}

/** A class's availability for the dates typed, in the window's time zone. */
export async function loadAvailability(
  org: string,
  assetClassId: string,
  fromLocal: string,
  toLocal: string,
  timeZone: string,
): Promise<AssetClassAvailability | null> {
  const ctx = await contextFor(org);
  const from = instantOfLocalIn(fromLocal, timeZone);
  const to = instantOfLocalIn(toLocal, timeZone);
  if (!from || !to || !z.uuid().safeParse(assetClassId).success) return null;
  const result = await getAssetClassAvailability(ctx.viewer.db, { assetClassId, from, to });
  return result.ok ? result.data : null;
}

/** An engagement's remaining allowances, for the dialogs and the Allowance column. */
export async function loadAllowances(
  org: string,
  engagementId: string,
): Promise<readonly AllocationAllowance[]> {
  const ctx = await contextFor(org);
  if (!z.uuid().safeParse(engagementId).success) return [];
  const result = await listAllocationAllowances(ctx.viewer.db, engagementId);
  return result.ok ? result.data : [];
}

export interface IssueVehicle {
  readonly id: string;
  readonly label: string;
}

/**
 * The vehicle a parking pass may name: the person's roster vehicle through R5's app.roster_project_facts, the logged
 * read (the plate is shown, never stored on the pass).
 */
export async function loadIssueVehicle(
  org: string,
  rosterEntryId: string,
): Promise<IssueVehicle | null> {
  const ctx = await contextFor(org);
  if (!z.uuid().safeParse(rosterEntryId).success) return null;
  const { data, error } = await ctx.viewer.db.rpc("roster_project_facts", {
    p_roster_entry_id: rosterEntryId,
  });
  if (error || !data || typeof data !== "object") return null;
  const v = (data as { vehicle?: unknown }).vehicle as
    | { id?: unknown; make?: unknown; model?: unknown; plate?: unknown; plate_region?: unknown }
    | null
    | undefined;
  if (!v || typeof v.id !== "string") return null;
  return {
    id: v.id,
    label: `${String(v.make ?? "")} ${String(v.model ?? "")} · ${String(v.plate ?? "")} (${String(v.plate_region ?? "")})`,
  };
}
