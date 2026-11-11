"use server";

import {
  changeWarehouseDestination,
  createWarehouseDestination,
  deliveryHour,
  requestWarehouseDelivery,
  retryDeadLetter,
  storeInboundSecret,
  storeWarehouseCredential,
  type WarehouseFormat,
  type WarehouseProvider,
} from "@xos/data/warehouse";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { contextFor } from "@/lib/platform/action-context";
import { done, field, inputError, type PlatformActionState } from "@/lib/platform/state";
import { fromDataError } from "@/lib/platform/data-error";
import * as enums from "@xos/data/enums";

/**
 * Server actions of A83's panels on Settings, Integrations: warehouse delivery (Enterprise) and provider webhooks.
 * Each writes with the viewer's client, so row level security and the RPCs of migrations 1400 and 1401 decide;
 * a refusal comes back as its rule and the form shows the sentence from `platform.refusals`.
 */

const PROVIDERS: readonly WarehouseProvider[] = enums.warehouseProvider;
const FORMATS: readonly WarehouseFormat[] = enums.warehouseFileFormat;
const uuid = z.uuid();

function refresh(slug: string): void {
  revalidatePath(`/${slug}/settings/integrations`);
}

export async function addWarehouseDestinationAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const provider = field(form, "provider") as WarehouseProvider;
  const format = field(form, "format") as WarehouseFormat;
  const hour = deliveryHour(field(form, "hour"));
  const name = field(form, "name");
  const bucket = field(form, "bucket").toLowerCase();
  if (
    !PROVIDERS.includes(provider) ||
    !FORMATS.includes(format) ||
    hour === null ||
    !name ||
    !bucket
  ) {
    return inputError();
  }
  const optional = (key: string) => field(form, key) || null;
  const result = await createWarehouseDestination(ctx.viewer.db, {
    orgId: ctx.org.id,
    provider,
    displayName: name.slice(0, 120),
    bucketName: bucket,
    region: optional("region"),
    endpointUrl: optional("endpoint"),
    pathPrefix: field(form, "prefix").replace(/^\/+|\/+$/g, "") || "xos",
    fileFormat: format,
    includeConfidential: form.get("confidential") === "on",
    deliveryHour: hour,
  });
  if (!result.ok) return fromDataError(result.error);
  refresh(ctx.org.slug);
  return done(result.data);
}

export async function storeWarehouseCredentialAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const destination = field(form, "destination");
  const secret = field(form, "secret");
  if (!uuid.safeParse(destination).success || !secret) return inputError();
  try {
    const parsed = JSON.parse(secret) as Record<string, unknown>;
    if (
      typeof parsed["access_key_id"] !== "string" ||
      typeof parsed["secret_access_key"] !== "string"
    ) {
      return { rule: "warehouse_credential_format", at: Date.now() };
    }
  } catch (error) {
    return {
      rule: error instanceof SyntaxError ? "warehouse_credential_format" : "other",
      at: Date.now(),
    };
  }
  const result = await storeWarehouseCredential(ctx.viewer.db, destination, secret);
  if (!result.ok) return fromDataError(result.error);
  refresh(ctx.org.slug);
  return done(destination);
}

export async function warehouseDestinationAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const destination = field(form, "destination");
  const intent = field(form, "intent");
  if (!uuid.safeParse(destination).success) return inputError();
  const result =
    intent === "deliver"
      ? await requestWarehouseDelivery(ctx.viewer.db, destination)
      : intent === "pause" || intent === "resume"
        ? await changeWarehouseDestination(ctx.viewer.db, destination, {
            state: intent === "pause" ? "Paused" : "Active",
          })
        : intent === "remove"
          ? await changeWarehouseDestination(ctx.viewer.db, destination, { deleted: true })
          : null;
  if (result === null) return inputError();
  if (!result.ok) return fromDataError(result.error);
  refresh(ctx.org.slug);
  return done(result.data);
}

export async function retryDeadLetterAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const event = field(form, "event");
  const reason = field(form, "reason");
  if (!uuid.safeParse(event).success || !reason || reason.length > 500) return inputError();
  const result = await retryDeadLetter(ctx.viewer.db, event, reason);
  if (!result.ok) return fromDataError(result.error);
  refresh(ctx.org.slug);
  return done(event);
}

export async function storeInboundSecretAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const connection = field(form, "connection");
  const secret = field(form, "secret");
  if (!uuid.safeParse(connection).success || !secret) return inputError();
  const result = await storeInboundSecret(ctx.viewer.db, connection, secret);
  if (!result.ok) return fromDataError(result.error);
  refresh(ctx.org.slug);
  return done(connection);
}
