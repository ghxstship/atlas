import { parseDisplay, parseLiveView } from "@xos/data/live-links";
import { PACK_LINK_TOKEN, parsePackGrants, readPackItem } from "@xos/data/stakeholder-packs";
import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PublicLive } from "@/components/live/public-live";
import { PublicLiveRows } from "@/components/live/public-live-view";
import { DisplayScreen } from "@/components/show/display-screen";
import { InlineAlert } from "@/components/ui";
import { env } from "@/lib/env";
import { publicDb, visitorAddress } from "@/lib/live-links/public";
import { observability } from "@/lib/observability";
import { PACK_GRANT_COOKIE } from "@/lib/stakeholder-packs/public";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("compliance.stakeholderPack");
  return { title: t("title"), robots: { index: false, follow: false }, referrer: "same-origin" };
}

/**
 * One live item of a stakeholder pack (B2, ADR 0141): the same rows P1's link shows, read as the link's creator,
 * on P1's components, joining its xlink channel. No P1 grant is needed: the pack's grant carries the read.
 */
export default async function StakeholderPackItemPage({
  params,
}: PageProps<"/share/pack/[token]/items/[itemId]">) {
  const { token, itemId } = await params;
  if (!PACK_LINK_TOKEN.test(token) || !/^[0-9a-f-]{36}$/.test(itemId)) notFound();
  const t = await getTranslations("compliance.stakeholderPack");
  const liveT = await getTranslations("compliance.liveLinks");
  const grants = parsePackGrants((await cookies()).get(PACK_GRANT_COOKIE)?.value);
  const read = await readPackItem(publicDb(), {
    token,
    grants,
    itemId,
    clientAddress: visitorAddress(await headers()),
  });
  if (!read.ok) {
    observability.logger.error("stakeholder pack item read failed", {
      route: "/share/pack/[token]/items/[itemId]",
      error: read.error,
    });
    throw new Error("stakeholder pack item read failed");
  }
  const back = (
    <a className="text-label-13 text-accent-text underline" href={`/share/pack/${token}`}>
      {t("back")}
    </a>
  );
  // Back to the pack, which reads again with whatever grant the cookie now holds and asks for the code only if it must.
  if (read.data.refused && read.data.reason === "pack_grant") {
    redirect(`/share/pack/${token}?reason=pack_grant`);
  }
  if (read.data.refused) {
    return (
      <>
        {back}
        <InlineAlert tone="danger">{t(`refusals.${read.data.reason}`)}</InlineAlert>
      </>
    );
  }
  const config = env();
  const payload = read.data.payload;
  const item = (payload["item"] ?? {}) as { title?: string };
  if ("cues" in payload) {
    const screen = parseDisplay(payload);
    return (
      <>
        {back}
        <DisplayScreen
          cues={screen.cues}
          name={item.title ?? screen.meta.name}
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
  const view = parseLiveView(payload);
  if (view.refused) {
    return (
      <>
        {back}
        <InlineAlert tone="danger">{t("refusals.pack_item_unavailable")}</InlineAlert>
      </>
    );
  }
  return (
    <>
      {back}
      <header className="flex flex-col gap-4">
        <h1 className="m-0 text-heading-24 font-semibold">{item.title ?? view.meta.viewName}</h1>
        <p className="m-0 text-text-12 text-text-secondary" aria-live="polite">
          {liveT("updatesLive")}
        </p>
      </header>
      <PublicLiveRows view={view} />
      <PublicLive
        url={config.SUPABASE_URL}
        anonKey={config.SUPABASE_ANON_KEY}
        channel={view.channel}
      />
    </>
  );
}
