"use server";

import {
  addCustomFieldChoice,
  addSpendAuthority,
  createCustomField,
  CUSTOM_DATA_TYPES,
  fieldKeyFrom,
  removeCustomField,
  removeSpendAuthority,
  setSeparationOption,
  SPEND_DOCUMENT_TYPES,
  type CustomDataType,
  type SpendDocumentType,
} from "@xos/data/governance";
import { requireSecondFactor } from "@xos/data/auth-assurance";
import {
  DATA_REQUEST_MOVES,
  moveDataRequest,
  placeLegalHold,
  releaseLegalHold,
  type DataRequestState,
} from "@xos/data/data-privacy";
import {
  createApiKey,
  createPersonalToken,
  createServiceAccount,
  retireServiceAccount,
  revokeApiKey,
  revokePersonalToken,
} from "@xos/data/developer";
import { setDepartmentsInUse, setLocationDefaults } from "@xos/data/org-setup";
import type { DataError, Result } from "@xos/data/result";
import {
  createWebhookEndpoint,
  removeWebhookEndpoint,
  replayWebhookDelivery,
  setWebhookEndpointDisabled,
} from "@xos/data/webhooks";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { SurfaceState } from "@/components/settings/surfaces/state";
import { minorUnits } from "@/lib/assets/money";
import { getOrgContext, type OrgContext } from "@/lib/shell/context";

/**
 * Server actions of the settings surfaces A86 contributes (RRR-131, finding A65-004). Each resolves the viewer's
 * org context again (404 when gone, so the IP allow-list applies), parses the form, and calls the @xos/data
 * function; row level security and the RPCs decide every write. Outcomes come back in words, from
 * `settingsSurfaces.errors.*`, so the client forms carry no catalog. Secrets of new keys, tokens and endpoints
 * come back once in the state and are never stored by Atlas.
 */

const P = "settingsSurfaces";

async function contextFor(form: FormData): Promise<OrgContext> {
  const slug = form.get("org");
  const ctx = typeof slug === "string" ? await getOrgContext(slug) : null;
  if (!ctx) notFound();
  return ctx;
}

function text(form: FormData, name: string): string | null {
  const value = form.get(name);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function list(form: FormData, name: string): string[] {
  return form
    .getAll(name)
    .flatMap((v) => (typeof v === "string" && v.trim() !== "" ? [v.trim()] : []));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EXPIRY_DAYS = new Set(["30", "90", "180", "365"]);

/** An instant `days` from now; expiries are durations, not calendar dates. */
function inDays(days: string): string {
  return new Date(Date.now() + Number(days) * 86_400_000).toISOString();
}

async function messageFor(error: DataError): Promise<string> {
  const t = await getTranslations(P);
  const has = (key: string) => t.has(key as never);
  const say = (key: string) => (t as unknown as (k: string) => string)(key);
  if (error.kind === "refusal") {
    const key = `errors.${error.rule}`;
    return has(key) ? say(key) : say("errors.refused");
  }
  if (error.kind === "not-found") return say("errors.denied");
  if (error.kind === "conflict") return say("errors.conflict");
  if (error.kind === "invalid") return say("errors.invalid");
  return say("errors.unexpected");
}

async function invalid(fields: readonly string[]): Promise<SurfaceState> {
  const t = await getTranslations(P);
  const say = (key: string) => (t as unknown as (k: string) => string)(key);
  return {
    message: say("errors.fields"),
    fieldErrors: Object.fromEntries(fields.map((f) => [f, say(`fieldErrors.${f}`)])),
    at: Date.now(),
  };
}

async function finish(
  path: string,
  result: Result<unknown>,
  extra: Partial<SurfaceState> = {},
): Promise<SurfaceState> {
  if (!result.ok) {
    const stepUp = result.error.kind === "refusal" && result.error.rule === "step_up_required";
    return {
      message: await messageFor(result.error),
      at: Date.now(),
      ...(stepUp ? { stepUp } : {}),
    };
  }
  revalidatePath(path);
  return { ok: true, at: Date.now(), ...extra };
}

const org = (ctx: OrgContext, section: string) => `/${ctx.org.slug}/settings/${section}`;
const me = (ctx: OrgContext, section: string) => `/${ctx.org.slug}/me/${section}`;

// API keys and service accounts -----------------------------------------------------------------------------

export async function createServiceAccountAction(
  _: SurfaceState,
  form: FormData,
): Promise<SurfaceState> {
  const ctx = await contextFor(form);
  const name = text(form, "name");
  const roleId = text(form, "roleId");
  const expires = text(form, "expiresIn");
  const bad = [
    ...(name === null || name.length > 200 ? ["name"] : []),
    ...(roleId === null || !UUID.test(roleId) ? ["roleId"] : []),
    ...(expires !== null && !EXPIRY_DAYS.has(expires) ? ["expiresIn"] : []),
  ];
  if (bad.length > 0 || name === null || roleId === null) return invalid(bad);
  return finish(
    org(ctx, "api-keys-and-service-accounts"),
    await createServiceAccount(ctx.viewer.db, {
      orgId: ctx.org.id,
      name,
      roleId,
      expiresAt: expires === null ? null : inDays(expires),
    }),
  );
}

export async function retireServiceAccountAction(
  _: SurfaceState,
  form: FormData,
): Promise<SurfaceState> {
  const ctx = await contextFor(form);
  const id = text(form, "id");
  if (id === null || !UUID.test(id)) return invalid([]);
  return finish(
    org(ctx, "api-keys-and-service-accounts"),
    await retireServiceAccount(ctx.viewer.db, id),
  );
}

export async function createApiKeyAction(_: SurfaceState, form: FormData): Promise<SurfaceState> {
  const ctx = await contextFor(form);
  const name = text(form, "name");
  const account = text(form, "serviceAccountId");
  const scopes = list(form, "scopes");
  const expires = text(form, "expiresIn") ?? "90";
  const bad = [
    ...(name === null || name.length > 200 ? ["name"] : []),
    ...(account !== null && !UUID.test(account) ? ["serviceAccountId"] : []),
    ...(scopes.length === 0 ? ["scopes"] : []),
    ...(!EXPIRY_DAYS.has(expires) ? ["expiresIn"] : []),
  ];
  if (bad.length > 0 || name === null) return invalid(bad);
  const result = await createApiKey(ctx.viewer.db, {
    orgId: ctx.org.id,
    name,
    scopes,
    expiresAt: inDays(expires),
    serviceAccountId: account,
  });
  return finish(org(ctx, "api-keys-and-service-accounts"), result, {
    ...(result.ok ? { secret: result.data.secret } : {}),
  });
}

export async function revokeApiKeyAction(_: SurfaceState, form: FormData): Promise<SurfaceState> {
  const ctx = await contextFor(form);
  const id = text(form, "id");
  if (id === null || !UUID.test(id)) return invalid([]);
  return finish(org(ctx, "api-keys-and-service-accounts"), await revokeApiKey(ctx.viewer.db, id));
}

// Webhooks -------------------------------------------------------------------------------------------------

export async function createWebhookAction(_: SurfaceState, form: FormData): Promise<SurfaceState> {
  const ctx = await contextFor(form);
  const url = text(form, "url");
  const description = text(form, "description");
  const events = list(form, "events");
  const bad = [
    ...(url === null || !/^https:\/\/[^\s]+$/.test(url) || url.length > 2000 ? ["url"] : []),
    ...(description !== null && description.length > 300 ? ["description"] : []),
    ...(events.length === 0 ? ["events"] : []),
  ];
  if (bad.length > 0 || url === null) return invalid(bad);
  const result = await createWebhookEndpoint(ctx.viewer.db, {
    orgId: ctx.org.id,
    url,
    events,
    description,
  });
  return finish(org(ctx, "webhooks"), result, {
    ...(result.ok ? { secret: result.data.secret } : {}),
  });
}

export async function toggleWebhookAction(_: SurfaceState, form: FormData): Promise<SurfaceState> {
  const ctx = await contextFor(form);
  const id = text(form, "id");
  if (id === null || !UUID.test(id)) return invalid([]);
  return finish(
    org(ctx, "webhooks"),
    await setWebhookEndpointDisabled(ctx.viewer.db, id, text(form, "disable") === "on"),
  );
}

export async function removeWebhookAction(_: SurfaceState, form: FormData): Promise<SurfaceState> {
  const ctx = await contextFor(form);
  const id = text(form, "id");
  if (id === null || !UUID.test(id)) return invalid([]);
  return finish(org(ctx, "webhooks"), await removeWebhookEndpoint(ctx.viewer.db, id));
}

export async function replayDeliveryAction(_: SurfaceState, form: FormData): Promise<SurfaceState> {
  const ctx = await contextFor(form);
  const id = text(form, "id");
  if (id === null || !UUID.test(id)) return invalid([]);
  return finish(org(ctx, "webhooks"), await replayWebhookDelivery(ctx.viewer.db, id));
}

// Spend authority ------------------------------------------------------------------------------------------

export async function addSpendLimitAction(_: SurfaceState, form: FormData): Promise<SurfaceState> {
  const ctx = await contextFor(form);
  const holder = text(form, "holder") ?? "";
  const [kind, holderId = ""] = holder.split(":");
  const documentType = text(form, "documentType");
  const currency = text(form, "currency")?.toUpperCase() ?? null;
  const limit = currency ? minorUnits(text(form, "limit") ?? "", currency) : null;
  const dualText = text(form, "dualAbove");
  const dual = dualText === null || currency === null ? null : minorUnits(dualText, currency);
  const bad = [
    ...((kind !== "role" && kind !== "member") || !UUID.test(holderId) ? ["holder"] : []),
    ...(!SPEND_DOCUMENT_TYPES.includes(documentType as SpendDocumentType) ? ["documentType"] : []),
    ...(currency === null || !/^[A-Z]{3}$/.test(currency) ? ["currency"] : []),
    ...(limit === null ? ["limit"] : []),
    ...(dualText !== null && dual === null ? ["dualAbove"] : []),
  ];
  if (bad.length > 0 || limit === null || currency === null) return invalid(bad);
  return finish(
    org(ctx, "spend-authority"),
    await addSpendAuthority(ctx.viewer.db, {
      orgId: ctx.org.id,
      holder: kind === "role" ? { roleId: holderId } : { membershipId: holderId },
      documentType: documentType as SpendDocumentType,
      currencyCode: currency,
      limitMinor: limit,
      dualApprovalAboveMinor: dual,
    }),
  );
}

export async function removeSpendLimitAction(
  _: SurfaceState,
  form: FormData,
): Promise<SurfaceState> {
  const ctx = await contextFor(form);
  const id = text(form, "id");
  if (id === null || !UUID.test(id)) return invalid([]);
  return finish(org(ctx, "spend-authority"), await removeSpendAuthority(ctx.viewer.db, id));
}

// Separation of duties ------------------------------------------------------------------------------------

/** Switches a stricter option on or off (2280, ADR 0113); the database refuses a built-in rule's code. */
export async function setSeparationOptionAction(
  _: SurfaceState,
  form: FormData,
): Promise<SurfaceState> {
  const ctx = await contextFor(form);
  const code = text(form, "code");
  const on = text(form, "on");
  if (code === null || !/^sod_[a-z_]+$/.test(code) || (on !== "on" && on !== "off")) {
    return invalid([]);
  }
  return finish(
    org(ctx, "separation-of-duties"),
    await setSeparationOption(ctx.viewer.db, ctx.org.id, code, on === "on"),
  );
}

// Custom fields --------------------------------------------------------------------------------------------

export async function createCustomFieldAction(
  _: SurfaceState,
  form: FormData,
): Promise<SurfaceState> {
  const ctx = await contextFor(form);
  const target = text(form, "target");
  const label = text(form, "label");
  const key = text(form, "key") ?? (label ? fieldKeyFrom(label) : null);
  const dataType = text(form, "dataType");
  const bad = [
    ...(target === null || !/^app\.[a-z][a-z0-9_]*$/.test(target) ? ["target"] : []),
    ...(label === null || label.length > 100 ? ["label"] : []),
    ...(key === null || !/^[a-z][a-z0-9_]{0,47}$/.test(key) ? ["key"] : []),
    ...(!CUSTOM_DATA_TYPES.includes(dataType as CustomDataType) ? ["dataType"] : []),
  ];
  if (bad.length > 0 || target === null || label === null || key === null) return invalid(bad);
  return finish(
    org(ctx, "custom-fields"),
    await createCustomField(ctx.viewer.db, {
      orgId: ctx.org.id,
      targetTable: target,
      key,
      label,
      dataType: dataType as CustomDataType,
      required: text(form, "required") === "on",
      filterable: text(form, "filterable") === "on",
      sortOrder: Number(text(form, "sortOrder") ?? "100") || 100,
    }),
  );
}

export async function removeCustomFieldAction(
  _: SurfaceState,
  form: FormData,
): Promise<SurfaceState> {
  const ctx = await contextFor(form);
  const id = text(form, "id");
  if (id === null || !UUID.test(id)) return invalid([]);
  return finish(org(ctx, "custom-fields"), await removeCustomField(ctx.viewer.db, id));
}

export async function addCustomFieldChoiceAction(
  _: SurfaceState,
  form: FormData,
): Promise<SurfaceState> {
  const ctx = await contextFor(form);
  const fieldId = text(form, "fieldId");
  const label = text(form, "label");
  const key = label ? fieldKeyFrom(label) : "";
  const bad = [
    ...(fieldId === null || !UUID.test(fieldId) ? ["fieldId"] : []),
    ...(label === null || label.length > 100 || key === "" ? ["label"] : []),
  ];
  if (bad.length > 0 || fieldId === null || label === null) return invalid(bad);
  return finish(
    org(ctx, "custom-fields"),
    await addCustomFieldChoice(ctx.viewer.db, {
      orgId: ctx.org.id,
      fieldId,
      key,
      label,
      sortOrder: Number(text(form, "sortOrder") ?? "100") || 100,
    }),
  );
}

// Data and privacy -----------------------------------------------------------------------------------------

export async function moveDataRequestAction(
  _: SurfaceState,
  form: FormData,
): Promise<SurfaceState> {
  const ctx = await contextFor(form);
  const id = text(form, "id");
  const expected = text(form, "expected") as DataRequestState | null;
  const next = text(form, "next") as DataRequestState | null;
  const reason = text(form, "reason");
  const allowed =
    expected !== null && next !== null && (DATA_REQUEST_MOVES[expected] ?? []).includes(next);
  const bad = [
    ...(id === null || !UUID.test(id) || !allowed ? ["next"] : []),
    ...(reason === null || reason.length > 500 ? ["reason"] : []),
  ];
  if (bad.length > 0 || id === null || expected === null || next === null || reason === null) {
    return invalid(bad);
  }
  return finish(
    org(ctx, "data-and-privacy"),
    await moveDataRequest(ctx.viewer.db, { id, expected, next, reason }),
  );
}

export async function placeLegalHoldAction(_: SurfaceState, form: FormData): Promise<SurfaceState> {
  const ctx = await contextFor(form);
  const matter = text(form, "matter");
  const table = text(form, "table");
  const bad = [
    ...(matter === null || matter.length > 300 ? ["matter"] : []),
    ...(table !== null && !/^app\.[a-z][a-z0-9_]*$/.test(table) ? ["table"] : []),
  ];
  if (bad.length > 0 || matter === null) return invalid(bad);
  return finish(
    org(ctx, "data-and-privacy"),
    await placeLegalHold(ctx.viewer.db, { orgId: ctx.org.id, matter, tableName: table }),
  );
}

export async function releaseLegalHoldAction(
  _: SurfaceState,
  form: FormData,
): Promise<SurfaceState> {
  const ctx = await contextFor(form);
  const id = text(form, "id");
  if (id === null || !UUID.test(id)) return invalid([]);
  return finish(org(ctx, "data-and-privacy"), await releaseLegalHold(ctx.viewer.db, id));
}

// Departments in use and location defaults -----------------------------------------------------------------

export async function saveDepartmentsAction(
  _: SurfaceState,
  form: FormData,
): Promise<SurfaceState> {
  const ctx = await contextFor(form);
  const departments = list(form, "departments").filter((d) => /^[0-9]000$/.test(d));
  // A discipline under a department that is no longer chosen goes with it.
  const disciplines = list(form, "disciplines").filter(
    (d) => /^[0-9]{4}\.[0-9]{2}$/.test(d) && departments.includes(`${d.slice(0, 1)}000`),
  );
  return finish(
    org(ctx, "departments-and-disciplines"),
    await setDepartmentsInUse(ctx.viewer.db, ctx.org.id, { departments, disciplines }),
  );
}

export async function saveLocationDefaultsAction(
  _: SurfaceState,
  form: FormData,
): Promise<SurfaceState> {
  const ctx = await contextFor(form);
  return finish(
    org(ctx, "locations-and-venues"),
    await setLocationDefaults(ctx.viewer.db, ctx.org.id, {
      jurisdictionId: text(form, "jurisdictionId"),
      timeZone: text(form, "timeZone"),
    }),
  );
}

// Personal: developer tokens and connected apps ------------------------------------------------------------

export async function createPersonalTokenAction(
  _: SurfaceState,
  form: FormData,
): Promise<SurfaceState> {
  const ctx = await contextFor(form);
  const name = text(form, "name");
  const scopes = list(form, "scopes");
  const expires = text(form, "expiresIn") ?? "90";
  const bad = [
    ...(name === null || name.length > 200 ? ["name"] : []),
    ...(scopes.length === 0 ? ["scopes"] : []),
    ...(!EXPIRY_DAYS.has(expires) ? ["expiresIn"] : []),
  ];
  if (bad.length > 0 || name === null) return invalid(bad);
  // A token acts as the person, so issuing one needs a recent second factor (A77's step-up, migration 1333). The
  // database refuses step_up_required on its own too; checking first lets the form open the dialog at once.
  const stepUp = await requireSecondFactor(ctx.viewer.db);
  if (!stepUp.ok) {
    return {
      message: await messageFor({ kind: "refusal", rule: stepUp.rule, message: "" }),
      stepUp: true,
      at: Date.now(),
    };
  }
  const result = await createPersonalToken(ctx.viewer.db, {
    orgId: ctx.org.id,
    name,
    scopes,
    expiresAt: inDays(expires),
  });
  return finish(me(ctx, "developer"), result, {
    ...(result.ok ? { secret: result.data.secret } : {}),
  });
}

export async function revokePersonalTokenAction(
  _: SurfaceState,
  form: FormData,
): Promise<SurfaceState> {
  const ctx = await contextFor(form);
  const id = text(form, "id");
  if (id === null || !UUID.test(id)) return invalid([]);
  const result = await revokePersonalToken(ctx.viewer.db, id);
  revalidatePath(org(ctx, "api-keys-and-service-accounts"));
  return finish(me(ctx, "developer"), result);
}
