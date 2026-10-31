import {
  parseShowcallerRefusal,
  readShowcallerRun,
  SHOWCALLER_TOKEN,
  showcallerAsksForCode,
  showcallerPath,
  type ShowcallerRefusal,
} from "@xos/data/showcaller-links";
import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PublicLive } from "@/components/live/public-live";
import { ShowcallerCodeForm } from "@/components/show/showcaller-code-form";
import { ShowcallerPortal } from "@/components/show/showcaller-portal";
import { env } from "@/lib/env";
import { observability } from "@/lib/observability";
import { publicDb, SHOWCALLER_GRANT_COOKIE, visitorAddress } from "@/lib/showcaller/public";

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
 * A showcaller link's portal (B3, G-80, ADR 0142): one running order, called and edited live by someone with no
 * account. The device grant cookie carries every read and write; without one the access code form shows. Reads
 * and writes go through the session-less client (2924), and the portal rereads on every channel ping, so a change
 * made in Atlas shows within a second or two. Refusals have their own copy: a link that is gone says so, a rate
 * refusal offers a retry, and the console is never blank.
 */
export default async function ShowcallerPortalPage({
  params,
  searchParams,
}: PageProps<"/share/showcaller/[token]">) {
  const { token } = await params;
  if (!SHOWCALLER_TOKEN.test(token)) notFound();
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

  if (grant === null || asked !== null) return form(asked);

  const read = await readShowcallerRun(publicDb(), {
    token,
    grant,
    clientAddress: visitorAddress(await headers()),
  });
  if (!read.ok) {
    observability.logger.error("showcaller portal read failed", {
      route: "/share/showcaller/[token]",
      error: read.error,
    });
    throw new Error("showcaller portal read failed");
  }
  if (read.data.refused) {
    const reason = read.data.reason;
    if (showcallerAsksForCode(reason)) return form(reason);
    return (
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
