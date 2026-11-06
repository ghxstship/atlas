import { PACK_UNSUBSCRIBE_TOKEN } from "@xos/data/stakeholder-packs";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Button, InlineAlert } from "@/components/ui";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("compliance.stakeholderPack");
  return {
    title: t("unsubscribe.title"),
    robots: { index: false, follow: false },
    referrer: "same-origin",
  };
}

/**
 * Stop a stakeholder pack's emails (B2, ADR 0141): the email's visible link lands here and one button confirms,
 * because mail scanners follow links and opening never acts. The button posts natively to /confirm, whose browser POST
 * has an Origin, so the proxy passes it. One-click from a mail client goes through the email-unsubscribe function.
 */
export default async function PackUnsubscribePage({
  params,
  searchParams,
}: PageProps<"/share/pack/unsubscribe/[token]">) {
  const { token } = await params;
  if (!PACK_UNSUBSCRIBE_TOKEN.test(token)) notFound();
  const query = await searchParams;
  const t = await getTranslations("compliance.stakeholderPack.unsubscribe");
  const done = query["done"] === "1";
  const failed = typeof query["reason"] === "string";
  return (
    <>
      <h1 className="m-0 text-heading-24 font-semibold">{t("title")}</h1>
      {done ? (
        <InlineAlert tone="success">{t("done")}</InlineAlert>
      ) : (
        <>
          <p className="m-0 text-text-14 text-text-secondary">{t("intro")}</p>
          {failed ? <InlineAlert tone="danger">{t("failed")}</InlineAlert> : null}
          <form method="post" action={`/share/pack/unsubscribe/${token}/confirm`}>
            <Button type="submit" variant="primary">
              {t("confirm")}
            </Button>
          </form>
        </>
      )}
    </>
  );
}
