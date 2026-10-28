import {
  LIVE_VIEW_TOKEN,
  parseRefusal,
  readLiveView,
  type LiveLinkRefusal,
} from "@xos/data/live-links";
import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { InlineAlert } from "@/components/ui";
import { LiveCodeForm } from "@/components/live/live-code-form";
import { PublicLive } from "@/components/live/public-live";
import { PublicLiveRows } from "@/components/live/public-live-view";
import { env } from "@/lib/env";
import { observability } from "@/lib/observability";
import { GRANT_COOKIE, publicDb, visitorAddress } from "@/lib/live-links/public";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("compliance.liveLinks");
  // The address carries the link's token: no search engine indexes it and no other site receives it as a
  // referrer. Same-origin, not no-referrer, so the code form's POST keeps its Origin for the CSRF check.
  return {
    title: t("viewTitle"),
    robots: { index: false, follow: false },
    referrer: "same-origin",
  };
}

/**
 * A live view link (P1, ADR 0130): one saved view of one project, for someone with no account. The
 * device grant cookie carries the read; without one, or when the link asks again, the access code
 * form shows. The page reads through a session-less client as the link's creator (2781), shows only
 * allowlisted columns and never the link's note, and rereads on every channel ping (PublicLive).
 */
export default async function LiveViewPage({
  params,
  searchParams,
}: PageProps<"/share/view/[token]">) {
  const { token } = await params;
  if (!LIVE_VIEW_TOKEN.test(token)) notFound();
  const reasonParam = (await searchParams)["reason"];
  const asked: LiveLinkRefusal | null =
    typeof reasonParam === "string" ? parseRefusal(reasonParam) : null;
  const t = await getTranslations("compliance.liveLinks");
  const grant = (await cookies()).get(GRANT_COOKIE)?.value ?? null;
  const action = `/share/view/${token}/open`;

  if (grant === null || asked !== null) {
    return (
      <>
        <h1 className="m-0 text-heading-24 font-semibold">{t("viewTitle")}</h1>
        <LiveCodeForm action={action} intro={t("intro")} reason={asked} />
      </>
    );
  }

  const read = await readLiveView(publicDb(), {
    token,
    grant,
    clientAddress: visitorAddress(await headers()),
  });
  if (!read.ok) {
    observability.logger.error("live view read failed", {
      route: "/share/view/[token]",
      error: read.error,
    });
    throw new Error("live view read failed");
  }
  if (read.data.refused) {
    const reason = read.data.reason;
    const code =
      reason === "live_link_grant" ||
      reason === "live_link_access_code_required" ||
      reason === "live_link_access_code";
    return (
      <>
        <h1 className="m-0 text-heading-24 font-semibold">{t("viewTitle")}</h1>
        {code ? (
          <LiveCodeForm action={action} intro={t("intro")} reason={reason} />
        ) : (
          <InlineAlert tone="danger">{t(`refusals.${reason}`)}</InlineAlert>
        )}
      </>
    );
  }

  const view = read.data;
  const format = await getFormatter();
  const config = env();
  return (
    <>
      <header
        className="flex flex-col gap-4 border-t-4 pt-12"
        style={view.meta.brandAccentHex ? { borderColor: view.meta.brandAccentHex } : undefined}
      >
        <p className="m-0 text-text-13 text-text-secondary">
          {view.meta.brandName} · {view.meta.projectName}
        </p>
        <h1 className="m-0 text-heading-24 font-semibold">{view.meta.viewName}</h1>
        <p className="m-0 text-text-12 text-text-secondary">
          <span aria-live="polite">{t("updatesLive")}</span>
          {" · "}
          {t("expires", {
            date: format.dateTime(new Date(view.meta.expiresAt), {
              dateStyle: "medium",
              timeZone: view.meta.timeZone,
            }),
          })}
        </p>
      </header>
      <PublicLiveRows view={view} />
      {view.truncated ? (
        <p className="m-0 text-text-12 text-text-secondary">
          {t("truncated", {
            count: view.data.rows.length,
          })}
        </p>
      ) : null}
      {view.meta.suppressPoweredBy ? null : (
        <footer className="text-text-12 text-text-secondary">{t("poweredBy")}</footer>
      )}
      <PublicLive
        url={config.SUPABASE_URL}
        anonKey={config.SUPABASE_ANON_KEY}
        channel={view.channel}
      />
    </>
  );
}
