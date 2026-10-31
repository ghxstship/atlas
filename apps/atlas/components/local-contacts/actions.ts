"use server";

import type { DataError } from "@xos/data";
import {
  createLocalContact,
  deleteLocalContact,
  LOCAL_CONTACT_AUDIENCES,
  LOCAL_CONTACT_ROLES,
  toE164,
  updateLocalContact,
  type LocalContactInput,
} from "@xos/data/local-contacts";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getOrgContext } from "@/lib/shell/context";

/**
 * Local contact writes (B5, G-56) for the day sheet (show.day_sheet.write on the project) and the venue peek
 * (places.venue.write). The database decides every write; refusals come back as keys under
 * `<namespace>.localContacts.errors`, in show.json and places.json alike.
 */
export type LocalContactResult =
  { readonly ok: true } | { readonly ok: false; readonly key: string };

const EXPLAINED = new Set([
  "local_contact_member",
  "local_contact_day_outside_project",
  "cross_org_reference",
]);

function keyOf(error: DataError): string {
  if (error.kind === "refusal") return EXPLAINED.has(error.rule) ? error.rule : "refused";
  if (error.kind === "not-found") return "notFound";
  if (error.kind === "invalid") return "invalid";
  return "unexpected";
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? null : v));

const inputSchema = z.object({
  role: z.enum(LOCAL_CONTACT_ROLES as [string, ...string[]]),
  title: text(120),
  audience: z.enum(LOCAL_CONTACT_AUDIENCES as [string, ...string[]]),
  notes: text(500),
  membershipId: z.string().optional(),
  name: text(120).optional(),
  phone: z.string().optional(),
  email: z
    .string()
    .trim()
    .transform((v) => (v === "" ? null : v.toLowerCase()))
    .pipe(z.email().nullable())
    .optional(),
});

export interface LocalContactForm {
  readonly role: string;
  readonly title: string;
  readonly audience: string;
  readonly notes: string;
  /** A member of the org, read live; else a typed contact with name, phone and email. */
  readonly membershipId?: string;
  readonly name?: string;
  readonly phone?: string;
  readonly email?: string;
}

function toInput(form: LocalContactForm): LocalContactInput | "invalid" | "phone" {
  const parsed = inputSchema.safeParse(form);
  if (!parsed.success) return "invalid";
  const v = parsed.data;
  const base = {
    role: v.role as LocalContactInput["role"],
    title: v.title,
    audience: v.audience as LocalContactInput["audience"],
    notes: v.notes,
  };
  if (v.membershipId)
    return z.uuid().safeParse(v.membershipId).success
      ? { ...base, who: { membershipId: v.membershipId } }
      : "invalid";
  if (!v.name) return "invalid";
  const phone = v.phone?.trim() ? toE164(v.phone) : null;
  if (v.phone?.trim() && !phone) return "phone";
  return { ...base, who: { name: v.name, phone, email: v.email ?? null, supplierId: null } };
}

async function context(org: string) {
  const ctx = await getOrgContext(org);
  if (!ctx) notFound();
  return ctx;
}

export async function saveLocalContactAction(
  org: string,
  target:
    | { readonly id: string; readonly day?: string | null }
    | { readonly projectId: string; readonly day: string | null }
    | { readonly venueId: string },
  form: LocalContactForm,
): Promise<LocalContactResult> {
  const ctx = await context(org);
  const input = toInput(form);
  if (input === "invalid" || input === "phone") return { ok: false, key: input };
  if (
    "day" in target &&
    target.day !== null &&
    target.day !== undefined &&
    !day.safeParse(target.day).success
  ) {
    return { ok: false, key: "invalid" };
  }
  const result =
    "id" in target
      ? z.uuid().safeParse(target.id).success
        ? await updateLocalContact(ctx.viewer.db, target.id, input, target.day)
        : null
      : "venueId" in target
        ? await createLocalContact(ctx.viewer.db, { venueId: target.venueId }, input)
        : await createLocalContact(
            ctx.viewer.db,
            { projectId: target.projectId, day: target.day },
            input,
          );
  if (!result) return { ok: false, key: "notFound" };
  if (!result.ok) return { ok: false, key: keyOf(result.error) };
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return { ok: true };
}

export async function deleteLocalContactAction(
  org: string,
  id: string,
): Promise<LocalContactResult> {
  const ctx = await context(org);
  if (!z.uuid().safeParse(id).success) return { ok: false, key: "notFound" };
  const result = await deleteLocalContact(ctx.viewer.db, id);
  if (!result.ok) return { ok: false, key: keyOf(result.error) };
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return { ok: true };
}
