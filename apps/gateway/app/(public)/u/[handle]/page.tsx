import { getPublicPersonProfile, listRatingsAbout } from "@xos/data/gateway";
import type { Metadata, Route } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { getLocale } from "next-intl/server";
import { cache } from "react";
import { PublicPersonProfile } from "@/components/profile/public-profile";
import { ButtonLink } from "@/components/ui";
import { getGatewayContext } from "@/lib/shell/context";
import { getTranslate } from "@/lib/shell/translate";
import { createServerSupabase } from "@/lib/supabase/server";

const load = cache(async (handle: string) => {
  const result = await getPublicPersonProfile(await createServerSupabase(), handle);
  if (!result.ok) throw new Error(`Profile ${handle} did not load: ${result.error.kind}`);
  return result.data;
});

export async function generateMetadata({ params }: PageProps<"/u/[handle]">): Promise<Metadata> {
  const { handle } = await params;
  const data = await load(handle);
  if (!data) return { robots: { index: false, follow: false } };
  const name = data.profile.preferred_name ?? data.profile.full_name ?? data.profile.handle;
  return {
    title: name,
    description: data.profile.headline ?? undefined,
    robots: { index: data.profile.indexable, follow: data.profile.indexable },
    openGraph: { title: name, description: data.profile.headline ?? undefined, type: "profile" },
  };
}

/**
 * A person's public profile at /u/{handle} (Section 4.8.2): what the viewer may see under the
 * person's visibility (Public, Network or Private) and section settings. A hidden or unknown
 * handle answers 404; an old handle redirects to the current one for 90 days. Indexing is off
 * unless the person turned it on (Section 4.8.3).
 */
export default async function PersonProfilePage({ params }: PageProps<"/u/[handle]">) {
  const { handle } = await params;
  const data = await load(handle);
  if (!data) notFound();
  if (data.profile.redirected) permanentRedirect(`/u/${data.profile.handle}` as Route);
  const [t, locale, ctx] = await Promise.all([getTranslate(), getLocale(), getGatewayContext()]);
  const ratings =
    ctx && data.profile.viewer_is_owner
      ? await listRatingsAbout(ctx.db, { personId: ctx.personId })
      : null;
  return (
    <>
      {data.profile.viewer_is_owner ? (
        <div className="flex flex-wrap items-center justify-between gap-8 rounded-control bg-bg-surface p-12 text-text-13">
          <span>
            {t("gateway.profile.public.ownerNote", {
              visibility: t(
                `gateway.enums.profileVisibility.${data.profile.visibility.toLowerCase()}`,
              ),
            })}
          </span>
          <ButtonLink href="/settings/profile-privacy" size="sm">
            {t("gateway.profile.public.ownerAction")}
          </ButtonLink>
        </div>
      ) : null}
      <PublicPersonProfile
        data={data}
        ratings={ratings?.ok ? ratings.data : []}
        locale={locale}
        t={t}
      />
    </>
  );
}
