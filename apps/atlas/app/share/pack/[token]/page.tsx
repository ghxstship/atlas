import {
  PACK_LINK_TOKEN,
  packAsksForCode,
  parsePackGrants,
  parsePackRefusal,
  readStakeholderPack,
  type PackRefusal,
} from "@xos/data/stakeholder-packs";
import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { PackOpened } from "@/components/share/pack-opened";
import { PackCodeForm, PackHeader, PackItemRow } from "@/components/share/stakeholder-pack";
import { InlineAlert } from "@/components/ui";
import { publicDb, visitorAddress } from "@/lib/live-links/public";
import { observability } from "@/lib/observability";
import { PACK_GRANT_COOKIE } from "@/lib/stakeholder-packs/public";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("compliance.stakeholderPack");
  // The address carries the token: no search engine indexes it and no other site receives it as a referrer.
  // Same-origin, not no-referrer, so the code form's POST keeps its Origin for the CSRF check.
  return { title: t("title"), robots: { index: false, follow: false }, referrer: "same-origin" };
}

/**
 * A stakeholder pack (B2, ADR 0141): what a project shared with one outside recipient. The device's grant
 * cookie carries the read; without a matching one, the code form shows. An emailed link on a device that already holds
 * a grant opens with no code: PackOpened posts once, which logs the open and swaps the grant for a fresh one, since a
 * read may not act. Never the pack's note, other recipients or emails.
 */
export default async function StakeholderPackPage({
  params,
  searchParams,
}: PageProps<"/share/pack/[token]">) {
  const { token } = await params;
  if (!PACK_LINK_TOKEN.test(token)) notFound();
  const query = await searchParams;
  const asked: PackRefusal | null =
    typeof query["reason"] === "string" ? parsePackRefusal(query["reason"]) : null;
  const t = await getTranslations("compliance.stakeholderPack");
  const grants = parsePackGrants((await cookies()).get(PACK_GRANT_COOKIE)?.value);
  const heading = <h1 className="m-0 text-heading-24 font-semibold">{t("title")}</h1>;

  if (grants.length === 0 || (asked !== null && packAsksForCode(asked))) {
    return (
      <>
        {heading}
        <PackCodeForm token={token} reason={asked} hasGrants={false} />
      </>
    );
  }

  const read = await readStakeholderPack(publicDb(), {
    token,
    grants,
    clientAddress: visitorAddress(await headers()),
  });
  if (!read.ok) {
    observability.logger.error("stakeholder pack read failed", {
      route: "/share/pack/[token]",
      error: read.error,
    });
    throw new Error("stakeholder pack read failed");
  }
  if (read.data.refused) {
    const reason = read.data.reason;
    return (
      <>
        {heading}
        {packAsksForCode(reason) ? (
          <PackCodeForm token={token} reason={reason} hasGrants />
        ) : (
          <InlineAlert tone="danger">{t(`refusals.${reason}`)}</InlineAlert>
        )}
      </>
    );
  }

  const pack = read.data;
  const format = await getFormatter();
  return (
    <>
      <PackHeader meta={pack.meta} recipientName={pack.recipientName} />
      {query["opened"] === "1" ? null : <PackOpened token={token} />}
      {asked ? <InlineAlert tone="warning">{t(`refusals.${asked}`)}</InlineAlert> : null}
      {pack.items.length === 0 ? (
        <p className="m-0 text-text-14 text-text-secondary">{t("noItems")}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
          {pack.items.map((item) => (
            <PackItemRow
              key={item.id}
              token={token}
              item={item}
              signedOn={
                item.signedAt
                  ? format.dateTime(new Date(item.signedAt), {
                      dateStyle: "medium",
                      timeStyle: "short",
                      timeZone: pack.meta.timeZone,
                    })
                  : null
              }
            />
          ))}
        </ul>
      )}
      <p className="m-0 text-text-12 text-text-secondary">
        {t("expires", {
          date: format.dateTime(new Date(pack.meta.expiresAt), {
            dateStyle: "medium",
            timeZone: pack.meta.timeZone,
          }),
        })}
      </p>
      {pack.meta.suppressPoweredBy ? null : (
        <footer className="text-text-12 text-text-secondary">{t("poweredBy")}</footer>
      )}
    </>
  );
}
