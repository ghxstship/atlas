import {
  DISPLAY_TOKEN,
  parseRefusal,
  readDisplay,
  type LiveLinkRefusal,
} from "@xos/data/live-links";
import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { LiveCodeForm } from "@/components/live/live-code-form";
import { PublicLive } from "@/components/live/public-live";
import { DisplayScreen } from "@/components/show/display-screen";
import { env } from "@/lib/env";
import { observability } from "@/lib/observability";
import { GRANT_COOKIE, publicDb, visitorAddress } from "@/lib/live-links/public";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("compliance.liveLinks");
  return {
    title: t("screenTitle"),
    robots: { index: false, follow: false },
    referrer: "same-origin",
  };
}

/**
 * A display screen link (P1, ADR 0130): a running order as a room clock, presenter timer or
 * backstage screen, on any TV or laptop with no sign-in. The device grant cookie carries the read;
 * without one the access code form shows. The cues come through a session-less client (2781), never
 * with who called them, and the page rereads on every channel ping, so a called cue shows within
 * seconds.
 */
export default async function DisplayScreenPage({
  params,
  searchParams,
}: PageProps<"/share/screen/[token]">) {
  const { token } = await params;
  if (!DISPLAY_TOKEN.test(token)) notFound();
  const reasonParam = (await searchParams)["reason"];
  const asked: LiveLinkRefusal | null =
    typeof reasonParam === "string" ? parseRefusal(reasonParam) : null;
  const t = await getTranslations("compliance.liveLinks");
  const grant = (await cookies()).get(GRANT_COOKIE)?.value ?? null;
  const path = `/share/screen/${token}`;
  const form = (reason: LiveLinkRefusal | null) => (
    <div className="flex min-h-dvh flex-col justify-center gap-16 p-24">
      <h1 className="m-0 text-center text-heading-24 font-semibold">{t("screenTitle")}</h1>
      <LiveCodeForm path={path} intro={t("screenIntro")} reason={reason} tone="dark" />
    </div>
  );

  if (grant === null || asked !== null) return form(asked);

  const read = await readDisplay(publicDb(), {
    token,
    grant,
    clientAddress: visitorAddress(await headers()),
  });
  if (!read.ok) {
    observability.logger.error("display screen read failed", {
      route: "/share/screen/[token]",
      error: read.error,
    });
    throw new Error("display screen read failed");
  }
  if (read.data.refused) {
    const reason = read.data.reason;
    if (
      reason === "live_link_grant" ||
      reason === "live_link_access_code_required" ||
      reason === "live_link_access_code"
    ) {
      return form(reason);
    }
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-12 p-24 text-center">
        <h1 className="m-0 text-heading-24 font-semibold">{t("notAvailable")}</h1>
        <p className="m-0 max-w-layout-reading text-text-16 text-text-secondary">
          {t(`refusals.${reason}`)}
        </p>
      </div>
    );
  }

  const screen = read.data;
  const config = env();
  return (
    <>
      <DisplayScreen
        cues={screen.cues}
        name={screen.meta.name}
        projectName={screen.meta.projectName}
        brandName={screen.meta.brandName}
        timeZone={screen.meta.timeZone}
        defaultMode={screen.meta.defaultMode}
        serverNow={screen.serverNow}
      />
      <PublicLive
        url={config.SUPABASE_URL}
        anonKey={config.SUPABASE_ANON_KEY}
        channel={screen.channel}
      />
    </>
  );
}
