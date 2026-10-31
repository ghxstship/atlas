import type { AdvanceAnswerLine } from "@xos/data/gateway";
import { z } from "zod";
import { localToInstant } from "@/lib/local-time";

/**
 * What the Advance tab's typed answer forms send (R9), read the same way by the signed-in actions
 * (lib/actions/advance.ts) and the advance link's actions (lib/actions/tokens.ts, R10): the files of
 * a File section, checked for type and size, and the lines of a Schedule Window, Item Request or
 * Credential Request, as line.<n>.<field> with times local to the form's zone.
 */

const id = z.uuid();

/** What party-uploads accepts (2712), all known to packages/platform/src/scanning/content.ts. */
export const PARTY_UPLOAD_TYPES: readonly string[] = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/webp",
  "text/csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];
export const PARTY_UPLOAD_LIMIT = 26_214_400;

/** The files of a form, checked for type and size; a field error key when one does not fit. */
export function formFiles(form: FormData): File[] | { fieldError: string } {
  const files = form.getAll("file").filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length === 0) return { fieldError: "file" };
  if (files.some((f) => !PARTY_UPLOAD_TYPES.includes(f.type))) return { fieldError: "fileType" };
  if (files.some((f) => f.size > PARTY_UPLOAD_LIMIT)) return { fieldError: "fileSize" };
  return files;
}

/** The head of a typed answer form: its zone, note and how many lines it shows. */
export const answerHead = z.object({
  timeZone: z.string().trim().min(1).max(64),
  note: z.string().trim().max(2000),
  lines: z.coerce.number().int().min(0).max(50),
});

export function answerHeadOf(form: FormData) {
  return {
    timeZone: form.get("timeZone") ?? "UTC",
    note: form.get("note") ?? "",
    lines: form.get("lines") ?? 0,
  };
}

const lineSchema = z.object({
  item: z.string().trim().max(80),
  quantity: z.string().trim().max(6),
  person: z.string().trim().max(40),
  from: z.string().trim().max(40),
  to: z.string().trim().max(40),
  note: z.string().trim().max(500),
});

/**
 * The lines of a typed answer. An item is asset_class:<id> or credential_category:<id>; times are
 * local in the form's zone and become instants here; a row left empty is not a line.
 */
export function answerLines(
  form: FormData,
  count: number,
  timeZone: string,
): AdvanceAnswerLine[] | { fieldError: string } {
  const lines: AdvanceAnswerLine[] = [];
  for (let n = 0; n < count; n += 1) {
    const field = (name: string) => String(form.get(`line.${n}.${name}`) ?? "");
    const parsed = lineSchema.safeParse({
      item: field("item"),
      quantity: field("quantity"),
      person: field("person"),
      from: field("from"),
      to: field("to"),
      note: field("note"),
    });
    if (!parsed.success) return { fieldError: "advanceLine" };
    const l = parsed.data;
    const [kind, itemId] = l.item.split(":");
    if (l.item !== "" && (!itemId || !id.safeParse(itemId).success))
      return { fieldError: "advanceLine" };
    if (l.person !== "" && !id.safeParse(l.person).success) return { fieldError: "advanceLine" };
    if ((l.from === "") !== (l.to === "")) return { fieldError: "allocationWindow" };
    const quantity = l.quantity === "" ? null : Number(l.quantity);
    if (quantity !== null && (!Number.isInteger(quantity) || quantity < 1))
      return { fieldError: "allocationQuantity" };
    if (l.item === "" && l.from === "" && quantity === null) continue;
    lines.push({
      assetClassId: kind === "asset_class" ? (itemId ?? null) : null,
      credentialCategoryId: kind === "credential_category" ? (itemId ?? null) : null,
      quantity,
      rosterEntryId: l.person === "" ? null : l.person,
      neededFrom: l.from === "" ? null : localToInstant(l.from, timeZone),
      neededTo: l.to === "" ? null : localToInstant(l.to, timeZone),
      windowZone: l.from === "" ? null : timeZone,
      note: l.note === "" ? null : l.note,
    });
  }
  return lines;
}
