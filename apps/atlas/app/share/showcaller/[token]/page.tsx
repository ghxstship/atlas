import {
  openShowcallerLink,
  parseShowcallerRefusal,
  readShowcallerRun,
  SHOWCALLER_TOKEN,
  showcallerAsksForCode,
  showcallerPath,
  type ShowcallerRefusal,
} from "@xos/data/showcaller-links";
import type { Metadata, Route } from "next";
import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PublicLive } from "@/components/live/public-live";
import { ShowcallerCodeForm } from "@/components/show/showcaller-code-form";
import { ShowcallerPortal } from "@/components/show/showcaller-portal";
import { env } from "@/lib/env";
import { observability } from "@/lib/observability";
import {
  portalSession,
  SHOWCALLER_GRANT_COOKIE,
  showcallerSignInPath,
  visitorAddress,
} from "@/lib/showcaller/public";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("compliance.showcallerPortal");
  return {
    title: t("title"),
    robots: { index: false, follow: false },
    referrer: "same-origin",
  };
}

/**
 * A showcaller link's portal (B3, G-80, ADR 0142): one running order, called and edited live by a signed-in person on
 * the project (owner ruling of 2026-11-06). Signed out goes to sign-in, and someone off the project gets the refusal
 * before any code form; a showcaller with no account comes through the invitation and onboarding path first. The
 * device grant cookie still carries every read and write; without one the access code form shows. Reads and writes go
 * through the person's own client (6244), and the portal rereads on every channel ping, so a change made in Atlas
 * shows within a second or two. Refusals have their own copy: a link that is gone says so, a rate refusal offers a
 * retry, and the console is never blank.
 */
export default async function ShowcallerPortalPage({
  params,
  searchParams,
}: PageProps<"/share/showcaller/[token]">) {
  const { token } = await params;
  if (!SHOWCALLER_TOKEN.test(token)) notFound();
  const session = await portalSession();
  if (!session.signedIn) redirect(showcallerSignInPath(token) as Route);
  const reasonParam = (await searchParams)["reason"];
  const asked: ShowcallerRefusal | null =
    typeof reasonParam === "string" ? parseShowcallerRefusal(reasonParam) : null;
  const t = await getTranslations("compliance.showcallerPortal");
  const grant = (await cookies()).get(SHOWCALLER_GRANT_COOKIE)?.value ?? null;
  const path = showcallerPath(token);
  const form = (reason: ShowcallerRefusal | null) => (
    <div className="flex min-h-dvh flex-col justify-center gap-16 p-24">
      <h1 className="m-0 text-center text-heading-24 font-semibold">{t("title")}</h1>
      <ShowcallerCodeForm path={path} reason={reason} />
    </div>
  );

  const clientAddress = visitorAddress(await headers());
  const refusalPage = (reason: ShowcallerRefusal) => (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-12 p-24 text-center">
      <h1 className="m-0 text-heading-24 font-semibold">
        {reason === "showcaller_link_rate_limited" ? t("busy") : t("notAvailable")}
      </h1>
      <p className="m-0 max-w-layout-reading text-text-16 text-text-secondary">
        {t(`refusals.${reason}`)}
      </p>
      {reason === "showcaller_link_rate_limited" ? (
        <a href={path} className="text-text-14 text-accent-text underline">
          {t("retry")}
        </a>
      ) : null}
    </div>
  );

  if (grant === null || asked !== null) {
    // Opening with no code changes nothing and answers what stands before the form: the person, the link's state.
    const check = await openShowcallerLink(session.db, { token, accessCode: null, clientAddress });
    if (!check.ok) {
      observability.logger.error("showcaller portal check failed", {
        route: "/share/showcaller/[token]",
        error: check.error,
      });
      throw new Error("showcaller portal check failed");
    }
    const reason = check.data.refused ? check.data.reason : "showcaller_link_access_code_required";
    if (reason === "showcaller_link_sign_in") redirect(showcallerSignInPath(token) as Route);
    return showcallerAsksForCode(reason) ? form(asked) : refusalPage(reason);
  }

  const read = await readShowcallerRun(session.db, { token, grant, clientAddress });
  if (!read.ok) {
    observability.logger.error("showcaller portal read failed", {
      route: "/share/showcaller/[token]",
      error: read.error,
    });
    throw new Error("showcaller portal read failed");
  }
  if (read.data.refused) {
    const reason = read.data.reason;
    if (reason === "showcaller_link_sign_in") redirect(showcallerSignInPath(token) as Route);
    return showcallerAsksForCode(reason) ? form(reason) : refusalPage(reason);
  }

  const config = env();
  return (
    <>
      <ShowcallerPortal token={token} run={read.data} />
      <PublicLive
        url={config.SUPABASE_URL}
        anonKey={config.SUPABASE_ANON_KEY}
        channel={read.data.channel}
      />
    </>
  );
}
