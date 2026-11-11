"use server";

import type { DataError } from "@xos/data";
import {
  createOfferingRule,
  OFFERING_KINDS,
  OFFERING_MODES,
  removeOfferingRule,
  type ExternalRoleType,
  type OfferingKind,
  type OfferingMode,
} from "@xos/data/offerings";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { getOrgContext } from "@/lib/shell/context";
import * as enums from "@xos/data/enums";

/**
 * Offering rule actions (R3, owner decision 7): add and remove an audience rule of the org (Settings,
 * Gateway and marketplace) or of one project (Project Settings, Offerings). They run as the viewer, so
 * the app.offering_rules policies decide: projects.settings.write for the org or on the project. The
 * offerings.* values themselves save through the settings form's saveSettingsAction.
 */

export interface OfferingRuleState {
  readonly ok?: boolean;
  /** A key under `projects.settings.offerings.errors`. */
  readonly error?: string;
  /** Changes with every submission, so the form can tell one result from the next. */
  readonly at?: number;
}

const ROLE_TYPES: readonly ExternalRoleType[] = enums.externalRoleType;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

/** A cap: blank is no cap (NULL), a whole number from 0 to 10000, anything else undefined. */
function cap(form: FormData, name: string): number | null | undefined {
  const text = field(form, name);
  if (text === "") return null;
  if (!/^\d{1,5}$/.test(text)) return undefined;
  const value = Number(text);
  return value <= 10000 ? value : undefined;
}

function errorOf(error: DataError): string {
  switch (error.kind) {
    case "refusal":
      return error.rule === "cross_org_reference" ? "crossOrg" : "unexpected";
    case "conflict":
      return "conflict";
    case "invalid":
      return "invalid";
    case "not-found":
      return "notFound";
    default:
      return "unexpected";
  }
}

/** The page the rule lives on: the project's settings, or the org's Gateway and marketplace page. */
function pageOf(org: string, projectKey: string): string {
  return projectKey === ""
    ? `/${org}/settings/gateway-and-marketplace`
    : `/${org}/p/${projectKey}/settings`;
}

export async function createOfferingRuleAction(
  _: OfferingRuleState,
  form: FormData,
): Promise<OfferingRuleState> {
  const at = Date.now();
  const ctx = await getOrgContext(field(form, "org"));
  if (!ctx) notFound();
  const projectId = field(form, "projectId");
  const offering = field(form, "offering") as OfferingKind;
  const mode = field(form, "mode") as OfferingMode;
  const roleType = field(form, "roleType") as ExternalRoleType | "";
  const vendorClassId = field(form, "vendorClassId");
  const capPerEngagement = cap(form, "capPerEngagement");
  const capPerPerson = cap(form, "capPerPerson");
  if (
    !OFFERING_KINDS.includes(offering) ||
    !OFFERING_MODES.includes(mode) ||
    (roleType !== "" && !ROLE_TYPES.includes(roleType)) ||
    (vendorClassId !== "" && !UUID.test(vendorClassId)) ||
    (projectId !== "" && !UUID.test(projectId)) ||
    capPerEngagement === undefined ||
    capPerPerson === undefined
  ) {
    return { error: "invalid", at };
  }
  const result = await createOfferingRule(ctx.viewer.db, {
    orgId: ctx.org.id,
    projectId: projectId === "" ? null : projectId,
    offering,
    roleType: roleType === "" ? null : roleType,
    vendorClassId: vendorClassId === "" ? null : vendorClassId,
    mode,
    capPerEngagement,
    capPerPerson,
  });
  if (!result.ok) return { error: errorOf(result.error), at };
  revalidatePath(pageOf(ctx.org.slug, field(form, "projectKey")));
  return { ok: true, at };
}

export async function removeOfferingRuleAction(
  _: OfferingRuleState,
  form: FormData,
): Promise<OfferingRuleState> {
  const at = Date.now();
  const ctx = await getOrgContext(field(form, "org"));
  if (!ctx) notFound();
  const id = field(form, "id");
  if (!UUID.test(id)) return { error: "notFound", at };
  const result = await removeOfferingRule(ctx.viewer.db, id);
  if (!result.ok) return { error: errorOf(result.error), at };
  revalidatePath(pageOf(ctx.org.slug, field(form, "projectKey")));
  return { ok: true, at };
}
