import { WifiOff } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Button } from "@/components/ui";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("firstRun.offline");
  return { title: t("title"), robots: { index: false } };
}

/**
 * The offline page (Section 4.10, A65-023, ADR 0052). The service worker keeps it at install and shows it for a page
 * it has not saved when the device has no connection. It holds nobody's data and works without JavaScript: Try Again
 * reloads the address the person asked for, and Go Home opens the entry route.
 */
export default async function OfflinePage() {
  const t = await getTranslations("firstRun.offline");
  return (
    <div className="flex flex-col items-center gap-16 text-center">
      <WifiOff aria-hidden="true" className="size-32 text-text-tertiary" />
      <h1 className="text-heading-20 font-semibold">{t("title")}</h1>
      <p className="m-0 text-text-14 text-text-secondary">{t("body")}</p>
      <form method="get" className="w-full">
        <Button type="submit" variant="primary" className="w-full">
          {t("retry")}
        </Button>
      </form>
      <Link href="/" className="text-text-14 font-medium text-accent-text underline">
        {t("home")}
      </Link>
    </div>
  );
}
