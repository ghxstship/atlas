import {
  displayCue,
  readShowcallerRun,
  SHOWCALLER_TOKEN,
  showcallerAsksForCode,
  showcallerPath,
} from "@xos/data/showcaller-links";
import type { Metadata, Route } from "next";
import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ShowcallerClock } from "@/components/show/showcaller-clock";
import { observability } from "@/lib/observability";
import { publicDb, SHOWCALLER_GRANT_COOKIE, visitorAddress } from "@/lib/showcaller/public";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("compliance.showcallerPortal");
  return {
    title: t("clockTitle"),
    robots: { index: false, follow: false },
    referrer: "same-origin",
  };
}

/**
 * A showcaller portal's pop-out clock (B3, ADR 0142): P1's display screen (room clock or presenter timer, red with
 * Over by on an overrun) from the portal's own read. The portal hands it every read it makes through a
 * BroadcastChannel; only when no portal is open does it read on its own, every 15 seconds.
 */
export default async function ShowcallerClockPage({
  params,
}: PageProps<"/share/showcaller/[token]/clock">) {
  const { token } = await params;
  if (!SHOWCALLER_TOKEN.test(token)) notFound();
  const grant = (await cookies()).get(SHOWCALLER_GRANT_COOKIE)?.value ?? null;
  if (grant === null) redirect(showcallerPath(token) as Route);
  const read = await readShowcallerRun(publicDb(), {
    token,
    grant,
    clientAddress: visitorAddress(await headers()),
  });
  if (!read.ok) {
    observability.logger.error("showcaller clock read failed", {
      route: "/share/showcaller/[token]/clock",
      error: read.error,
    });
    throw new Error("showcaller clock read failed");
  }
  if (read.data.refused) {
    if (showcallerAsksForCode(read.data.reason)) redirect(showcallerPath(token) as Route);
    const t = await getTranslations("compliance.showcallerPortal");
    return (
      <div
        className="flex min-h-dvh flex-col items-center justify-center gap-12 p-24 text-center"
        data-theme="dark"
      >
        <h1 className="m-0 text-heading-24 font-semibold">{t("notAvailable")}</h1>
        <p className="m-0 max-w-layout-reading text-text-16 text-text-secondary">
          {t(`refusals.${read.data.reason}`)}
        </p>
      </div>
    );
  }
  const run = read.data;
  return (
    <div data-theme="dark" className="min-h-dvh bg-bg-canvas text-text-primary">
      <ShowcallerClock
        token={token}
        initial={{
          cues: run.cues.map(displayCue),
          name: run.meta.name,
          projectName: run.meta.projectName,
          brandName: run.meta.brandName,
          timeZone: run.meta.timeZone,
          serverNow: run.serverNow,
        }}
      />
    </div>
  );
}
