import { getMyOrganization } from "@xos/data";
import { ShieldAlert } from "lucide-react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { z } from "zod";
import { EmergencyAccessForm } from "@/components/auth/emergency-access-form";
import { ButtonLink } from "@/components/ui";
import { getViewer } from "@/lib/shell/context";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("shell.auth.networkRestricted");
  return { title: t("title") };
}

/**
 * Where the proxy sends a member whose network an org's IP allow-list refuses (Section 9,
 * migration 1201), instead of a 404. An Owner may take one hour of emergency access here
 * (Section 8.4, migration 1203); everyone else is told to connect from an allowed network.
 */
export default async function NetworkRestrictedPage({
  searchParams,
}: PageProps<"/auth/network-restricted">) {
  const viewer = await getViewer();
  if (!viewer?.person) redirect("/auth/sign-in");
  const slug = z
    .string()
    .regex(/^[a-z0-9-]{1,80}$/)
    .safeParse((await searchParams)["org"]);
  const org = slug.success ? await getMyOrganization(viewer.db, viewer.person.id, slug.data) : null;
  const name = org?.ok ? org.data.name : null;
  const owner = org?.ok && org.data.bestBand === 1;
  const t = await getTranslations("shell.auth.networkRestricted");
  return (
    <div className="flex flex-col items-center gap-16 text-center">
      <ShieldAlert aria-hidden="true" className="size-32 text-text-tertiary" />
      <h1 className="text-heading-20 font-semibold">{t("title")}</h1>
      <p className="text-text-14 text-text-secondary">
        {name ? t("body", { org: name }) : t("bodyNoOrg")}
      </p>
      {owner && slug.success ? (
        <section aria-labelledby="emergency-heading" className="flex w-full flex-col gap-8">
          <h2 id="emergency-heading" className="m-0 text-heading-16 font-semibold">
            {t("ownerTitle")}
          </h2>
          <p className="m-0 text-text-13 text-text-secondary">{t("ownerBody")}</p>
          <EmergencyAccessForm org={slug.data} />
        </section>
      ) : null}
      <ButtonLink href="/">{t("back")}</ButtonLink>
    </div>
  );
}
