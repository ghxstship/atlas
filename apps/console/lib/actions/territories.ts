"use server";

import {
  grantTerritoryException,
  revokeTerritoryException,
  saveTerritory,
  setTerritoryOffered,
} from "@xos/data/console-territories";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { actionContext } from "@/lib/operator";
import { failed, field, fromResult, type ActionState } from "@/lib/action-state";

/**
 * Where XOS is offered (ADR 0160, migration 6150): open or close a territory, edit one, and record or withdraw an
 * exception for a signed contract. Each action checks the operator and the second factor first and the database checks
 * them again; every change lands in the console ledger with its reason.
 */

const Uuid = z.uuid();
const Day = z.iso.date();

/** A multi-select's picks, which the form sends as one comma-separated field. */
function picks(form: FormData, name: string): string[] {
  return field(form, name)
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
}

export async function setTerritoryOfferedAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await actionContext("territories.write");
  if (!ctx.ok) return failed(ctx.key);
  const code = field(form, "code");
  const offered = field(form, "offered");
  const reason = field(form, "reason");
  if (code === "" || (offered !== "on" && offered !== "off") || reason === "") {
    return failed("errors.invalid");
  }
  const result = await setTerritoryOffered(ctx.db, { code, offered: offered === "on", reason });
  if (result.ok) revalidatePath("/territories");
  return fromResult(result);
}

export async function saveTerritoryAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext("territories.write");
  if (!ctx.ok) return failed(ctx.key);
  const editing = field(form, "editing");
  const code = editing || field(form, "code");
  const nameEn = field(form, "nameEn");
  const nameEs = field(form, "nameEs");
  const reason = field(form, "reason");
  if (code === "" || nameEn === "" || nameEs === "" || reason === "") {
    return failed("errors.invalid");
  }
  const result = await saveTerritory(ctx.db, {
    isNew: editing === "",
    code,
    nameEn,
    nameEs,
    countries: picks(form, "countries"),
    currencies: picks(form, "currencies"),
    locales: picks(form, "locales"),
    reason,
  });
  if (result.ok) revalidatePath("/territories");
  return fromResult(result);
}

export async function grantTerritoryExceptionAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await actionContext("territories.write");
  if (!ctx.ok) return failed(ctx.key);
  const ownerEmail = field(form, "ownerEmail");
  const countryCode = field(form, "countryCode");
  const contractReference = field(form, "contractReference");
  const contractSignedOn = field(form, "contractSignedOn");
  const reason = field(form, "reason");
  if (
    ownerEmail === "" ||
    countryCode === "" ||
    contractReference === "" ||
    !Day.safeParse(contractSignedOn).success ||
    reason === ""
  ) {
    return failed("errors.invalid");
  }
  const result = await grantTerritoryException(ctx.db, {
    ownerEmail,
    countryCode,
    contractReference,
    contractSignedOn,
    reason,
  });
  if (result.ok) revalidatePath("/territories");
  return fromResult(result);
}

export async function revokeTerritoryExceptionAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await actionContext("territories.write");
  if (!ctx.ok) return failed(ctx.key);
  const id = field(form, "id");
  const reason = field(form, "reason");
  if (!Uuid.safeParse(id).success || reason === "") return failed("errors.invalid");
  const result = await revokeTerritoryException(ctx.db, { id, reason });
  if (result.ok) revalidatePath("/territories");
  return fromResult(result);
}
