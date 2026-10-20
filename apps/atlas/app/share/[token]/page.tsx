import { SHARE_LINK_REFUSALS, SHARE_TOKEN } from "@xos/data/share-links";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Button, InlineAlert, Input } from "@xos/ui";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("compliance.open");
  // The address carries the link's token: no search engine indexes it and no referrer repeats it.
  return { title: t("title"), robots: { index: false, follow: false }, referrer: "no-referrer" };
}

/**
 * A share link (Section 8.6, finding A65-016): the visitor enters the access code when the link has
 * one, and the form POSTs to the file route, which opens the link and sends the file. The code
 * travels only in the form body, never in the address. Refusals come back as `?reason=`.
 */
export default async function SharePage({ params, searchParams }: PageProps<"/share/[token]">) {
  const { token } = await params;
  if (!SHARE_TOKEN.test(token)) notFound();
  const reasonParam = (await searchParams)["reason"];
  const reason = SHARE_LINK_REFUSALS.find((r) => r === reasonParam) ?? null;
  const t = await getTranslations("compliance.open");
  const askCode =
    reason === "share_link_access_code_required" || reason === "share_link_access_code";
  return (
    <div className="flex flex-col gap-16">
      <h1 className="text-heading-20 font-semibold">{t("title")}</h1>
      <p className="m-0 text-text-14 text-text-secondary">{t("intro")}</p>
      {reason ? (
        <InlineAlert tone={askCode ? "warning" : "danger"}>{t(`refusals.${reason}`)}</InlineAlert>
      ) : null}
      <form method="post" action={`/share/${token}/file`} className="flex flex-col gap-12">
        <Input
          width="100%"
          id="share-access-code"
          name="accessCode"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          label={t("accessCode")}
          help={t("accessCodeHelp")}
          autoFocus={askCode}
        />
        <Button type="submit" variant="primary" className="w-full">
          {t("submit")}
        </Button>
      </form>
      <p className="m-0 text-text-12 text-text-secondary">{t("watermark")}</p>
    </div>
  );
}
