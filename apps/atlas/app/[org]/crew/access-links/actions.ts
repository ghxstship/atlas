"use server";

import {
  issueCrewAccessLinks,
  listCrewAccessWorkers,
  revokeCrewAccessLink,
  type CrewAccessWorker,
  type CrewAccessWorkerRef,
  type IssuedCrewAccessLink,
} from "@xos/data/crew-access";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { gatewayUrl } from "@/lib/gateway-url";
import { getOrgContext, type OrgContext } from "@/lib/shell/context";

/**
 * Crew access links (B10, G-125): issuing and revoking. Issuing never revalidates the page: the tokens and codes live only
 * in the action's answer, so a refresh cannot take away the one view of them. The person's closing the panel refreshes.
 */

export interface IssuedLink extends IssuedCrewAccessLink {
  /** The worker's page: the org's custom Gateway domain when it has one, or the platform Gateway. A bare path shows no QR. */
  readonly url: string;
}

export interface IssueState {
  readonly links?: readonly IssuedLink[];
  readonly includeCode?: boolean;
  readonly projectName?: string;
  readonly rule?: string;
  readonly error?: "input" | "notFound" | "unexpected";
  readonly at?: number;
}

async function contextFor(form: FormData): Promise<OrgContext> {
  const slug = form.get("org");
  const ctx = typeof slug === "string" ? await getOrgContext(slug) : null;
  if (!ctx) notFound();
  return ctx;
}

const WORKER = z.union([
  z.object({ membership_id: z.uuid() }),
  z.object({ engagement_id: z.uuid() }),
  z.object({ roster_entry_id: z.uuid() }),
]);

export async function issueCrewAccessLinksAction(_: IssueState, form: FormData): Promise<IssueState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({
      projectId: z.uuid(),
      workers: z.array(WORKER).min(1).max(200),
      validFor: z.coerce.number().int().min(1).max(30),
    })
    .safeParse({
      projectId: form.get("projectId"),
      workers: (() => {
        try {
          return JSON.parse(String(form.get("workers") ?? "[]")) as unknown;
        } catch {
          return [];
        }
      })(),
      validFor: form.get("validFor"),
    });
  if (!parsed.success) return { error: "input", at: Date.now() };
  const result = await issueCrewAccessLinks(ctx.viewer.db, {
    projectId: parsed.data.projectId,
    workers: parsed.data.workers as readonly CrewAccessWorkerRef[],
    validForDays: parsed.data.validFor,
  });
  if (!result.ok) {
    if (result.error.kind === "refusal") return { rule: result.error.rule, at: Date.now() };
    return { error: result.error.kind === "not-found" ? "notFound" : "unexpected", at: Date.now() };
  }
  return {
    includeCode: form.get("includeCode") === "true",
    projectName: String(form.get("projectName") ?? ""),
    links: result.data.map((link) => ({
      ...link,
      url: link.gatewayHost
        ? `https://${link.gatewayHost}/shifts/${link.token}`
        : gatewayUrl(`/shifts/${link.token}`),
    })),
    at: Date.now(),
  };
}

/** The workers a project can issue links to, for the issue form's picker. */
export async function crewAccessWorkersAction(input: {
  org: string;
  projectId: string;
}): Promise<readonly CrewAccessWorker[]> {
  const ctx = await getOrgContext(input.org);
  if (!ctx || !z.uuid().safeParse(input.projectId).success) return [];
  const result = await listCrewAccessWorkers(ctx.viewer.db, input.projectId);
  return result.ok ? result.data : [];
}

export async function revokeCrewAccessLinkAction(form: FormData): Promise<void> {
  const ctx = await contextFor(form);
  const id = z.uuid().safeParse(form.get("id"));
  if (!id.success) return;
  await revokeCrewAccessLink(ctx.viewer.db, id.data);
  revalidatePath(`/${ctx.org.slug}/crew/access-links`);
}
